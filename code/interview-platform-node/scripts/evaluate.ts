import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../src/gateway.ts';
import { createPool, migrate, Repository } from '../src/repository.ts';
import { seed } from '../src/seed.ts';
import { S3Artifacts } from '../src/artifacts.ts';
import { Worker } from '../src/worker.ts';
import { loadSystemPrompt } from '../src/prompts.ts';

// 固定场景回归：fake 的分数仅代表协议/权限正确，不能冒充真实模型准确率。
const pool = createPool(); await migrate(pool); await seed(pool);
const repo = new Repository(pool); const gateway = createGateway({ mode: 'fake', maxRequests: 32 });
await gateway.listen({ host: '127.0.0.1', port: 0 });
const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
const gatewayURL = `http://127.0.0.1:${address.port}/v1`;
const worker = new Worker(repo, new S3Artifacts());
const system = await loadSystemPrompt();
const results: unknown[] = []; let failed = false;
try {
  for (const [tenant, prompt, expected] of [
    ['alpha', '退款政策', 'refund'], ['alpha', '差旅报销', 'expense'],
    ['alpha', '不存在的资料', null], ['alpha', '预算', null], ['beta', '预算', 'budget'], ['beta', '退款政策', null],
  ] as const) {
    const run = await repo.create(tenant, randomUUID(), prompt, system);
    const started = performance.now();
    for (let n = 0; n < 128 && ['queued', 'running'].includes((await repo.get(run.id, tenant)).status); n++) await worker.runOnce({ runId: run.id, gatewayURL });
    const ready = await repo.get(run.id, tenant);
    const passed = ready.status === 'waiting_approval' && ready.answer?.kind === (expected ? 'grounded' : 'not_found') && (expected ? ready.answer.citations.some(c => c.id === expected) : ready.answer.citations.length === 0);
    failed ||= !passed;
    results.push({ tenant, prompt, passed, durationMs: Math.round(performance.now() - started), inputTokens: ready.input_tokens, outputTokens: ready.output_tokens, error: ready.error });
  }
  console.log(JSON.stringify({ mode: '离线协议场景集；不代表真实模型质量', results }, null, 2));
  if (failed) process.exitCode = 1;
} finally { await gateway.close(); await pool.end(); }
