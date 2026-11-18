import assert from 'node:assert/strict';
import { runInMemory, createState } from '../src/agent.ts';
import { FakeModel } from '../src/model.ts';
import { KnowledgeTools } from '../src/tools.ts';

const { state } = await runInMemory('退款政策是什么？', new FakeModel());
console.log('离线 fake 模型的带引用答案：', state.answer);
const tools = new KnowledgeTools(); const unread = createState('退款');
const ctx = { tenant: 'alpha', signal: AbortSignal.timeout(5000) };
await assert.rejects(tools.execute('submit_answer', state.answer, unread, ctx), /UNREAD_CITATION/);
await assert.rejects(tools.execute('read_document', { id: 'beta-secret' }, unread, ctx), /NOT_FOUND/);
console.log('未读引用、跨租户读取均被宿主拒绝；逐字摘录存在不等于语义支持已经证明。');
