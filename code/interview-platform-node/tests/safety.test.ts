import test from 'node:test';
import assert from 'node:assert/strict';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import { createPool } from '../src/repository.ts';
import { disableImplicitTracing, assertContextBudget, databaseURL } from '../src/domain.ts';

test('所有环境追踪别名与 verbose 均禁用，不附加原文 tracer', async () => {
  const names = ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_VERBOSE'];
  const before = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = 'true';
    disableImplicitTracing();
    for (const name of names) assert.equal(process.env[name], undefined);
    const manager = await CallbackManager.configure([], []);
    assert.ok(!manager?.handlers.some(h => ['langchain_tracer', 'console_callback_handler'].includes(h.name)));
  } finally { names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; }); }
});
test('上下文字节预算包含系统消息，中文按 UTF-8 字节计数', () => {
  assert.throws(() => assertContextBudget([{ role: 'user', content: 'hi' }], '中'.repeat(14_000)), /CONTEXT_LIMIT/);
  assert.throws(() => assertContextBudget([{ role: 'user', content: 'x'.repeat(39_000) }], 'x'.repeat(2000)), /CONTEXT_LIMIT/);
  assert.doesNotThrow(() => assertContextBudget([{ role: 'user', content: 'hi' }], 'short'));
});
test('idle pool error 有安全监听器，不抛出进程级未处理异常或错误原文', async t => {
  const logs: unknown[][] = []; t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const pool = createPool();
  try {
    assert.doesNotThrow(() => pool.emit('error', new Error('FAKE sensitive connection details')));
    assert.ok(logs.length); assert.ok(!JSON.stringify(logs).includes('sensitive connection details'));
  } finally { await pool.end(); }
});

test('PostgreSQL 拒绝 query host/service 覆盖与非 PostgreSQL 协议', () => {
  const previous = process.env.DATABASE_URL; const allow = process.env.ALLOW_EXTERNAL_DATABASE;
  try {
    delete process.env.ALLOW_EXTERNAL_DATABASE;
    for (const value of ['postgres://user:FAKE@localhost/db?host=example.com', 'postgres://user:FAKE@127.0.0.1/db?hostaddr=example.com', 'postgres://localhost/db?service=remote', 'http://localhost/db']) {
      process.env.DATABASE_URL = value; assert.throws(() => databaseURL());
    }
    process.env.DATABASE_URL = 'postgres://localhost:55432/db'; assert.equal(databaseURL(), process.env.DATABASE_URL);
  } finally { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; if (allow === undefined) delete process.env.ALLOW_EXTERNAL_DATABASE; else process.env.ALLOW_EXTERNAL_DATABASE = allow; }
});
