import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.ts';
import { Runtime } from '../src/runtime.ts';
import { FakeModel } from '../src/model.ts';

const stage = process.argv[2];
if (stage === 'first' || stage === 'second') {
  const store = new Store(process.argv[3]);
  try {
    const runtime = new Runtime(store, new FakeModel(), 1);
    if (stage === 'first') {
      const run = store.create('alpha', 'recovery-demo', '退款政策', false);
      await runtime.tick();
      assert.equal(store.get(run.id, 'alpha').state.steps, 1);
      console.log('进程一：search 完成并提交检查点，退出。');
    } else {
      const prior = store.list('alpha')[0];
      assert.equal(prior.state.steps, 1);
      await runtime.drain();
      const ready = store.get(prior.id, 'alpha');
      assert.equal(ready.status, 'completed'); assert.equal(ready.state.steps, 3);
      console.log('进程二：从 SQLite 恢复，继续 read → submit，总共 3 轮。');
    }
  } finally { store.close(); }
} else {
  const dir = mkdtempSync(join(tmpdir(), 'agent-recovery-'));
  try {
    for (const phase of ['first', 'second']) {
      const child = spawnSync(process.execPath, [import.meta.filename, phase, join(dir, 'run.db')], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, 0, child.stderr); process.stdout.write(child.stdout);
    }
    console.log('模式：离线 fake 模型；两个真实子进程。强杀后的租约接管另见 runtime 测试。');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
