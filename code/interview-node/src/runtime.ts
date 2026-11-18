import type { Model, Trace } from './types.ts';
import { AppError } from './types.ts';
import { advance, defaults } from './agent.ts';
import { KnowledgeTools } from './tools.ts';
import { Store, GLOBAL_QUEUE_LIMIT } from './store.ts';

export class Runtime {
  private active = new Map<string, AbortController>();
  private pending = new Set<Promise<boolean>>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  readonly store: Store;
  readonly model: Model;
  readonly concurrency: number;
  constructor(store: Store, model: Model, concurrency = 2) { this.store = store; this.model = model; this.concurrency = concurrency; }

  async tick(): Promise<boolean> {
    if (this.stopping || this.active.size >= this.concurrency) return false;
    const run = this.store.claim(this.concurrency);
    if (!run || !run.owner) return false;
    // 关闭时只能回到完整轮次，不能把半条 assistant/tool 协议提交为可恢复历史。
    const checkpoint = structuredClone(run.state);
    const controller = new AbortController(); this.active.set(run.id, controller);
    const traces: Trace[] = [];
    const heartbeat = setInterval(() => {
      if (!this.store.heartbeat(run.id, run.owner!)) controller.abort(new AppError('LEASE_LOST'));
    }, 5000);
    const deadline = setTimeout(() => controller.abort(new AppError('RUN_TIMEOUT')), Math.max(1, run.deadline - Date.now()));
    try {
      if (Date.now() >= run.deadline) throw new AppError('RUN_TIMEOUT');
      const done = await advance(run.state, this.model, new KnowledgeTools(), { tenant: run.tenant, signal: controller.signal }, {}, traces);
      this.store.commit(run.id, run.owner, run.state, done ? run.publish ? 'waiting_approval' : 'completed' : 'queued', traces);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'MODEL_OR_TOOL_FAILURE';
      // 取消/租约丢失时 CAS 提交会失败，不能用晚到响应覆盖另一个 worker 或终态。
      this.store.commit(run.id, run.owner, this.stopping ? checkpoint : run.state, this.stopping ? 'queued' : 'failed', traces, Date.now(), this.stopping ? null : code);
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline); this.active.delete(run.id);
    }
    return true;
  }
  async drain(maxTurns = GLOBAL_QUEUE_LIMIT * (defaults.maxSteps + 1)): Promise<{ turns: number; reason: 'no_claimable_work' | 'batch_limit' }> {
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new AppError('INVALID_BATCH_LIMIT');
    // 默认覆盖一个满队列快照的最坏轮数；持续接单时也不能无限循环。
    for (let turns = 0; turns < maxTurns; turns++) {
      if (!await this.tick()) return { turns, reason: 'no_claimable_work' };
    }
    // 批次耗尽不是任务失败；调用方可再次 drain，或改用 start 持续消费。
    return { turns: maxTurns, reason: 'batch_limit' };
  }
  cancel(id: string, tenant: string) {
    const current = this.store.cancel(id, tenant);
    this.active.get(id)?.abort(new AppError('CANCELLED'));
    return current;
  }
  start(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      const task = this.tick(); this.pending.add(task);
      void task.catch(() => console.error('worker storage failure')).finally(() => this.pending.delete(task));
    }, 100);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const controller of this.active.values()) controller.abort(new AppError('SHUTDOWN'));
    await Promise.allSettled(this.pending);
  }
}
