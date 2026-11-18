import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekModel, FakeModel } from '../src/model.ts';
import { advance, createState } from '../src/agent.ts';
import { KnowledgeTools, toolDefinitions } from '../src/tools.ts';
import { TransientError } from '../src/types.ts';

const ctx = () => ({ tenant: 'alpha', signal: AbortSignal.timeout(5000) });
test('DeepSeek wire：请求禁用 thinking、限制输出，保留完整工具与 reasoning 字段', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 1536);
    assert.equal(body.stream, false); assert.equal(body.tools.length, 3);
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'fixture only', tool_calls: [{ id: 'c', type: 'function', function: { name: 'search', arguments: '{"query":"退款"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
  };
  const model = new DeepSeekModel({ apiKey: 'fixture-not-a-secret', fetch: fetcher });
  const turn = await model.next(createState('退款').messages, toolDefinitions, ctx().signal);
  assert.equal(requests, 1); assert.equal(turn.message.reasoning_content, 'fixture only');
  assert.equal(turn.message.tool_calls?.[0].id, 'c'); assert.equal(turn.inputTokens, 12);
});
for (const [status, expected] of [[401, 'MODEL_HTTP_401'], [429, 'MODEL_TRANSIENT'], [503, 'MODEL_TRANSIENT']] as const) {
  test(`DeepSeek HTTP ${status}：SDK 不自行重试且错误不暴露响应原文`, async () => {
    let requests = 0;
    const model = new DeepSeekModel({ apiKey: 'fixture-not-a-secret', fetch: async () => { requests++; return Response.json({ error: { message: 'sensitive upstream detail' } }, { status }); } });
    await assert.rejects(model.next([], toolDefinitions, ctx().signal), error => {
      assert.equal((error as Error).message, expected);
      assert.equal(error instanceof TransientError, status !== 401); return true;
    });
    assert.equal(requests, 1);
  });
}
test('瞬时故障只在 Agent 层有限重试；token 预算超限不执行工具', async () => {
  let attempts = 0;
  const fake = new FakeModel(); const state = createState('退款');
  await advance(state, { next: async (...args) => { if (++attempts === 1) throw new TransientError('busy'); return fake.next(...args); } }, new KnowledgeTools(), ctx());
  assert.equal(attempts, 2);
  const over = createState('退款');
  await assert.rejects(advance(over, fake, new KnowledgeTools(), ctx(), { maxTokens: 1 }), /TOKEN_LIMIT/);
  assert.equal(over.messages.filter(m => m.role === 'tool').length, 0);
});
