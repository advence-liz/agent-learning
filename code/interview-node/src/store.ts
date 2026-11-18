import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentState, Event, Run, Status, Trace } from './types.ts';
import { fail } from './types.ts';
import { createState } from './agent.ts';

export const GLOBAL_QUEUE_LIMIT = 128;

type Row = { id: string; tenant: string; request_key: string; prompt: string; publish: number; status: Status; state: string; owner: string | null; lease_until: number; deadline: number; error: string | null };
function run(row: Row): Run {
  return { id: row.id, tenant: row.tenant, requestKey: row.request_key, prompt: row.prompt, publish: Boolean(row.publish), status: row.status, state: JSON.parse(row.state), owner: row.owner, leaseUntil: row.lease_until, deadline: row.deadline, error: row.error };
}
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, request_key TEXT NOT NULL, prompt TEXT NOT NULL, publish INTEGER NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL, error TEXT, UNIQUE(tenant, request_key));
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, seq));
      CREATE TABLE IF NOT EXISTS reports (run_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, content TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queue ON runs(status, lease_until);`);
  }
  private tx<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(id: string, type: string, data: unknown): void {
    this.db.prepare('INSERT INTO events SELECT ?, COALESCE(MAX(seq),0)+1, ?, ? FROM events WHERE run_id=?').run(id, type, JSON.stringify(data), id);
  }
  get(id: string, tenant: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=? AND tenant=?').get(id, tenant) as Row | undefined;
    if (!row) fail('NOT_FOUND'); return run(row);
  }
  list(tenant: string): Run[] { return (this.db.prepare('SELECT * FROM runs WHERE tenant=? ORDER BY rowid DESC LIMIT 20').all(tenant) as Row[]).map(run); }
  create(tenant: string, key: string, prompt: string, publish: boolean, queueLimit = 32): Run {
    if (!key || key.length > 100) fail('INVALID_KEY');
    const state = createState(prompt);
    return this.tx(() => {
      const prior = this.db.prepare('SELECT * FROM runs WHERE tenant=? AND request_key=?').get(tenant, key) as Row | undefined;
      if (prior) {
        if (prior.prompt !== prompt || Boolean(prior.publish) !== publish) fail('IDEMPOTENCY_CONFLICT');
        return run(prior);
      }
      const tenantCount = Number((this.db.prepare("SELECT COUNT(*) n FROM runs WHERE tenant=? AND status IN ('queued','running')").get(tenant) as { n: number }).n);
      const globalCount = Number((this.db.prepare("SELECT COUNT(*) n FROM runs WHERE status IN ('queued','running')").get() as { n: number }).n);
      if (tenantCount >= queueLimit || globalCount >= GLOBAL_QUEUE_LIMIT) fail('QUEUE_FULL');
      const id = randomUUID();
      this.db.prepare('INSERT INTO runs(id,tenant,request_key,prompt,publish,status,state,deadline) VALUES(?,?,?,?,?,?,?,?)').run(id, tenant, key, prompt, Number(publish), 'queued', JSON.stringify(state), Date.now() + 120_000);
      this.event(id, 'run.created', { status: 'queued' });
      return this.get(id, tenant);
    });
  }
  claim(maxConcurrent = 2, leaseMs = 45_000, now = Date.now()): Run | null {
    return this.tx(() => {
      const active = (this.db.prepare("SELECT COUNT(*) n FROM runs WHERE status='running' AND lease_until>?").get(now) as { n: number }).n;
      if (active >= maxConcurrent) return null;
      const row = this.db.prepare("SELECT * FROM runs WHERE status='queued' OR (status='running' AND lease_until<=?) ORDER BY rowid LIMIT 1").get(now) as Row | undefined;
      if (!row) return null;
      const owner = randomUUID();
      this.db.prepare("UPDATE runs SET status='running',owner=?,lease_until=? WHERE id=?").run(owner, now + leaseMs, row.id);
      this.event(row.id, 'run.claimed', { recovered: row.status === 'running' });
      return this.get(row.id, row.tenant);
    });
  }
  heartbeat(id: string, owner: string, now = Date.now()): boolean {
    return this.db.prepare("UPDATE runs SET lease_until=? WHERE id=? AND owner=? AND status='running' AND lease_until>?").run(now + 45_000, id, owner, now).changes === 1;
  }
  commit(id: string, owner: string, state: AgentState, status: Status, traces: Trace[], now = Date.now(), error: string | null = null): boolean {
    return this.tx(() => {
      const updated = this.db.prepare("UPDATE runs SET state=?,status=?,owner=NULL,lease_until=0,error=? WHERE id=? AND owner=? AND status='running' AND lease_until>?").run(JSON.stringify(state), status, error, id, owner, now);
      if (!updated.changes) return false;
      for (const trace of traces) this.event(id, trace.type, trace.data);
      this.event(id, `run.${status}`, { status, ...(error ? { error } : {}) });
      return true;
    });
  }
  cancel(id: string, tenant: string): Run {
    return this.tx(() => {
      const current = this.get(id, tenant);
      if (['completed', 'cancelled', 'failed'].includes(current.status)) return current;
      this.db.prepare("UPDATE runs SET status='cancelled',owner=NULL,lease_until=0 WHERE id=?").run(id);
      this.event(id, 'run.cancelled', { status: 'cancelled' });
      return this.get(id, tenant);
    });
  }
  approve(id: string, tenant: string): Run {
    return this.tx(() => {
      const current = this.get(id, tenant);
      if (current.status === 'completed' && this.report(id, tenant)) return current;
      if (current.status !== 'waiting_approval' || !current.state.answer) fail('INVALID_STATE');
      // 报告保存在同一 SQLite 库，副作用与终态原子提交；不声称可覆盖外部发信/支付。
      this.db.prepare('INSERT INTO reports(run_id,tenant,content) VALUES(?,?,?)').run(id, tenant, JSON.stringify(current.state.answer));
      this.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(id);
      this.event(id, 'report.published', { reportId: id });
      this.event(id, 'run.completed', { status: 'completed' });
      return this.get(id, tenant);
    });
  }
  events(id: string, tenant: string, after = 0): Event[] {
    this.get(id, tenant);
    return (this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 256').all(id, after) as { run_id: string; seq: number; type: string; data: string }[]).map(e => ({ runId: e.run_id, seq: e.seq, type: e.type, data: JSON.parse(e.data) }));
  }
  report(id: string, tenant: string): unknown | null {
    this.get(id, tenant);
    const row = this.db.prepare('SELECT content FROM reports WHERE run_id=? AND tenant=?').get(id, tenant) as { content: string } | undefined;
    return row ? JSON.parse(row.content) : null;
  }
  reportCount(id: string): number { return (this.db.prepare('SELECT COUNT(*) n FROM reports WHERE run_id=?').get(id) as { n: number }).n; }
  close(): void { this.db.close(); }
}
