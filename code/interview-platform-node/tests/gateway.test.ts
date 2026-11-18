import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway.ts';

test('上游超大响应与非2xx响应在释放并发槽之前取消流', async () => {
  const key = process.env.DEEPSEEK_API_KEY; const allow = process.env.ALLOW_LIVE_MODEL;
  process.env.DEEPSEEK_API_KEY = 'FAKE'; process.env.ALLOW_LIVE_MODEL = 'true';
  try {
    for (const status of [200, 503]) {
      let cancelled = false; let pulls = 0;
      const upstream = new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; if (pulls <= 8) controller.enqueue(new Uint8Array(64 * 1024)); else controller.close(); },
        cancel() { cancelled = true; },
      }), { status });
      const app = createGateway({ mode: 'live', token: 'fixture-gateway', fetch: async () => upstream });
      try {
        const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-gateway' }, payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'fixture' }], stream: false } });
        assert.equal(response.statusCode, 502); assert.equal(cancelled, true);
        assert.ok(pulls <= 4, '不应把整个大响应读入内存');
      } finally { await app.close(); }
    }
  } finally { if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key; if (allow === undefined) delete process.env.ALLOW_LIVE_MODEL; else process.env.ALLOW_LIVE_MODEL = allow; }
});

test('网关默认 fake，鉴权、模型白名单与 OpenAI 工具协议有效', async () => {
  const app = createGateway({ mode: 'fake', token: 'local-gateway-test' });
  try {
    const body = { model: 'deepseek-flash', messages: [{ role: 'user', content: '退款政策' }], tools: [{ type: 'function', function: { name: 'search' } }], stream: false };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body })).statusCode, 401);
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer local-gateway-test' }, payload: body });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().choices[0].message.tool_calls[0].function.name, 'search');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer local-gateway-test' }, payload: { ...body, model: 'unapproved' } })).statusCode, 400);
  } finally { await app.close(); }
});
