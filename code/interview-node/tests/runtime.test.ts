import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Runtime } from '../src/runtime.ts';
import { FakeModel } from '../src/model.ts';
import { KnowledgeTools } from '../src/tools.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'interview-agent-'));
  const db = join(dir, 'state.db');
  const store = new Store(db);
  return { dir, db, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('请求幂等键按租户隔离，同一键不同入参返回冲突，队列有界', () => {
  const f = fixture();
  try {
    const a = f.store.create('alpha', 'key', '退款', true);
    assert.equal(f.store.create('alpha', 'key', '退款', true).id, a.id);
    assert.throws(() => f.store.create('alpha', 'key', '换问题', true), /IDEMPOTENCY_CONFLICT/);
    assert.notEqual(f.store.create('beta', 'key', '退款', true).id, a.id);
    assert.throws(() => f.store.create('alpha', 'key2', '退款', false, 1), /QUEUE_FULL/);
    assert.throws(() => f.store.get(a.id, 'beta'), /NOT_FOUND/);
  } finally { f.close(); }
});

test('每轮事务检查点可供新 Runtime 接续；审批报告与终态在同一事务内幂等提交', async () => {
  const f = fixture();
  try {
    const run = f.store.create('alpha', 'resume', '退款政策是什么？', true);
    await new Runtime(f.store, new FakeModel()).tick();
    assert.equal(f.store.get(run.id, 'alpha').state.steps, 1);
    const restarted = new Runtime(f.store, new FakeModel());
    await restarted.drain();
    assert.equal(f.store.get(run.id, 'alpha').status, 'waiting_approval');
    assert.equal(f.store.report(run.id, 'alpha'), null);
    assert.throws(() => f.store.approve(run.id, 'beta'), /NOT_FOUND/);
    f.store.approve(run.id, 'alpha');
    f.store.approve(run.id, 'alpha');
    assert.equal(f.store.get(run.id, 'alpha').status, 'completed');
    assert.equal(f.store.reportCount(run.id), 1);
    const events = f.store.events(run.id, 'alpha', 0);
    assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
    assert.equal(events.filter(e => e.type === 'report.published').length, 1);
  } finally { f.close(); }
});

test('两个连接原子抢占；过期 worker 无法提交；租约限制跨实例并发', () => {
  const f = fixture(); const second = new Store(f.db);
  try {
    f.store.create('alpha', 'a', '退款', false);
    f.store.create('alpha', 'b', '退款', false);
    const first = f.store.claim(1, 20, 100)!;
    assert.ok(first);
    assert.equal(second.claim(1, 20, 101), null);
    const newOwner = second.claim(1, 20, 121)!;
    assert.equal(first.id, newOwner.id);
    assert.equal(f.store.commit(first.id, first.owner!, first.state, 'queued', [], 122), false);
    assert.equal(second.commit(newOwner.id, newOwner.owner!, newOwner.state, 'queued', [], 122), true);
  } finally { second.close(); f.close(); }
});

test('取消先提交后，晚到模型响应不能覆盖终态或执行待审批报告', async () => {
  const f = fixture();
  try {
    const run = f.store.create('alpha', 'cancel', '退款', true);
    const claimed = f.store.claim()!;
    f.store.cancel(run.id, 'alpha');
    assert.equal(f.store.commit(run.id, claimed.owner!, claimed.state, 'completed', []), false);
    assert.equal(f.store.get(run.id, 'alpha').status, 'cancelled');
    assert.throws(() => f.store.approve(run.id, 'alpha'), /INVALID_STATE/);
  } finally { f.close(); }
});

test('关闭发生在一轮中途时回退到完整检查点，不持久化缺失 tool_result 的历史', async () => {
  const f = fixture(); const original = KnowledgeTools.prototype.execute;
  try {
    const run = f.store.create('alpha', 'shutdown', '退款', false);
    const initial = f.store.get(run.id, 'alpha').state;
    const runtime = new Runtime(f.store, new FakeModel());
    KnowledgeTools.prototype.execute = async function (...args) {
      const output = await original.apply(this, args);
      void runtime.stop();
      return output;
    };
    await runtime.tick();
    const interrupted = f.store.get(run.id, 'alpha');
    assert.equal(interrupted.status, 'queued');
    assert.deepEqual(interrupted.state, initial);
    KnowledgeTools.prototype.execute = original;
    await new Runtime(f.store, new FakeModel()).drain();
    assert.equal(f.store.get(run.id, 'alpha').status, 'completed');
  } finally { KnowledgeTools.prototype.execute = original; f.close(); }
});

test('合法队列的 22 个三轮任务全部排空，显式小批次正常返回而非报错', async () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 22 }, (_, n) => f.store.create('alpha', `volume-${n}`, '退款', true).id);
    const runtime = new Runtime(f.store, new FakeModel());
    await runtime.drain();
    assert.ok(ids.every(id => f.store.get(id, 'alpha').status === 'waiting_approval'));
    const extra = f.store.create('alpha', 'batch', '退款', false);
    assert.deepEqual(await runtime.drain(1), { turns: 1, reason: 'batch_limit' });
    assert.equal(f.store.get(extra.id, 'alpha').state.steps, 1);
    await runtime.drain();
    assert.equal(f.store.get(extra.id, 'alpha').status, 'completed');
  } finally { f.close(); }
});

test('模型调用失败会记录 failed 事件，任务不会静默卡住', async () => {
  const f = fixture();
  try {
    const run = f.store.create('alpha', 'fail', '退款', false);
    const runtime = new Runtime(f.store, { next: async () => { throw new Error('fixture failure'); } });
    await runtime.tick();
    assert.equal(f.store.get(run.id, 'alpha').status, 'failed');
    assert.ok(f.store.events(run.id, 'alpha', 0).some(e => e.type === 'run.failed'));
  } finally { f.close(); }
});
