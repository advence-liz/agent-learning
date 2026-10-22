/**
 * 后台任务（第 16 章起）：跑得久、结束后要告诉模型的活，都放这里。
 *
 * - bash：Bash(run_in_background=true)。子进程输出写文件，它退出时（child 的 close 事件）发一条 <task-notification>。
 * - 第 17 章的 sub agent、第 18 章的 Monitor 复用同一套：Job 表 + 输出文件 + agent.notify()。
 *
 * 通知走第 9 章预留的通道：agent.notify() 放进「待送达」队列，notificationsProvider 在下一条 user 消息
 * （用户发话或工具结果）里送达；如果 agent 正空闲，App.wakeIfIdle() 主动开一轮把通知交给模型。
 *
 * Python 版每个任务一个等待线程；Node 是单线程事件循环，子进程的 close / data 事件和定时器回调
 * 本来就和 agent 循环交替执行，所以这里没有线程和锁，job.done 是一个「任务结束」的 Promise。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type JobStatus = "running" | "completed" | "failed" | "killed";

export class Job {
  id: string;
  kind: string; // bash | agent | monitor
  description: string;
  outputFile: string;
  toolUseId: string;
  status: JobStatus = "running";
  exitCode: number | null = null;
  started = Date.now() / 1000;
  ended: number | null = null;
  proc: ChildProcess | null = null;
  done: Promise<void> = Promise.resolve(); // 对应 Python 的 job.thread：任务（连同通知）彻底结束时 resolve
  stopRequested = false;
  extra: Record<string, any> = {};

  constructor(id: string, kind: string, description: string, outputFile: string, toolUseId = "") {
    this.id = id;
    this.kind = kind;
    this.description = description;
    this.outputFile = outputFile;
    this.toolUseId = toolUseId;
  }

  /** 等任务结束，最多等 timeout 秒；返回是否已经结束。 */
  async wait(timeout?: number): Promise<boolean> {
    if (timeout === undefined) {
      await this.done;
    } else {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.done, new Promise((r) => (timer = setTimeout(r, timeout * 1000)))]);
      clearTimeout(timer);
    }
    return this.status !== "running";
  }

  get runtime(): number {
    return (this.ended ?? Date.now() / 1000) - this.started;
  }
}

/** 同 Python 的 html.escape(s, quote=False)：只转义 & < >。 */
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** 被信号杀掉时按 Python 的习惯记成负数退出码（SIGTERM → -15）。 */
const exitCode = (code: number | null, sig: NodeJS.Signals | null) => code ?? -(constants.signals[sig!] ?? 1);

/** 和 Claude Code 的 <task-notification> 同一个结构（字段名取自本机会话记录）。 */
export function renderNotification(job: Job, summary: string, result?: string | null): string {
  const parts = ["<task-notification>", `<task-id>${job.id}</task-id>`];
  if (job.toolUseId) parts.push(`<tool-use-id>${job.toolUseId}</tool-use-id>`);
  parts.push(`<output-file>${job.outputFile}</output-file>`, `<status>${job.status}</status>`,
    `<summary>${escape(summary)}</summary>`); // 和本机记录一致：转义 & < >，引号不转
  if (result !== undefined && result !== null) parts.push(`<result>\n${result}\n</result>`);
  parts.push("</task-notification>");
  return parts.join("\n");
}

/** 线程型任务（sub agent）的工作函数：返回 [status, summary, result]。 */
export type JobWork = (job: Job) => Promise<[JobStatus, string, string | null]>;

export class JobManager {
  // 第 18 章 Monitor 的节流参数（数值参考 Claude Code Monitor 工具的说明：200ms 内的行合并成一条通知）
  batchWindow = 0.2; // 秒：这段时间内的输出行合并成一个事件
  maxBatchLines = 50; // 一个事件最多带多少行，多的留在输出文件里
  maxEvents = 30; // eventWindow 秒内超过这么多事件就自动停掉（刷屏的 monitor 会吃光上下文）
  eventWindow = 60.0;

  dir: string;
  notify: (text: string) => void;
  jobs = new Map<string, Job>();
  private ids = new Map<string, number>();

  constructor(dir: string, notify: (text: string) => void) {
    this.dir = dir;
    this.notify = notify;
  }

  private newJob(kind: string, prefix: string, description: string, toolUseId: string, jobId?: string): Job {
    if (!jobId) {
      const n = (this.ids.get(prefix) ?? 0) + 1;
      this.ids.set(prefix, n);
      jobId = `${prefix}${n}`;
    }
    const job = new Job(jobId, kind, description, join(this.dir, `${jobId}.output`), toolUseId);
    this.jobs.set(job.id, job);
    mkdirSync(this.dir, { recursive: true });
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  running(): Job[] {
    return [...this.jobs.values()].filter((j) => j.status === "running");
  }

  /** 整个进程组发 SIGTERM（detached 的子进程自成一组，pid 就是组号）。 */
  private killGroup(job: Job): void {
    try {
      process.kill(-job.proc!.pid!, "SIGTERM");
    } catch {
      /* 已经退出了 */
    }
  }

  // ------------------------------------------------------------ bash

  startBash(command: string, cwd: string, description = "", toolUseId = ""): Job {
    const job = this.newJob("bash", "b", description || command, toolUseId);
    const out = openSync(job.outputFile, "w");
    // detached：自成一个进程组，TaskStop 能连同它的子进程（比如 npm 拉起的 node）一起杀掉
    job.proc = spawn(command, { shell: true, cwd, stdio: ["ignore", out, out], detached: true });
    closeSync(out); // 子进程持有自己的那份 fd
    job.done = new Promise((resolve) => {
      job.proc!.on("close", (code, sig) => {
        const rc = exitCode(code, sig);
        job.exitCode = rc;
        job.ended = Date.now() / 1000;
        if (job.stopRequested) {
          job.status = "killed";
          return resolve(); // 模型或用户主动停的：调用方已经知道了，不再通知
        }
        job.status = rc === 0 ? "completed" : "failed";
        const verb = rc === 0 ? "completed (exit code 0)" : `failed with exit code ${rc}`;
        this.notify(renderNotification(job, `Background command "${job.description}" ${verb}`));
        resolve();
      });
    });
    return job;
  }

  // ------------------------------------------------------------ 异步任务（第 17 章 sub agent）

  /** fn(job) 在后台跑（不 await 它），返回 [status, summary, result]；结束后发通知（result 放进 <result>）。 */
  startThread(kind: string, prefix: string, description: string, fn: JobWork, toolUseId = "", jobId?: string): Job {
    const job = this.newJob(kind, prefix, description, toolUseId, jobId);
    const run = async () => {
      await Promise.resolve(); // 先让调用方拿到 job，再开始干活（同 Python 版另起线程）
      let status: JobStatus, summary: string, result: string | null;
      try {
        [status, summary, result] = await fn(job);
      } catch (e) {
        const err = e as Error;
        [status, summary, result] = ["failed", `${kind} "${description}" crashed: ${err?.name ?? "Error"}: ${err?.message ?? e}`, null];
      }
      job.ended = Date.now() / 1000;
      if (job.stopRequested) {
        job.status = "killed";
        return;
      }
      job.status = status;
      this.notify(renderNotification(job, summary, result));
    };
    job.done = run();
    return job;
  }

  // ------------------------------------------------------------ monitor（第 18 章）

  /** 命令的 stdout 每一行（200ms 内的合并）是一个事件；进程退出 / 超时 / 刷屏时各发一条结束通知。 */
  startMonitor(command: string, cwd: string, description: string, timeout: number, toolUseId = ""): Job {
    const job = this.newJob("monitor", "m", description, toolUseId);
    const out = openSync(job.outputFile, "w");
    job.proc = spawn(command, { shell: true, cwd, stdio: ["ignore", "pipe", out], detached: true });
    const pending: string[] = [];
    let batchTimer: NodeJS.Timeout | null = null; // 当前这批第一行到达时启动，batchWindow 后发出
    const sent: number[] = []; // 每个事件发出的时间（节流用）
    job.extra.events = 0;
    let endReason: "timeout" | "flood" | null = null;

    const kill = (reason: "timeout" | "flood") => {
      endReason ??= reason;
      this.killGroup(job);
    };

    const flush = () => {
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = null;
      if (!pending.length) return;
      const lines = pending.slice(0, this.maxBatchLines);
      const more = pending.length - this.maxBatchLines;
      pending.length = 0;
      const body = lines.join("\n") + (more > 0 ? `\n(… ${more} more lines in the output file)` : "");
      if (job.stopRequested || endReason) return;
      job.extra.events++;
      sent.push(performance.now() / 1000);
      this.notify(["<task-notification>", `<task-id>${job.id}</task-id>`,
        `<summary>Monitor event: "${escape(description)}"</summary>`,
        `<event>${escape(body)}</event>`, "</task-notification>"].join("\n"));
      const recent = sent.filter((t) => t > performance.now() / 1000 - this.eventWindow);
      if (recent.length >= this.maxEvents) kill("flood");
    };

    const deadline = setTimeout(() => kill("timeout"), timeout * 1000);
    const reader = createInterface({ input: job.proc.stdout!, crlfDelay: Infinity });
    reader.on("line", (line) => {
      writeSync(out, line + "\n");
      if (!line.trim()) return;
      pending.push(line);
      batchTimer ??= setTimeout(flush, this.batchWindow * 1000);
    });

    job.done = new Promise((resolve) => {
      job.proc!.on("close", (code, sig) => {
        clearTimeout(deadline);
        flush(); // 进程结束前最后几行
        closeSync(out);
        const rc = exitCode(code, sig);
        job.exitCode = rc;
        job.ended = Date.now() / 1000;
        const n = job.extra.events;
        if (job.stopRequested) {
          job.status = "killed";
          return resolve();
        }
        let summary: string;
        if (endReason === "timeout") {
          job.status = "killed";
          summary = `Monitor "${description}" expired after ${timeout}s with ${n} events. ` +
            "Arm it again (re-arm) if you still need the watch.";
        } else if (endReason === "flood") {
          job.status = "killed";
          summary = `Monitor "${description}" was stopped: too many events (${n} in ${this.eventWindow}s). ` +
            "Restart it with a tighter filter (only the lines you would act on).";
        } else {
          job.status = rc === 0 ? "completed" : "failed";
          summary = `Monitor "${description}" stream ended (exit code ${rc}, ${n} events)`;
        }
        this.notify(renderNotification(job, summary));
        resolve();
      });
    });
    return job;
  }

  // ------------------------------------------------------------ 停止

  async stop(jobId: string): Promise<Job | undefined> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.status !== "running") return job;
    job.stopRequested = true;
    if (job.proc !== null) this.killGroup(job);
    const stop = job.extra.stop; // 异步任务（sub agent）自己提供停止方法
    if (stop) stop();
    await job.wait(5);
    if (job.status === "running") {
      job.status = "killed";
      job.ended = Date.now() / 1000;
    }
    return job;
  }

  async stopAll(): Promise<void> {
    for (const job of this.running()) await this.stop(job.id);
  }
}
