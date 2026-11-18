import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway.ts';
import { createAPI } from '../src/server.ts';
import { createPool, migrate, Repository } from '../src/repository.ts';
import { seed } from '../src/seed.ts';
import { S3Artifacts } from '../src/artifacts.ts';
import { Worker } from '../src/worker.ts';
import { loadSystemPrompt } from '../src/prompts.ts';
import { startTelemetry } from '../src/observability.ts';

const live = process.argv.includes('--live');
if (live) process.env.ALLOW_LIVE_MODEL = 'true';
const telemetry = await startTelemetry();
const pool = createPool(); await migrate(pool); await seed(pool);
const repo = new Repository(pool); const storage = new S3Artifacts();
const gateway = createGateway({ mode: live ? 'live' : 'fake', maxRequests: 10 });
await gateway.listen({ host: '127.0.0.1', port: 0 });
const ga = gateway.server.address(); assert.ok(ga && typeof ga !== 'string');
process.env.MODEL_GATEWAY_URL = `http://127.0.0.1:${ga.port}/v1`;
const system = await loadSystemPrompt();
const api = await createAPI(repo, storage, system);
await api.listen({ host: '127.0.0.1', port: 0 });
const address = api.server.address(); assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const headers = { authorization: `Bearer ${process.env.API_TOKEN_ALPHA ?? 'demo-alpha'}` };
const worker = new Worker(repo, storage);
async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers }, signal: AbortSignal.timeout(130_000) });
  if (!res.ok) throw new Error(`DEMO_HTTP_${res.status}`); return res;
}
try {
  const created = await (await request('/api/runs', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ prompt: '退款政策是什么？请给出逐字引用。' }) })).json() as { id: string };
  worker.start({ runId: created.id });
  const stream = await request(`/api/runs/${created.id}/stream`);
  const events = await stream.text(); assert.match(events, /run.waiting_approval/);
  const ready = await repo.get(created.id, 'alpha'); assert.equal(ready.status, 'waiting_approval', ready.error ?? '');
  for (let n = 0; n < 2; n++) await request(`/api/runs/${created.id}/approve`, { method: 'POST' });
  const published = await request(`/api/runs/${created.id}/stream`); assert.match(await published.text(), /run.completed/);
  const report = await (await request(`/api/runs/${created.id}/artifact`)).text(); assert.match(report, /七天/);
  console.log(JSON.stringify({ mode: live ? '真实 DeepSeek' : '离线协议模型 + 真实 PostgreSQL / S3', id: created.id, status: (await repo.get(created.id, 'alpha')).status, promptVersion: system.version, inputTokens: ready.input_tokens, outputTokens: ready.output_tokens, citations: ready.answer?.citations, markdownBytes: Buffer.byteLength(report), artifactCount: (await pool.query('SELECT * FROM agent_artifacts WHERE run_id=$1', [created.id])).rowCount }, null, 2));
} finally { await worker.stop(); await api.close(); await gateway.close(); await pool.end(); await telemetry.shutdown(); }
