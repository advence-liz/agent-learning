import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLocalSettings } from '../src/settings.ts';

test('dotenv 不能提供模型密钥，即使 shell 已有同名变量也拒绝文件中的值', () => {
  assert.throws(() => loadLocalSettings(['DEEPSEEK_API_KEY=FAKE_FROM_FILE'], {}), /SECRETS_MUST_COME_FROM_SHELL/);
  assert.throws(() => loadLocalSettings(['DEEPSEEK_API_KEY=FAKE_FROM_FILE'], { DEEPSEEK_API_KEY: 'FAKE_FROM_SHELL' }), /SECRETS_MUST_COME_FROM_SHELL/);
  assert.throws(() => loadLocalSettings(['GATEWAY_TOKEN=FAKE_CUSTOM_TOKEN'], {}), /SECRETS_MUST_COME_FROM_SHELL/);
});
test('只允许公开教学假值从模板进入，非敏感配置允许覆盖，shell 优先', () => {
  const env = loadLocalSettings(['S3_ACCESS_KEY_ID=agent-demo-access\nS3_SECRET_ACCESS_KEY=local-demo-only-storage\nDEEPSEEK_API_KEY=\nPORT=58787', 'PORT=58888'], { DEEPSEEK_API_KEY: 'FAKE_FROM_SHELL', PORT: '58999' });
  assert.equal(env.DEEPSEEK_API_KEY, 'FAKE_FROM_SHELL'); assert.equal(env.PORT, '58999');
  assert.equal(env.S3_SECRET_ACCESS_KEY, 'local-demo-only-storage');
  assert.throws(() => loadLocalSettings(['DATABASE_URL=postgres://demo:NOT_A_REAL_PASSWORD@localhost/db'], {}), /SECRETS_MUST_COME_FROM_SHELL/);
});
test('所有应用入口使用受控配置加载器，不由 Node --env-file 注入 provider key', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['start', 'worker', 'gateway', 'demo', 'migrate', 'seed', 'eval', 'prompt:seed']) {
    assert.match(pkg.scripts[name], /scripts\/launch\.ts/); assert.doesNotMatch(pkg.scripts[name], /--env-file/);
  }
});
