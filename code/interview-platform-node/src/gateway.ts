import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { check } from './domain.ts';
import { boundedText } from './http.ts';

type WireMessage = { role: string; content?: unknown; tool_call_id?: string };
const requestSchema = z.object({ model: z.literal('deepseek-flash'), messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()).min(1).max(64), stream: z.literal(false).optional(), tools: z.array(z.unknown()).max(6).optional(), max_tokens: z.number().int().positive().max(2048).optional() }).passthrough();

// 协议模拟器，不冒充推理能力；LangChain 仍走真实的 HTTP 和工具循环。
function fakeResponse(body: z.infer<typeof requestSchema>) {
  const messages = body.messages as WireMessage[];
  const question = String(messages.find(m => m.role === 'user')?.content);
  const observations = messages.filter(m => m.role === 'tool').map(m => {
    try { return JSON.parse(String(m.content)) as Record<string, unknown>; } catch { return {}; }
  });
  const last = observations.at(-1);
  const query = question.includes('报销') ? '报销' : question.includes('不存在') ? '不存在' : question.includes('预算') ? '预算' : '退款';
  const tools = (body.tools ?? []) as { function: { name: string } }[];
  const finalName = tools.find(t => !['search', 'read_document'].includes(t.function.name))?.function.name;
  let name = 'search'; let args: unknown = { query };
  if (Array.isArray(last?.hits)) {
    const hit = last.hits[0] as { id: string } | undefined;
    if (hit) { name = 'read_document'; args = { id: hit.id }; }
    else { check(finalName, 'MISSING_RESPONSE_TOOL'); name = finalName; args = { kind: 'not_found', answer: '授权资料中未找到答案。', citations: [] }; }
  } else if (typeof last?.body === 'string') {
    check(finalName, 'MISSING_RESPONSE_TOOL'); name = finalName;
    args = { kind: 'grounded', answer: last.body, citations: [{ id: last.id, quote: last.body }] };
  }
  return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
}
export function createGateway(options: { mode?: 'fake' | 'live'; token?: string; fetch?: typeof fetch; maxRequests?: number } = {}) {
  const mode = options.mode ?? (process.env.MODEL_MODE === 'live' ? 'live' : 'fake');
  if (mode === 'live') check(process.env.ALLOW_LIVE_MODEL === 'true' && process.env.DEEPSEEK_API_KEY, 'LIVE_MODEL_REQUIRES_EXPLICIT_OPT_IN');
  const token = options.token ?? process.env.GATEWAY_TOKEN ?? 'demo-gateway-local';
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, requestTimeout: 10_000 });
  let active = 0; let requests = 0;
  app.get('/health', async () => ({ ok: true, mode }));
  app.post('/v1/chat/completions', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: { message: 'UNAUTHORIZED' } });
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { message: 'INVALID_REQUEST' } });
    if (active >= 4 || requests >= (options.maxRequests ?? 10_000)) return reply.code(429).send({ error: { message: 'GATEWAY_LIMIT' } });
    requests++; active++;
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    req.raw.once('aborted', disconnected); reply.raw.once('close', disconnected);
    try {
      if (mode === 'fake') return fakeResponse(parsed.data);
      // 网关只转发明确允许的参数；绝不把网关令牌转给上游。
      const payload = { model: parsed.data.model, messages: parsed.data.messages, tools: parsed.data.tools, stream: false, max_tokens: Math.min(parsed.data.max_tokens ?? 1536, 2048), thinking: { type: 'disabled' } };
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const upstream = await (options.fetch ?? fetch)('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
      if (!upstream.ok) {
        void upstream.body?.cancel().catch(() => {});
        return reply.code(upstream.status === 429 ? 429 : 502).send({ error: { message: `UPSTREAM_HTTP_${upstream.status}` } });
      }
      const text = await boundedText(upstream, signal);
      return reply.type('application/json').send(text);
    } catch { return reply.code(502).send({ error: { message: 'GATEWAY_UPSTREAM_FAILURE' } }); }
    finally { active--; req.raw.off('aborted', disconnected); reply.raw.off('close', disconnected); }
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createGateway();
  await app.listen({ host: '127.0.0.1', port: Number(process.env.GATEWAY_PORT ?? 58080) });
  console.log('模型网关已监听 loopback；默认 fake，日志不记录请求或凭证。');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
