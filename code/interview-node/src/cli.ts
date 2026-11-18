import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { Runtime } from './runtime.ts';
import { selectModel } from './model.ts';

const [command = 'demo', ...args] = process.argv.slice(2);
const live = args.includes('--live');
const usage = '用法：node src/cli.ts demo [--live] | create "问题" | work [--live] | list | status/approve/cancel/events <id>。默认 fake；--live 消耗 DeepSeek token。';
if (!['demo', 'create', 'work', 'list', 'status', 'approve', 'cancel', 'events'].includes(command)) throw new Error(usage);
// demo 用独立内存库；其余命令可跨进程操作同一个 AGENT_DB。
const store = new Store(command === 'demo' ? ':memory:' : process.env.AGENT_DB ?? '.data/agent.db');
try {
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const id = args[0]; const tenant = 'alpha';
  if (['status', 'approve', 'cancel', 'events'].includes(command) && (!id || id.startsWith('--'))) throw new Error(usage);
  if (command === 'demo') {
    console.log(live ? '真实 DeepSeek，会消耗 token。' : '离线 fake 模型，执行真实工具与 SQLite 事务。');
    const runtime = new Runtime(store, selectModel(live), 1);
    const run = store.create(tenant, randomUUID(), '退款政策是什么？请给出引用。', true);
    await runtime.drain();
    const ready = store.get(run.id, tenant);
    if (ready.status !== 'waiting_approval') throw new Error(ready.error ?? `状态异常：${ready.status}`);
    print({ id: run.id, status: ready.status, answer: ready.state.answer, steps: ready.state.steps });
    console.log('教学 demo 显式模拟用户点击批准；HTTP 服务与普通 create 不会自动批准。');
    store.approve(run.id, tenant); store.approve(run.id, tenant);
    print({ status: store.get(run.id, tenant).status, reportCount: store.reportCount(run.id), report: store.report(run.id, tenant) });
  } else if (command === 'create') {
    const run = store.create(tenant, randomUUID(), args.join(' '), true);
    print({ id: run.id, status: run.status });
  } else if (command === 'work') {
    const batch = await new Runtime(store, selectModel(live), 1).drain();
    print({ mode: live ? 'live' : 'fake', batch, runs: store.list(tenant).map(r => ({ id: r.id, status: r.status, error: r.error })) });
  } else if (command === 'list') print(store.list(tenant).map(r => ({ id: r.id, status: r.status, prompt: r.prompt })));
  else if (command === 'status') { const run = store.get(id, tenant); print({ id: run.id, status: run.status, answer: run.state.answer, error: run.error }); }
  else if (command === 'approve') print({ status: store.approve(id, tenant).status, report: store.report(id, tenant) });
  else if (command === 'cancel') print({ status: store.cancel(id, tenant).status });
  else if (command === 'events') print(store.events(id, tenant));
} finally { store.close(); }
