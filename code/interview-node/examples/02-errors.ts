import assert from 'node:assert/strict';
import { advance, createState } from '../src/agent.ts';
import { ReplayModel, call, result } from '../src/model.ts';
import { KnowledgeTools } from '../src/tools.ts';

// 可控回放故意把参数类型写错；不是声称真实模型必定能自行纠错。
const model = new ReplayModel([
  result([call('bad', 'search', { query: 12 })]),
  result([call('fixed', 'search', { query: '退款' })]),
]);
const state = createState('退款政策'); const tools = new KnowledgeTools();
const ctx = { tenant: 'alpha', signal: AbortSignal.timeout(5000) };
await advance(state, model, tools, ctx);
console.log('第一轮回填：', state.messages.at(-1)?.content);
assert.match(JSON.stringify(state.messages.at(-1)), /INVALID_ARGUMENT/);
await advance(state, model, tools, ctx);
assert.match(JSON.stringify(state.messages.at(-1)), /refund/);
console.log('第二轮已恢复检索；观察 assistant → tool_call_id 对应的 tool 消息。模式：离线协议回放。');
