import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Runtime } from '../src/runtime.ts';
import { FakeModel } from '../src/model.ts';

const store = new Store(':memory:');
try {
  const runtime = new Runtime(store, new FakeModel());
  const run = store.create('alpha', 'approval-demo', '退款政策', true);
  await runtime.drain();
  assert.equal(store.get(run.id, 'alpha').status, 'waiting_approval');
  assert.equal(store.report(run.id, 'alpha'), null);
  console.log('研究已完成，但审批前 reports 表里没有报告。');
  store.approve(run.id, 'alpha'); store.approve(run.id, 'alpha');
  assert.equal(store.reportCount(run.id), 1);
  const cancelled = store.create('alpha', 'cancel-demo', '退款政策', true);
  runtime.cancel(cancelled.id, 'alpha'); await runtime.drain();
  assert.equal(store.get(cancelled.id, 'alpha').status, 'cancelled');
  assert.throws(() => store.approve(cancelled.id, 'alpha'), /INVALID_STATE/);
  console.log('重复审批只有一份报告；取消任务不执行、不能审批。模式：离线 fake 模型。');
} finally { store.close(); }
