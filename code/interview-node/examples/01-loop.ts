import { FakeModel } from '../src/model.ts';
import { createState } from '../src/agent.ts';
import { KnowledgeTools, toolDefinitions } from '../src/tools.ts';

// 第一阶只看这段循环。错误恢复、预算、持久化都留给后续例子。
const state = createState('退款政策是什么？');
const model = new FakeModel(); const tools = new KnowledgeTools();
const signal = AbortSignal.timeout(5000);
for (let step = 0; step < 5 && !state.answer; step++) {
  const turn = await model.next(state.messages, toolDefinitions, signal);
  state.messages.push(turn.message);
  for (const item of turn.message.tool_calls ?? []) {
    if (item.type !== 'function') throw new Error('unsupported tool');
    console.log(`tool: ${item.function.name}`);
    const output = await tools.execute(item.function.name, JSON.parse(item.function.arguments), state, { tenant: 'alpha', signal });
    state.messages.push({ role: 'tool', tool_call_id: item.id, content: JSON.stringify(output) });
  }
}
if (!state.answer) throw new Error('没有在 5 轮内完成');
console.log('answer:', state.answer.answer);
console.log('模式：离线 fake 模型；循环内的工具是真实 TypeScript 函数。');
