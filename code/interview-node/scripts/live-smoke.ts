import assert from 'node:assert/strict';
import { DeepSeekModel } from '../src/model.ts';
import { Store } from '../src/store.ts';
import { createApp } from '../src/server.ts';
import type { Answer } from '../src/types.ts';

// 只有显式 --allow-live 才发请求；npm test / demo / eval 不导入此入口。
if (!process.argv.includes('--allow-live')) throw new Error('需要显式 --allow-live；这会消耗 DeepSeek token。');
if (!process.env.DEEPSEEK_API_KEY) throw new Error('请在 shell 中设置 DEEPSEEK_API_KEY，勿写入仓库。');
let requests = 0;
const safeFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'https://api.deepseek.com') throw new Error('Live smoke 只允许 DeepSeek 官方端点');
  if (++requests > 10) throw new Error('LIVE_REQUEST_LIMIT');
  return fetch(input, init);
};
const model = new DeepSeekModel({ baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', maxOutputTokens: 1536, fetch: safeFetch });
const app = createApp(new Store(':memory:'), model);
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const address = app.server.address(); assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const headers = { Authorization: 'Bearer demo-alpha', 'Content-Type': 'application/json' };
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(125_000) });
  if (!response.ok) assert.fail(`HTTP ${response.status} ${await response.text()}`);
  return response;
}
try {
  const run = await (await request('/api/runs', { method: 'POST', headers: { 'Idempotency-Key': 'live-refund' }, body: JSON.stringify({ prompt: '退款政策是什么？请说明期限和必要核验，并提供引用。', publish: true }) })).json() as { id: string };
  app.runtime.start();
  const stream = await request(`/api/runs/${run.id}/stream`);
  const events = await stream.text(); assert.match(events, /run.waiting_approval/);
  const ready = await (await request(`/api/runs/${run.id}`)).json() as { status: string; answer: Answer; steps: number; inputTokens: number; outputTokens: number; error: string | null };
  assert.equal(ready.status, 'waiting_approval', ready.error ?? '');
  assert.equal(ready.answer.kind, 'grounded'); assert.ok(ready.answer.citations.some(c => c.id === 'refund'));
  assert.equal(app.store.report(run.id, 'alpha'), null);
  for (let n = 0; n < 2; n++) await request(`/api/runs/${run.id}/approve`, { method: 'POST' });
  const report = await (await request(`/api/reports/${run.id}`)).json() as Answer;
  assert.ok(report.citations.length); assert.equal(app.store.reportCount(run.id), 1);
  console.log(JSON.stringify({ mode: '真实 DeepSeek + HTTP + SSE + SQLite + 审批', model: model.model, status: 'completed', requests, steps: ready.steps, inputTokens: ready.inputTokens, outputTokens: ready.outputTokens, answer: report, idempotentReports: app.store.reportCount(run.id) }, null, 2));
} finally { await app.close(); }
