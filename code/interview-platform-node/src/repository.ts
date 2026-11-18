import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { AppError, GLOBAL_CONCURRENCY, QUEUE_LIMIT, check, databaseURL } from './domain.ts';
import type { Answer, Run, Status } from './domain.ts';

export function createPool() {
  const pool = new Pool({ connectionString: databaseURL(), max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
  pool.on('error', () => console.error('database idle connection lost; pool will reconnect'));
  return pool;
}
export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(72519, 0)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id UUID PRIMARY KEY, tenant TEXT NOT NULL, request_key TEXT NOT NULL, prompt TEXT NOT NULL,
        system_prompt TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', owner UUID,
        answer JSONB, error TEXT, deadline TIMESTAMPTZ NOT NULL DEFAULT now()+interval '120 seconds',
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, publish_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant,request_key));
      CREATE INDEX IF NOT EXISTS agent_runs_queue ON agent_runs(status,created_at);
      CREATE TABLE IF NOT EXISTS agent_documents (tenant TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS agent_reads (run_id UUID NOT NULL REFERENCES agent_runs(id), document_id TEXT NOT NULL,PRIMARY KEY(run_id,document_id));
      CREATE TABLE IF NOT EXISTS agent_events (seq BIGSERIAL PRIMARY KEY,run_id UUID NOT NULL REFERENCES agent_runs(id),type TEXT NOT NULL,data JSONB NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS agent_events_run ON agent_events(run_id,seq);
      CREATE TABLE IF NOT EXISTS agent_artifacts (run_id UUID PRIMARY KEY REFERENCES agent_runs(id),object_key TEXT NOT NULL,sha256 TEXT NOT NULL);
    `);
    const saver = new PostgresSaver(pool, undefined, { schema: 'agent_graph' });
    // 单独的迁移连接由 LangGraph 管理；本事务锁使并行 migrate 串行。
    await saver.setup();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function assertCapacity(client: PoolClient, tenant: string) {
  const counts = (await client.query<{ total: string; own: string }>("SELECT count(*) total,count(*) FILTER(WHERE tenant=$1) own FROM agent_runs WHERE status IN ('queued','running','publishing')", [tenant])).rows[0];
  check(Number(counts.total) < QUEUE_LIMIT && Number(counts.own) < 32, 'QUEUE_FULL');
}
export class Repository {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async get(id: string, tenant: string): Promise<Run> {
    const row = (await this.pool.query<Run>('SELECT * FROM agent_runs WHERE id=$1 AND tenant=$2', [id, tenant])).rows[0];
    check(row, 'NOT_FOUND'); return row;
  }
  async create(tenant: string, key: string, prompt: string, system: { text: string; version: string }): Promise<Run> {
    check(key.length > 0 && key.length <= 100 && prompt.trim() && prompt.length <= 2000, 'INVALID_INPUT');
    return this.transaction(async client => {
      // 接单短事务串行配额检查；不是把整个 Agent 执行串行。
      await client.query('SELECT pg_advisory_xact_lock(72519,1)');
      const prior = (await client.query<Run>('SELECT * FROM agent_runs WHERE tenant=$1 AND request_key=$2', [tenant, key])).rows[0];
      if (prior) { check(prior.prompt === prompt, 'IDEMPOTENCY_CONFLICT'); return prior; }
      await assertCapacity(client, tenant);
      const row = (await client.query<Run>('INSERT INTO agent_runs(id,tenant,request_key,prompt,system_prompt,prompt_version) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), tenant, key, prompt, system.text, system.version])).rows[0];
      await event(client, row.id, 'run.created'); return row;
    });
  }
  async events(id: string, tenant: string, after = 0) {
    await this.get(id, tenant);
    return (await this.pool.query<{ seq: string; type: string; data: unknown }>('SELECT seq,type,data FROM agent_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT 128', [id, after])).rows.map(e => ({ ...e, seq: Number(e.seq) }));
  }
  async approve(id: string, tenant: string) {
    return this.transaction(async client => {
      const row = (await client.query<Run>('SELECT * FROM agent_runs WHERE id=$1 AND tenant=$2 FOR UPDATE', [id, tenant])).rows[0]; check(row, 'NOT_FOUND');
      if (['publishing', 'completed'].includes(row.status)) return row;
      check(row.status === 'waiting_approval' && row.answer, 'INVALID_STATE');
      await client.query('SELECT pg_advisory_xact_lock(72519,1)');
      await assertCapacity(client, tenant);
      // publishing 本身就是持久 outbox，不在 HTTP 事务里执行远程 S3 操作。
      await client.query("UPDATE agent_runs SET status='publishing',owner=NULL WHERE id=$1", [id]);
      await event(client, id, 'run.approved'); return { ...row, status: 'publishing' as const };
    });
  }
  async cancel(id: string, tenant: string) {
    return this.transaction(async client => {
      const row = (await client.query<Run>('SELECT * FROM agent_runs WHERE id=$1 AND tenant=$2 FOR UPDATE', [id, tenant])).rows[0]; check(row, 'NOT_FOUND');
      if (['completed', 'cancelled', 'failed'].includes(row.status)) return row;
      check(row.status !== 'publishing', 'ALREADY_APPROVED');
      await client.query("UPDATE agent_runs SET status='cancelled',owner=NULL WHERE id=$1", [id]);
      await event(client, id, 'run.cancelled'); return { ...row, status: 'cancelled' as const };
    });
  }
  async claim(runId?: string): Promise<Job | null> {
    const client = await this.pool.connect();
    let held = false;
    try {
      for (let slot = 0; slot < GLOBAL_CONCURRENCY; slot++) {
        if ((await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(72520,$1) ok', [slot])).rows[0].ok) { held = true; break; }
      }
      if (!held) { client.release(); return null; }
      await client.query('BEGIN');
      const candidates = (await client.query<Run>("SELECT * FROM agent_runs WHERE status IN ('queued','running','publishing') AND ($1::uuid IS NULL OR id=$1) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 128", [runId ?? null])).rows;
      for (const row of candidates) {
        const lock = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(72521,hashtext($1)) ok', [row.id])).rows[0].ok;
        if (!lock) continue;
        const owner = randomUUID(); const status = row.status === 'publishing' ? 'publishing' : 'running';
        const reconcileOnly = status === 'publishing' && row.publish_attempts >= 3;
        await client.query("UPDATE agent_runs SET owner=$1,status=$2,publish_attempts=publish_attempts+CASE WHEN $2='publishing' AND NOT $4 THEN 1 ELSE 0 END WHERE id=$3", [owner, status, row.id, reconcileOnly]);
        await event(client, row.id, reconcileOnly ? 'run.reconciling' : 'run.claimed', { recovered: row.status === 'running' });
        await client.query('COMMIT');
        return new Job(client, { ...row, owner, status }, reconcileOnly);
      }
      await client.query('COMMIT'); await client.query('SELECT pg_advisory_unlock_all()'); client.release(); return null;
    } catch (error) {
      try { await client.query('ROLLBACK'); await client.query('SELECT pg_advisory_unlock_all()'); } catch { /* 连接失败时由服务端释放会话锁 */ }
      client.release(true); throw error;
    }
  }
}
export async function event(client: Pick<PoolClient, 'query'>, id: string, type: string, data: unknown = {}) {
  await client.query('INSERT INTO agent_events(run_id,type,data) VALUES($1,$2,$3)', [id, type, JSON.stringify(data)]);
}
export class Job {
  readonly client: PoolClient; readonly run: Run; readonly reconcileOnly: boolean;
  private readonly rawQuery: PoolClient['query'];
  constructor(client: PoolClient, run: Run, reconcileOnly = false) {
    this.client = client; this.run = run; this.reconcileOnly = reconcileOnly; this.rawQuery = client.query;
    // LangGraph 并行写检查点、middleware和取消探测共享同一持锁连接，显式串行查询。
    let tail: Promise<unknown> = Promise.resolve(); const original = this.rawQuery;
    client.query = ((...args: unknown[]) => {
      const task = tail.then(() => Reflect.apply(original, client, args));
      tail = task.then(() => undefined, () => undefined); return task;
    }) as PoolClient['query'];
  }
  checkpointSaver() {
    // 固定版本 PostgresSaver 只使用 query/connect/end。全部检查点写入绑定持锁会话，
    // 断线后 pg Client 不会自动重连，因此旧 worker 不能换连接绕过数据库锁继续写。
    const facade = { query: this.client.query.bind(this.client), connect: async () => ({ query: this.client.query.bind(this.client), release() {} }), end: async () => {} };
    return new PostgresSaver(facade as unknown as Pool, undefined, { schema: 'agent_graph' });
  }
  async alive() {
    const row = (await this.client.query<{ status: Status; owner: string | null }>('SELECT status,owner FROM agent_runs WHERE id=$1', [this.run.id])).rows[0];
    check(row.owner === this.run.owner && row.status === this.run.status, 'OWNERSHIP_LOST');
  }
  async finish(status: Status, answer: Answer | null = null, error: string | null = null) {
    await this.client.query('BEGIN');
    try {
      const result = await this.client.query('UPDATE agent_runs SET status=$1,answer=COALESCE($2,answer),error=$3,owner=NULL WHERE id=$4 AND owner=$5 AND status=$6 RETURNING id', [status, answer ? JSON.stringify(answer) : null, error, this.run.id, this.run.owner, this.run.status]);
      if (result.rowCount) await event(this.client, this.run.id, `run.${status}`, error ? { error } : {});
      await this.client.query('COMMIT'); return Boolean(result.rowCount);
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }
  async close() {
    try { await this.client.query('SELECT pg_advisory_unlock_all()'); this.client.query = this.rawQuery; this.client.release(); }
    catch { this.client.query = this.rawQuery; this.client.release(true); }
  }
}
export function safeError(error: unknown) { return error instanceof AppError ? error.code : 'EXECUTION_FAILED'; }
