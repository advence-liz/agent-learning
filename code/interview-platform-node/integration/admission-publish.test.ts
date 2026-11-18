import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate, Repository } from '../src/repository.ts';
import { Worker, markdown } from '../src/worker.ts';

async function fixture() {
  const pool = createPool(); await migrate(pool); const repo = new Repository(pool);
  const tenant = `test-${randomUUID()}`; const ids: string[] = [];
  const make = async (draft = false) => {
    const run = await repo.create(tenant, randomUUID(), '教学队列测试', { text: 'fixture', version: 'fixture' }); ids.push(run.id);
    if (draft) await pool.query("UPDATE agent_runs SET status='waiting_approval',answer=$2 WHERE id=$1", [run.id, JSON.stringify({ kind: 'not_found', answer: '教学资料不足', citations: [] })]);
    return run.id;
  };
  const close = async () => {
    for (const table of ['agent_artifacts', 'agent_events', 'agent_reads']) await pool.query(`DELETE FROM ${table} WHERE run_id=ANY($1::uuid[])`, [ids]);
    await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [ids]); await pool.end();
  };
  return { pool, repo, tenant, ids, make, close };
}
test('三次发布 claim 后崩溃只能 GET 对账，不得发第四次 PUT', async () => {
  const f = await fixture();
  try {
    const id = await f.make(true); await f.repo.approve(id, f.tenant);
    for (let n = 0; n < 3; n++) { const job = await f.repo.claim(id); assert.ok(job); await job.close(); }
    let puts = 0; let gets = 0;
    const content = markdown({ run: await f.repo.get(id, f.tenant) });
    const worker = new Worker(f.repo, { put: async () => { puts++; throw new Error('MUST_NOT_PUT'); }, get: async () => { gets++; return content; } });
    await worker.runOnce({ runId: id });
    assert.equal(puts, 0); assert.equal(gets, 1);
    assert.equal((await f.repo.get(id, f.tenant)).status, 'completed');
    assert.equal((await f.pool.query('SELECT publish_attempts FROM agent_runs WHERE id=$1', [id])).rows[0].publish_attempts, 3);
  } finally { await f.close(); }
});
test('审批入口执行相同租户与全局准入限额，同时保留重复审批幂等', async () => {
  const f = await fixture();
  try {
    const first = await f.make(true); const second = await f.make(true);
    for (let n = 0; n < 32; n++) await f.make();
    await assert.rejects(f.repo.approve(first, f.tenant), /QUEUE_FULL/);
    assert.equal((await f.repo.get(first, f.tenant)).status, 'waiting_approval');
    await f.repo.cancel(f.ids[2], f.tenant);
    await f.repo.approve(first, f.tenant);
    assert.equal((await f.repo.approve(first, f.tenant)).status, 'publishing');
    await assert.rejects(f.repo.approve(second, f.tenant), /QUEUE_FULL/);
    // 清空本测试租户的执行队列，再构造来自其它租户的全局 backlog。
    for (const id of f.ids.slice(2)) await f.repo.cancel(id, f.tenant);
    const count = Number((await f.pool.query("SELECT count(*) n FROM agent_runs WHERE status IN ('queued','running','publishing')")).rows[0].n);
    for (let n = count; n < 128; n++) {
      const id = randomUUID(); f.ids.push(id);
      await f.pool.query("INSERT INTO agent_runs(id,tenant,request_key,prompt,system_prompt,prompt_version) VALUES($1,$2,$3,'fixture','fixture','fixture')", [id, `other-${f.tenant}`, id]);
    }
    await assert.rejects(f.repo.approve(second, f.tenant), /QUEUE_FULL/);
    assert.equal((await f.repo.approve(first, f.tenant)).status, 'publishing');
  } finally { await f.close(); }
});
