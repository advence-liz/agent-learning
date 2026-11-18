import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { AppError, check, GLOBAL_CONCURRENCY } from './domain.ts';
import type { ArtifactStore } from './artifacts.ts';
import { S3Artifacts } from './artifacts.ts';
import { Repository, createPool, event, safeError } from './repository.ts';
import type { Job } from './repository.ts';
import { research } from './agent.ts';
import { observed, startTelemetry } from './observability.ts';

export function markdown(job: Pick<Job, 'run'>): string {
  const answer = job.run.answer; check(answer, 'MISSING_ANSWER');
  return `# Research report\n\n${answer.answer}\n\n## Sources\n\n${answer.citations.map(c => `- ${c.id}: ${c.quote}`).join('\n')}\n`;
}
export class Worker {
  readonly repo: Repository; readonly artifacts: ArtifactStore;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = new Map<Promise<boolean>, AbortController>();
  constructor(repo: Repository, artifacts: ArtifactStore) { this.repo = repo; this.artifacts = artifacts; }
  async runOnce(options: { runId?: string; gatewayURL?: string; pauseAfterTools?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    if (this.stopping) return false;
    const job = await this.repo.claim(options.runId); if (!job) return false;
    const local = new AbortController();
    const signal = AbortSignal.any([local.signal, options.signal ?? new AbortController().signal, AbortSignal.timeout(job.run.status === 'publishing' ? 30_000 : Math.max(1, job.run.deadline.getTime() - Date.now()))]);
    const connectionError = () => local.abort(new AppError('DATABASE_SESSION_LOST'));
    job.client.on('error', connectionError);
    // 同进程/跨进程取消都读持久状态；不把断开 SSE 当作取消任务。
    const heartbeat = setInterval(() => { void job.alive().catch(() => local.abort(new AppError('OWNERSHIP_LOST'))); }, 500);
    try {
      await observed(job.run.status === 'publishing' ? 'report.publish' : 'agent.research', { runId: job.run.id, tenant: job.run.tenant }, async () => {
        if (job.run.status === 'publishing') {
          await job.alive();
          const content = markdown(job);
          let object: { key: string; sha256: string };
          if (job.reconcileOnly) {
            const key = `reports/${job.run.id}.md`;
            const actual = await this.artifacts.get(key, signal);
            const sha256 = createHash('sha256').update(content).digest('hex');
            check(createHash('sha256').update(actual).digest('hex') === sha256, 'ARTIFACT_HASH_MISMATCH');
            object = { key, sha256 };
          } else object = await this.artifacts.put(job.run.id, content, signal);
          await job.client.query('BEGIN');
          try {
            const updated = await job.client.query("UPDATE agent_runs SET status='completed',owner=NULL WHERE id=$1 AND owner=$2 AND status='publishing' RETURNING id", [job.run.id, job.run.owner]);
            if (updated.rowCount) {
              await job.client.query('INSERT INTO agent_artifacts(run_id,object_key,sha256) VALUES($1,$2,$3) ON CONFLICT(run_id) DO NOTHING', [job.run.id, object.key, object.sha256]);
              await event(job.client, job.run.id, 'report.published', { sha256: object.sha256 });
              await event(job.client, job.run.id, 'run.completed');
            }
            await job.client.query('COMMIT');
          } catch (error) { await job.client.query('ROLLBACK'); throw error; }
        } else {
          check(Date.now() < job.run.deadline.getTime(), 'RUN_TIMEOUT');
          const answer = await research(job, { ...options, signal });
          await job.finish(answer ? 'waiting_approval' : 'queued', answer);
        }
      });
    } catch (error) {
      // 审批后的上传失败仍保留 publishing outbox；单任务有限重试，晚到提交受 owner/status CAS 保护。
      const publishingAttempts = (await job.client.query<{ publish_attempts: number }>('SELECT publish_attempts FROM agent_runs WHERE id=$1', [job.run.id]).catch(() => ({ rows: [] }))).rows[0]?.publish_attempts ?? 3;
      const status = this.stopping && job.run.status !== 'publishing' ? 'queued' : job.run.status === 'publishing' && publishingAttempts < 3 ? 'publishing' : 'failed';
      await job.finish(status, null, this.stopping ? null : safeError(error)).catch(() => {});
    } finally {
      clearInterval(heartbeat); job.client.off('error', connectionError); await job.close();
    }
    return true;
  }
  start(options: { runId?: string } = {}) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.active.size >= GLOBAL_CONCURRENCY || this.stopping) return;
      const controller = new AbortController();
      const task = this.runOnce({ ...options, signal: controller.signal }); this.active.set(task, controller);
      void task.catch(() => console.error('worker database unavailable')).finally(() => this.active.delete(task));
    }, 100);
  }
  async stop() {
    this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const controller of this.active.values()) controller.abort(new AppError('SHUTDOWN'));
    await Promise.allSettled(this.active.keys());
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const telemetry = await startTelemetry(); const pool = createPool();
  const worker = new Worker(new Repository(pool), new S3Artifacts());
  if (process.argv.includes('--once') || process.argv.includes('--pause-after-tools')) {
    const index = process.argv.indexOf('--run-id');
    const runId = index >= 0 ? process.argv[index + 1] : undefined;
    if (index >= 0) check(runId && /^[a-f0-9-]{36}$/.test(runId), 'INVALID_RUN_ID');
    await worker.runOnce({ runId, pauseAfterTools: process.argv.includes('--pause-after-tools') }); await pool.end(); await telemetry.shutdown();
  } else {
    worker.start(); console.log('PostgreSQL worker 已启动，数据库全局并发上限 2。');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void worker.stop().then(() => pool.end()).then(() => telemetry.shutdown()); });
  }
}
