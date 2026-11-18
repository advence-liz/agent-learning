import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AppError, check } from './domain.ts';
import type { Run } from './domain.ts';
import type { ArtifactStore } from './artifacts.ts';
import { S3Artifacts } from './artifacts.ts';
import { Repository, createPool } from './repository.ts';
import { loadSystemPrompt } from './prompts.ts';

const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
function tenant(req: FastifyRequest) {
  // 公开教学身份；生产接 OIDC/JWT、角色与审批人权限，不接受客户端指定 tenant。
  const identities = new Map([[`Bearer ${process.env.API_TOKEN_ALPHA ?? 'demo-alpha'}`, 'alpha'], [`Bearer ${process.env.API_TOKEN_BETA ?? 'demo-beta'}`, 'beta']]);
  const found = identities.get(req.headers.authorization ?? ''); check(found, 'UNAUTHORIZED'); return found;
}
function view(run: Run) { return { id: run.id, status: run.status, answer: run.answer, error: run.error, promptVersion: run.prompt_version, inputTokens: run.input_tokens, outputTokens: run.output_tokens }; }
export async function createAPI(repo: Repository, storage: ArtifactStore, system: { text: string; version: string }) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 10_000 });
  app.server.maxConnections = 64;
  await app.register(swagger, { openapi: { info: { title: 'Research Platform API', version: '1.0.0' }, components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } } } });
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('onRequest', async req => { if (req.url.startsWith('/api/')) tenant(req); });
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff'); return payload; });
  app.setErrorHandler((error, _req, reply) => {
    const code = error instanceof AppError ? error.code : 'VALIDATION_ERROR';
    const clientStatus = (error as { statusCode?: number }).statusCode;
    const status = code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : ['INVALID_STATE', 'ALREADY_APPROVED', 'IDEMPOTENCY_CONFLICT'].includes(code) ? 409 : code === 'QUEUE_FULL' ? 429 : error instanceof AppError ? 400 : clientStatus && clientStatus >= 400 && clientStatus < 500 ? clientStatus : 500;
    void reply.code(status).send({ error: status === 500 ? 'INTERNAL_ERROR' : code });
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/openapi.json', async () => app.swagger());
  app.post<{ Body: { prompt: string } }>('/api/runs', { schema: { security: [{ bearer: [] }], body: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 2000 } } }, headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 100 } } } } }, async (req, reply) => {
    const run = await repo.create(tenant(req), String(req.headers['idempotency-key']), req.body.prompt, system);
    return reply.code(202).send(view(run));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', { schema: { params, security: [{ bearer: [] }] } }, async req => view(await repo.get(req.params.id, tenant(req))));
  app.post<{ Params: { id: string } }>('/api/runs/:id/approve', { schema: { params, security: [{ bearer: [] }] } }, async (req, reply) => reply.code(202).send(view(await repo.approve(req.params.id, tenant(req)))));
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', { schema: { params, security: [{ bearer: [] }] } }, async req => view(await repo.cancel(req.params.id, tenant(req))));
  const after = (req: FastifyRequest, query: unknown) => {
    const raw = (query as { after?: string }).after ?? req.headers['last-event-id'] ?? '0';
    check(typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)), 'INVALID_CURSOR'); return Number(raw);
  };
  app.get<{ Params: { id: string } }>('/api/runs/:id/events', { schema: { params, security: [{ bearer: [] }] } }, async req => repo.events(req.params.id, tenant(req), after(req, req.query)));
  app.get<{ Params: { id: string } }>('/api/runs/:id/stream', { schema: { params, security: [{ bearer: [] }] } }, async (req, reply) => {
    const owner = tenant(req); const id = req.params.id; await repo.get(id, owner);
    let cursor = after(req, req.query); check(streams.size < 32, 'QUEUE_FULL');
    reply.hijack(); const res = reply.raw; streams.add(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    let busy = false; let timer: ReturnType<typeof setInterval>;
    const clean = () => { clearInterval(timer); streams.delete(res); }; res.once('close', clean);
    const pump = async () => {
      if (busy || res.destroyed) return; busy = true;
      try {
        // 先读状态再读事件：终态和事件在同一事务提交，避免两次查询间完成导致漏发末帧。
        const status = (await repo.get(id, owner)).status;
        const batch = await repo.events(id, owner, cursor);
        for (const item of batch) {
          if (!res.write(`id: ${item.seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`)) { res.end(); clean(); return; }
          cursor = item.seq;
        }
        if (batch.length < 128 && ['waiting_approval', 'completed', 'cancelled', 'failed'].includes(status)) { res.end(); clean(); }
      } catch { res.end(); clean(); } finally { busy = false; }
    };
    timer = setInterval(() => { void pump(); }, 200); void pump();
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/artifact', { schema: { params, security: [{ bearer: [] }] } }, async (req, reply) => {
    const run = await repo.get(req.params.id, tenant(req)); check(run.status === 'completed', 'NOT_FOUND');
    const object = (await repo.pool.query<{ object_key: string; sha256: string }>('SELECT object_key,sha256 FROM agent_artifacts WHERE run_id=$1', [run.id])).rows[0]; check(object, 'NOT_FOUND');
    const text = await storage.get(object.object_key); check(createHash('sha256').update(text).digest('hex') === object.sha256, 'ARTIFACT_HASH_MISMATCH');
    return reply.type('text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="${run.id}.md"`).send(text);
  });
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(); const app = await createAPI(new Repository(pool), new S3Artifacts(), await loadSystemPrompt());
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 58787) });
  console.log('API 已监听 loopback；OpenAPI: /openapi.json。worker 与模型网关独立运行。');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => pool.end()); });
}
