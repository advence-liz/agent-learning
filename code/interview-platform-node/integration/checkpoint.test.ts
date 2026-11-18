import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../src/gateway.ts';
import { createPool, migrate, Repository } from '../src/repository.ts';
import { seed } from '../src/seed.ts';
import { research, researchAgent } from '../src/agent.ts';
import { loadSystemPrompt } from '../src/prompts.ts';

test('最终模型已保存、after_model hook 尚未运行时也能恢复答案', async () => {
  const pool = createPool(); await migrate(pool); await seed(pool); const repo = new Repository(pool);
  const gateway = createGateway({ mode: 'fake', maxRequests: 3 }); await gateway.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
  const gatewayURL = `http://127.0.0.1:${address.port}/v1`;
  const run = await repo.create('alpha', randomUUID(), '退款政策', await loadSystemPrompt());
  let job = await repo.claim(run.id); assert.ok(job);
  try {
    const agent = researchAgent(job, { gatewayURL });
    const config = { configurable: { thread_id: `alpha:${run.id}` }, durability: 'sync' as const, interruptAfter: ['model_request'] };
    for (let n = 0; n < 3; n++) await agent.invoke(n === 0 ? { messages: [{ role: 'user', content: run.prompt }] } : null, config);
    assert.ok((await agent.graph.getState(config)).next.length > 0, '保留待运行的最终 hook');
    await job.close(); job = await repo.claim(run.id); assert.ok(job);
    const answer = await research(job, { gatewayURL, signal: AbortSignal.timeout(10_000) });
    assert.equal(answer?.kind, 'grounded'); assert.equal((await repo.get(run.id, 'alpha')).input_tokens, 90);
    await job.finish('waiting_approval', answer);
  } finally { await job?.close(); await gateway.close(); await repo.cancel(run.id, 'alpha'); await pool.end(); }
});

test('图已完成但业务状态未提交时，恢复结构化结果而不再次调用模型', async () => {
  const pool = createPool(); await migrate(pool); await seed(pool); const repo = new Repository(pool);
  const gateway = createGateway({ mode: 'fake', maxRequests: 3 }); await gateway.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
  const gatewayURL = `http://127.0.0.1:${address.port}/v1`;
  const run = await repo.create('alpha', randomUUID(), '退款政策', await loadSystemPrompt());
  let job = await repo.claim(run.id); assert.ok(job);
  try {
    const answer = await research(job, { gatewayURL, signal: AbortSignal.timeout(10_000) });
    assert.equal(answer?.kind, 'grounded');
    // 模拟进程在 LangGraph 持久化后、业务 finish 前消失。
    await job.close(); job = await repo.claim(run.id); assert.ok(job);
    const recovered = await research(job, { gatewayURL, signal: AbortSignal.timeout(10_000) });
    assert.deepEqual(recovered, answer);
    assert.equal((await repo.get(run.id, 'alpha')).input_tokens, 90);
    await job.finish('waiting_approval', recovered);
  } finally { await job?.close(); await gateway.close(); await repo.cancel(run.id, 'alpha'); await pool.end(); }
});
