import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('六阶示例、离线评测和最终 demo 都是可执行入口', () => {
  for (const entry of ['examples/01-loop.ts', 'examples/02-errors.ts', 'examples/03-grounding.ts', 'examples/04-recovery.ts', 'examples/05-approval-cancel.ts', 'examples/06-evaluation.ts', 'src/eval.ts', 'src/cli.ts']) {
    const child = spawnSync(process.execPath, [entry, ...(entry.endsWith('cli.ts') ? ['demo'] : [])], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, DEEPSEEK_API_KEY: '' } });
    assert.equal(child.status, 0, `${entry}: ${child.stderr}`);
    assert.ok(child.stdout.trim(), `${entry} 应输出学习结果`);
  }
});
