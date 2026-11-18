import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { runInMemory, createState } from './agent.ts';
import { FakeModel } from './model.ts';
import { KnowledgeTools } from './tools.ts';

// 这是协议与宿主不变量回归，不是模型能力 benchmark。
export async function evaluate() {
  const results: { name: string; passed: boolean; detail: string }[] = [];
  const record = async (name: string, check: () => Promise<void>) => {
    try { await check(); results.push({ name, passed: true, detail: 'ok' }); }
    catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : 'failed' }); }
  };
  for (const [question, tenant, expected] of [
    ['退款政策', 'alpha', 'refund'], ['差旅报销', 'alpha', 'expense'],
    ['不存在的资料', 'alpha', null], ['退款政策', 'beta', null],
  ] as const) await record(`${tenant}: ${question}`, async () => {
    const { state } = await runInMemory(question, new FakeModel(), tenant);
    assert.equal(state.answer?.kind, expected ? 'grounded' : 'not_found');
    if (expected) assert.equal(state.answer?.citations[0].id, expected);
    else assert.equal(state.answer?.citations.length, 0);
    assert.ok(state.steps <= 3);
  });
  const ctx = { tenant: 'alpha', signal: AbortSignal.timeout(5000) };
  await record('宿主拒绝跨租户读取', async () => {
    await assert.rejects(new KnowledgeTools().execute('read_document', { id: 'beta-secret' }, createState('预算'), ctx), /NOT_FOUND/);
  });
  await record('宿主拒绝未读引用', async () => {
    await assert.rejects(new KnowledgeTools().execute('submit_answer', { kind: 'grounded', answer: '伪造', citations: [{ id: 'refund', quote: '伪造' }] }, createState('退款'), ctx), /UNREAD_CITATION/);
  });
  return { mode: '离线协议与权限回归，不代表真实模型准确率', passed: results.filter(r => r.passed).length, total: results.length, results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await evaluate(); console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
}
