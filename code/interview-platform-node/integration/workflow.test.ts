import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/gateway.ts';
import { createAPI } from '../src/server.ts';
import { createPool, migrate, Repository } from '../src/repository.ts';
import { seed } from '../src/seed.ts';
import { Worker } from '../src/worker.ts';
import { S3Artifacts } from '../src/artifacts.ts';
import { loadSystemPrompt } from '../src/prompts.ts';

const storageEnv = { S3_ENDPOINT: 'http://127.0.0.1:59000', S3_REGION: 'us-east-1', S3_BUCKET: 'agent-reports', S3_ACCESS_KEY_ID: 'agent-demo-access', S3_SECRET_ACCESS_KEY: 'local-demo-only-storage' };
test('真实 PostgreSQL + LangChain/LangGraph + 网关 + S3：恢复、审批、产物及租户边界', async () => {
  const pool = createPool(); await migrate(pool); await seed(pool);
  const repo = new Repository(pool); const storage = new S3Artifacts({ env: storageEnv });
  const gateway = createGateway({ mode: 'fake' }); await gateway.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
  const gatewayURL = `http://127.0.0.1:${address.port}/v1`;
  const api = await createAPI(repo, storage, await loadSystemPrompt());
  const headers = { authorization: 'Bearer demo-alpha', 'idempotency-key': randomUUID() };
  try {
    const make = () => api.inject({ method: 'POST', url: '/api/runs', headers, payload: { prompt: '退款政策是什么？' } });
    const first = await make(); assert.equal(first.statusCode, 202, first.body);
    const id = first.json().id as string;
    const malformed = await api.inject({ method: 'POST', url: `/api/runs/${id}/approve`, headers: { ...headers, 'content-type': 'application/json' } });
    assert.equal(malformed.statusCode, 400, '空 JSON body 是客户端错误，不应返回500');
    assert.equal((await make()).json().id, id);
    const worker = new Worker(repo, storage);
    const child = (pause: boolean) => new Promise<void>((resolve, reject) => {
      const processChild = spawn(process.execPath, [fileURLToPath(new URL('../src/worker.ts', import.meta.url)), '--once', '--run-id', id, ...(pause ? ['--pause-after-tools'] : [])], {
        env: { ...process.env, ...storageEnv, MODEL_GATEWAY_URL: gatewayURL, DEEPSEEK_API_KEY: '', LANGFUSE_BASE_URL: '', LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
      });
      let stderr = ''; processChild.stderr.on('data', chunk => { stderr += String(chunk); });
      processChild.on('error', reject); processChild.on('close', code => code === 0 ? resolve() : reject(new Error(`worker child ${code}: ${stderr}`)));
    });
    await child(true);
    assert.equal((await repo.get(id, 'alpha')).status, 'queued');
    await child(false);
    const ready = await repo.get(id, 'alpha');
    assert.equal(ready.status, 'waiting_approval', ready.error ?? '');
    assert.equal(ready.answer?.citations[0].id, 'refund');
    assert.equal(ready.input_tokens, 90, '三次模型响应均应计量，包括结构化最终回答');
    assert.equal(ready.output_tokens, 30);
    const calls = (await repo.events(id, 'alpha')).filter(e => e.type === 'tool.finished');
    assert.equal(calls.filter(e => (e.data as { tool: string }).tool === 'search').length, 1);
    assert.equal((await pool.query('SELECT * FROM agent_artifacts WHERE run_id=$1', [id])).rowCount, 0);
    assert.equal((await api.inject({ url: `/api/runs/${id}`, headers: { authorization: 'Bearer demo-beta' } })).statusCode, 404);
    for (let n = 0; n < 2; n++) assert.equal((await api.inject({ method: 'POST', url: `/api/runs/${id}/approve`, headers })).statusCode, 202);
    const interruptedPublish = new Worker(repo, {
      get: storage.get.bind(storage),
      put: async (...args) => { await storage.put(...args); throw new Error('模拟上传成功后、确认前中断'); },
    });
    await interruptedPublish.runOnce({ runId: id, gatewayURL });
    assert.equal((await repo.get(id, 'alpha')).status, 'publishing');
    assert.equal((await pool.query('SELECT * FROM agent_artifacts WHERE run_id=$1', [id])).rowCount, 0);
    await worker.runOnce({ runId: id, gatewayURL });
    assert.equal((await repo.get(id, 'alpha')).status, 'completed');
    const report = await api.inject({ url: `/api/runs/${id}/artifact`, headers });
    assert.equal(report.statusCode, 200, report.body); assert.match(report.body, /七天/);
    assert.equal((await pool.query('SELECT * FROM agent_artifacts WHERE run_id=$1', [id])).rowCount, 1);
  } finally { await api.close(); await gateway.close(); await pool.end(); }
});
