import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { Model, Run } from './types.ts';
import { AppError, fail } from './types.ts';
import { Store } from './store.ts';
import { Runtime } from './runtime.ts';
import { selectModel } from './model.ts';

const DEMO_IDENTITIES: Record<string, string> = { 'Bearer demo-alpha': 'alpha', 'Bearer demo-beta': 'beta' };
function tenantOf(req: IncomingMessage): string {
  // 仅限 loopback 的教学身份，不是生产鉴权。生产替换成 JWT/session 校验，不能信任 body.tenant。
  const tenant = DEMO_IDENTITIES[req.headers.authorization ?? ''];
  if (!tenant) fail('UNAUTHORIZED'); return tenant;
}
function view(run: Run) {
  return { id: run.id, prompt: run.prompt, publish: run.publish, status: run.status, answer: run.state.answer, steps: run.state.steps, inputTokens: run.state.inputTokens, outputTokens: run.state.outputTokens, error: run.error };
}
function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16_384) fail('BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT');
  return value as Record<string, unknown>;
}
function afterOf(url: URL, req: IncomingMessage): number {
  const raw = url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0';
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) fail('INVALID_CURSOR');
  const after = Number(raw); if (!Number.isSafeInteger(after)) fail('INVALID_CURSOR'); return after;
}

export function createApp(store: Store, model: Model) {
  const runtime = new Runtime(store, model);
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    if (res.headersSent) { res.end(); return; }
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    const status = code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'IDEMPOTENCY_CONFLICT' || code === 'INVALID_STATE' ? 409 : code === 'QUEUE_FULL' ? 429 : code === 'BODY_TOO_LARGE' ? 413 : code === 'INTERNAL_ERROR' ? 500 : 400;
    json(res, status, { error: code });
  }); });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
    const tenant = tenantOf(req);
    if (url.pathname === '/api/runs' && req.method === 'GET') { json(res, 200, store.list(tenant).map(view)); return; }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.prompt !== 'string' || (input.publish !== undefined && typeof input.publish !== 'boolean') || Object.keys(input).some(k => !['prompt', 'publish'].includes(k))) fail('INVALID_ARGUMENT');
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string') fail('INVALID_KEY');
      json(res, 202, view(store.create(tenant, key, input.prompt, input.publish === true))); return;
    }
    const report = /^\/api\/reports\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (report && req.method === 'GET') {
      const found = store.report(report[1], tenant); if (!found) fail('NOT_FOUND'); json(res, 200, found); return;
    }
    const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(events|stream|cancel|approve))?$/.exec(url.pathname);
    if (!match) fail('NOT_FOUND');
    const [, id, action] = match;
    store.get(id, tenant); // 包含 stream 和重放的每条路都先鉴权。
    if (!action && req.method === 'GET') { json(res, 200, view(store.get(id, tenant))); return; }
    if (action === 'cancel' && req.method === 'POST') { json(res, 200, view(runtime.cancel(id, tenant))); return; }
    if (action === 'approve' && req.method === 'POST') { json(res, 200, view(store.approve(id, tenant))); return; }
    if (action === 'events' && req.method === 'GET') { json(res, 200, store.events(id, tenant, afterOf(url, req))); return; }
    if (action === 'stream' && req.method === 'GET') {
      let cursor = afterOf(url, req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); streams.add(res);
      let timer: ReturnType<typeof setInterval> | undefined;
      const clean = () => { if (timer) clearInterval(timer); streams.delete(res); };
      res.on('close', clean);
      const pump = () => {
        try {
          const batch = store.events(id, tenant, cursor);
          for (const event of batch) {
            // 慢客户端断开后按 seq 重放，不把数据无限堆在进程内。
            if (!res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) { res.end(); clean(); return; }
            cursor = event.seq;
          }
          // 终态也可能仍有下一页；必须把历史排空后再关闭。
          if (batch.length < 256 && !['queued', 'running'].includes(store.get(id, tenant).status)) { res.end(); clean(); }
        } catch { res.end(); clean(); }
      };
      timer = setInterval(pump, 100); pump(); return;
    }
    fail('NOT_FOUND');
  }
  return { server, runtime, store, async close() {
    await runtime.stop();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const live = process.argv.includes('--live');
  const app = createApp(new Store(process.env.AGENT_DB ?? '.data/agent.db'), selectModel(live));
  const port = Number(process.env.PORT ?? 8787);
  app.runtime.start();
  app.server.listen(port, '127.0.0.1', () => console.log(`Research Desk: http://127.0.0.1:${port} (${live ? '真实 DeepSeek，会消耗 token' : '离线 fake 模型'})`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
