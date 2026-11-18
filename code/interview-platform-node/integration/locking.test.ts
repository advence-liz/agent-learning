import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate, Repository } from '../src/repository.ts';
import type { Job } from '../src/repository.ts';

test('多连接全局并发、同任务互斥与断线后 checkpoint 不得换连接继续写', async () => {
  const pool = createPool(); await migrate(pool); const repo = new Repository(pool);
  const ids: string[] = []; const jobs: Job[] = [];
  try {
    for (let i = 0; i < 3; i++) ids.push((await repo.create('alpha', randomUUID(), '锁测试', { text: '本机测试', version: 'fixture' })).id);
    const first = await repo.claim(ids[0]); const second = await repo.claim(ids[1]);
    assert.ok(first && second); jobs.push(first, second);
    assert.equal(await repo.claim(ids[2]), null, '全局最多2个活跃数据库会话');
    await second.finish('cancelled'); await second.close(); jobs.pop();
    assert.equal(await repo.claim(ids[0]), null, '空出并发槽位也不能并发推进同一线程');
    const third = await repo.claim(ids[2]); assert.ok(third); jobs.push(third);
    await third.finish('cancelled'); await third.close(); jobs.pop();
    first.client.on('error', () => {});
    const ended = new Promise<void>(resolve => first.client.once('end', resolve));
    const pid = (await first.client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0].pid;
    await pool.query('SELECT pg_terminate_backend($1)', [pid]); await ended;
    await assert.rejects(first.checkpointSaver().getTuple({ configurable: { thread_id: `alpha:${ids[0]}` } }));
    await first.close(); jobs.pop();
    const takeover = await repo.claim(ids[0]); assert.ok(takeover); jobs.push(takeover);
    assert.notEqual(takeover.run.owner, first.run.owner);
    assert.equal(await first.finish('completed').catch(() => false), false);
    await takeover.finish('cancelled');
  } finally {
    for (const job of jobs) await job.close();
    for (const id of ids) await repo.cancel(id, 'alpha').catch(() => {});
    await pool.end();
  }
});
