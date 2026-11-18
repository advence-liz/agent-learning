import test from 'node:test';
import assert from 'node:assert/strict';
import { seedLocalPrompt } from '../src/prompt-seed.ts';
import { loadSystemPrompt } from '../src/prompts.ts';

test('seed 明确读取 latest，不将 production 旧版本误判为需要新建版本', async () => {
  const builtin = await loadSystemPrompt({ env: {} }); let posts = 0;
  const version = await seedLocalPrompt({ env: {}, fetch: async (input, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ version: 6 }); }
    const url = new URL(String(input));
    return Response.json(url.searchParams.get('label') === 'latest' ? { prompt: builtin.text, version: 5 } : { prompt: '旧 production 文案', version: 2 });
  } });
  assert.equal(version, 5); assert.equal(posts, 0);
});
test('seed 内容变化才创建新版本，返回服务端实际版本', async () => {
  let posts = 0;
  const version = await seedLocalPrompt({ env: {}, fetch: async (_input, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ version: 7 }); }
    return Response.json({ prompt: 'older', version: 6 });
  } });
  assert.equal(version, 7); assert.equal(posts, 1);
});
