import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.ts';
import { FakeModel } from '../src/model.ts';
import { Store } from '../src/store.ts';

const auth = { Authorization: 'Bearer demo-alpha' };
test('SSE 终态历史超过单页时仍重放全部事件', async () => {
  const app = createApp(new Store(':memory:'), new FakeModel());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const run = app.store.create('alpha', 'long-history', '退款', true);
    for (let n = 0; n < 140; n++) {
      const claimed = app.store.claim()!;
      app.store.commit(claimed.id, claimed.owner!, claimed.state, 'queued', []);
    }
    await app.runtime.drain();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runs/${run.id}/stream`, { headers: auth, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    assert.match(text, /run.waiting_approval/);
    assert.ok([...text.matchAll(/^id: /gm)].length > 256);
  } finally { await app.close(); }
});
test('HTTP 端到端：身份→任务→事件重放→审批→报告，含跨租户拒绝', async () => {
  const app = createApp(new Store(':memory:'), new FakeModel());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + '/api/runs')).status, 401);
    const make = () => fetch(base + '/api/runs', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-demo' }, body: JSON.stringify({ prompt: '退款政策是什么？', publish: true }) });
    const first = await make(); assert.equal(first.status, 202);
    const run = await first.json() as { id: string };
    assert.equal((await (await make()).json() as { id: string }).id, run.id);
    await app.runtime.drain();
    const cross = await fetch(base + `/api/runs/${run.id}`, { headers: { Authorization: 'Bearer demo-beta' } });
    assert.equal(cross.status, 404);
    const snapshot = await (await fetch(base + `/api/runs/${run.id}`, { headers: auth })).json() as Record<string, unknown>;
    assert.equal(snapshot.status, 'waiting_approval');
    assert.equal('state' in snapshot, false);
    const events = await (await fetch(base + `/api/runs/${run.id}/events?after=2`, { headers: auth })).json() as { seq: number }[];
    assert.ok(events.length > 0); assert.ok(events.every(e => e.seq > 2));
    const stream = await fetch(base + `/api/runs/${run.id}/stream?after=2`, { headers: auth });
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await stream.text(); assert.match(text, /id: 3/); assert.match(text, /waiting_approval/);
    assert.equal((await fetch(base + `/api/runs/${run.id}/stream?after=no`, { headers: auth })).status, 400);
    assert.equal((await fetch(base + `/api/runs/${run.id}/approve`, { method: 'POST', headers: auth })).status, 200);
    const report = await (await fetch(base + `/api/reports/${run.id}`, { headers: auth })).json() as { citations: unknown[] };
    assert.equal(report.citations.length, 1);
    assert.equal((await fetch(base + `/api/reports/${run.id}`, { headers: { Authorization: 'Bearer demo-beta' } })).status, 404);
  } finally { await app.close(); }
});
