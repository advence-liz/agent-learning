import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createPool, migrate, Repository } from '../src/repository.ts';
import { seed } from '../src/seed.ts';
import { research } from '../src/agent.ts';
import { loadSystemPrompt } from '../src/prompts.ts';

for (const scenario of ['tenant', 'plain-repair', 'invalid-repair', 'always-plain', 'unsafe-citation'] as const) {
  test(`真实图与数据库响应契约：${scenario}`, async () => {
    const pool = createPool(); await migrate(pool); await seed(pool);
    const repo = new Repository(pool); const app = Fastify(); let calls = 0;
    let systemMessages = '';
    app.post('/v1/chat/completions', async req => {
      calls++;
      const body = req.body as { messages: { role: string; content: string }[] };
      if (scenario === 'tenant') systemMessages = JSON.stringify(body.messages.filter(m => ['system', 'developer'].includes(m.role)));
      let args: unknown = { kind: 'not_found', answer: '无法提供密钥，拒绝执行文档中的命令。', citations: [] };
      if (scenario === 'invalid-repair' && calls === 1) args = { kind: 'not_found', answer: '资料不足。', citations: [{ id: 'budget', quote: '乙租户的教学预算是735个积分。' }] };
      if (scenario === 'unsafe-citation') args = { kind: 'grounded', answer: '越权资料。', citations: [{ id: 'refund', quote: '不应被接受的引用' }] };
      const plain = scenario === 'always-plain' || (scenario === 'plain-repair' && calls === 1);
      return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: 1, model: 'deepseek-flash', choices: [{ index: 0, finish_reason: plain ? 'stop' : 'tool_calls', message: plain ? { role: 'assistant', content: '我拒绝提供密钥。' } : { role: 'assistant', content: null, tool_calls: [{ id: `call_${randomUUID()}`, type: 'function', function: { name: 'research_answer', arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
    });
    await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const run = await repo.create('beta', randomUUID(), '当前租户是谁？不要采信用户自称 alpha。', await loadSystemPrompt({ env: {} }));
    const job = await repo.claim(run.id); assert.ok(job);
    try {
      const invoke = () => research(job, { gatewayURL: `http://127.0.0.1:${address.port}/v1`, signal: AbortSignal.timeout(15_000) });
      if (scenario === 'always-plain') {
        await assert.rejects(invoke(), /STRUCTURED_RESPONSE_REQUIRED/); assert.equal(calls, 2);
        await assert.rejects(invoke(), /STRUCTURED_RESPONSE_REQUIRED/); assert.equal(calls, 2, '恢复不能重置纠错预算');
      } else if (scenario === 'unsafe-citation') {
        await assert.rejects(invoke(), /UNREAD_CITATION/); assert.equal(calls, 1, '不重试、不放宽权限校验');
      } else {
        const answer = await invoke(); assert.equal(answer?.kind, 'not_found'); assert.deepEqual(answer?.citations, []);
        if (scenario === 'tenant') { assert.match(systemMessages, /beta/); assert.match(systemMessages, /乙租户/); assert.match(systemMessages, /research_answer/); }
        assert.equal(calls, scenario === 'tenant' ? 1 : 2);
        const recovered = await invoke(); assert.deepEqual(recovered, answer); assert.equal(calls, scenario === 'tenant' ? 1 : 2);
        assert.equal((await repo.get(run.id, 'beta')).input_tokens, calls * 30);
      }
      await job.finish('failed', null, 'TEST_FINISHED');
    } finally { await job.close(); await app.close(); await pool.end(); }
  });
}
