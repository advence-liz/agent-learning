/**
 * Agent 循环：请求模型 → 有 tool_use 就执行 → 把结果塞回去 → 再请求，直到模型不再调工具。（第 1–5、9、11、14 章）
 *
 * 第 2 章起，循环是一个异步生成器（async function*）：每发生一件事就 yield 一个事件，调用方（UI）边收边画。
 * Python 版是同步生成器；Node 里模型调用、子进程都是异步的，所以这里是 async 版，用法从 for 换成 for await。
 */

import { mergeConsecutiveUsers } from "./compact.ts";
import { ContextBuilder } from "./context.ts";
import type { Settings } from "./config.ts";
import {
  type ContextInjected, type Event, notice, type PermissionDecision, type TasksUpdated, type ToolStart, type TurnEnd, turnEnd,
} from "./events.ts";
import { type Block, type Message, type MessageDone, type ModelClient, ModelError, type ModelRequest } from "./model.ts";
import { deniedMessage, PermissionManager, type PermissionReply, type PermissionRequest } from "./permissions.ts";
import { RetryPolicy } from "./retry.ts";
import { type ToolRegistry, ToolContext, ToolResult } from "./tools/index.ts";

export const SYSTEM_PROMPT =
  "You are mini-cc, a coding agent running in the user's terminal. " +
  "Use the tools to inspect and change the project. Be concise.";

/** 累计 token 用量；lastInput 是最近一次请求的输入规模 ≈ 当前上下文大小。 */
export class Usage {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadInputTokens = 0;
  cacheCreationInputTokens = 0;
  lastInput = 0;
  requests = 0;

  add(u: Record<string, any>): void {
    const n = (k: string) => Number(u[k] ?? 0) || 0;
    this.requests++;
    this.inputTokens += n("input_tokens");
    this.outputTokens += n("output_tokens");
    this.cacheReadInputTokens += n("cache_read_input_tokens");
    this.cacheCreationInputTokens += n("cache_creation_input_tokens");
    this.lastInput = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  }
}

export class TurnResult {
  text: string;
  events: Event[];

  constructor(text: string, events: Event[] = []) {
    this.text = text;
    this.events = events;
  }

  get steps(): string[] {
    return this.events.filter((e): e is ToolStart => e.type === "ToolStart").map((e) => e.summary);
  }
}

export type Listener = (msg: Message, meta: Record<string, any>) => void;
export type Approver = (req: PermissionRequest) => PermissionReply | Promise<PermissionReply>;
type HookResult = Event[] | null | void | Promise<Event[] | null | void>;
type ToolUse = { id: string; name: string; input: Record<string, any> };

export class Agent {
  client: ModelClient;
  tools: ToolRegistry;
  settings: Settings;
  messages: Message[] = [];
  usage = new Usage();
  ctx: ToolContext;
  retry: RetryPolicy;
  sleep: (seconds: number) => void | Promise<void> = (s) => new Promise((r) => setTimeout(r, s * 1000)); // 测试里换成记录器，不真睡
  // 每往历史里追加一条消息就通知一遍（第 4 章：落盘；第 13 章 rewind 也会订阅）
  listeners: Listener[] = [];
  // 第 5 章：权限。approver 由 UI 提供（弹窗问用户）；没有 approver（比如 -p 模式）时一律拒绝
  permissions: PermissionManager;
  approver: Approver | null = null;
  // 第 9 章：上下文组装与注入；notifications 是「待送达消息」队列（第 16–18 章往里放）
  context: ContextBuilder;
  notifications: string[] = [];
  // 给后续章节的生命周期钩子（返回要转发给 UI 的事件列表，或 null）：
  //   beforeRequest：每次请求模型之前（第 14 章自动压缩：上下文快满时先压缩再请求）
  //   turnEnd：一轮结束时（第 12 章记忆提取等）
  beforeRequest: Array<(agent: Agent) => HookResult> = [];
  turnEnd: Array<(agent: Agent, end: TurnEnd) => HookResult> = [];

  constructor(client: ModelClient, tools: ToolRegistry, settings: Settings) {
    this.client = client;
    this.tools = tools;
    this.settings = settings;
    this.ctx = new ToolContext(settings.cwd);
    this.retry = new RetryPolicy(settings.maxRetries, settings.retryBaseDelay, settings.retryMaxDelay);
    this.permissions = new PermissionManager(settings.cwd);
    this.context = ContextBuilder.default(this, settings.home);
  }

  /**
   * 任何地方都可以调用：消息会在下一次 user 消息（用户发话或工具结果）里送达模型。
   * Node 是单线程事件循环，后台子进程 / 定时器的回调和循环交替执行，一个数组就够了（Python 版用线程安全的 queue.Queue）。
   */
  notify(text: string): void {
    this.notifications.push(text);
  }

  drainNotifications(): string[] {
    return this.notifications.splice(0);
  }

  /** 追加一条 user 消息，顺带把本轮该注入的上下文并进去。 */
  private async *appendUser(content: string | Block[], trigger: "user" | "tool_result"): AsyncGenerator<Event> {
    const [merged, atts] = await this.context.inject(content, trigger);
    for (const a of atts) yield { type: "ContextInjected", kind: a.kind, title: a.title } satisfies ContextInjected;
    this.append({ role: "user", content: merged });
  }

  /** 历史的唯一写入口。只追加、不修改——这条规矩让持久化、prompt cache、thinking 校验都简单。 */
  append(msg: Message, meta: Record<string, any> = {}): void {
    this.messages.push(msg);
    for (const fn of this.listeners) fn(msg, meta);
  }

  /** 恢复会话：直接换掉历史（不触发 listeners，因为这些消息已经在磁盘上了）。 */
  loadHistory(messages: Message[], usage?: Usage): void {
    this.messages = [...messages];
    this.usage = usage ?? new Usage();
    this.repairHistory();
  }

  reset(): void {
    this.messages = [];
    this.usage = new Usage();
  }

  request(): ModelRequest {
    return {
      system: this.context.systemBlocks(),
      // 第 14 章：压缩后「摘要 + 下一条提示词」是两条相邻的 user 消息，请求时合并（不改历史）
      messages: mergeConsecutiveUsers(this.messages),
      tools: this.tools.schemas(),
      maxTokens: this.settings.maxTokens,
      outputConfig: { effort: this.settings.effort },
      thinking: { type: "adaptive", display: "summarized" },
      cache: true,
    };
  }

  // ------------------------------------------------------------ 一次模型调用

  /**
   * 流式调用模型，带重试。增量原样往外转发，最后交出 MessageDone。
   *
   * 重试是安全的，因为历史只在 MessageDone 之后才写入：失败那次流出去的半截文字只上了屏幕，
   * 没有进 this.messages。
   */
  private async *callModel(): AsyncGenerator<Event | MessageDone> {
    let attempt = 0;
    for (;;) {
      let streamed = false;
      try {
        for await (const ev of this.client.stream(this.request())) {
          if (ev.type !== "MessageDone") streamed = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (!(e instanceof ModelError)) throw e;
        attempt++;
        if (!this.retry.shouldRetry(attempt, e)) throw e;
        const delay = this.retry.delay(attempt, e);
        const cut = streamed ? "（上面的输出不完整，已丢弃）" : "";
        yield notice(`${cut}模型请求失败：${e.message}；${delay.toFixed(1)}s 后第 ${attempt}/${this.retry.maxRetries} 次重试`, "warn");
        await this.sleep(delay);
      }
    }
  }

  // ------------------------------------------------------------ 执行工具

  /** 权限关卡。生成器的返回值是 [是否放行, 拒绝时给模型的结果, 是否结束本轮]。 */
  private async *authorize(tu: ToolUse): AsyncGenerator<Event, [boolean, ToolResult | null, boolean]> {
    const tool = this.tools.get(tu.name)!;
    const d = await this.permissions.decide(tool, tu.input);
    const summary = tool.summary(tu.input);
    const decision = (behavior: "allow" | "deny", reason: string, source: string): PermissionDecision =>
      ({ type: "PermissionDecision", toolId: tu.id, summary, behavior, reason, source });
    if (d.behavior === "allow") {
      if (d.source === "classifier") yield decision("allow", d.reason, d.source);
      return [true, null, false];
    }
    if (d.behavior === "deny") {
      yield decision("deny", d.reason, d.source);
      return [false, new ToolResult(`Permission denied: ${d.reason}. This call was NOT executed.`, true), false];
    }
    // ask：停下来问用户（生成器在这里 await approver，直到用户按下数字）
    const req: PermissionRequest = { tool, args: tu.input, summary, ruleKey: tool.ruleKey(tu.input), reason: d.reason };
    const reply: PermissionReply = this.approver ? await this.approver(req) : { choice: "deny", feedback: "" };
    if (reply.choice === "once" || reply.choice === "always") {
      if (reply.choice === "always") this.permissions.remember(req);
      yield decision("allow", `user approved (${reply.choice})`, "user");
      return [true, null, false];
    }
    yield decision("deny", "user rejected", "user");
    // 没给理由的拒绝 = 「先停下，等我说」；给了理由就让模型带着理由继续
    return [false, new ToolResult(deniedMessage(reply.feedback), true), !reply.feedback];
  }

  /** 执行一批工具调用。生成器返回 true 表示本轮应当结束（用户拒绝且没给理由）。 */
  private async *runTools(toolUses: ToolUse[]): AsyncGenerator<Event, boolean> {
    const results: Block[] = [];
    let stop = false;
    let lastTasks: TasksUpdated | null = null;
    for (const tu of toolUses) {
      const tool = this.tools.get(tu.name);
      yield { type: "ToolStart", id: tu.id, name: tu.name, input: tu.input, summary: tool ? tool.summary(tu.input) : tu.name };
      const bad = this.tools.checkInput(tu.name, tu.input);
      let r: ToolResult;
      if (bad !== null) {
        r = bad;
      } else if (stop) {
        r = new ToolResult("Skipped: an earlier tool call in this batch was rejected by the user.", true);
      } else {
        const [ok, denied, stopNow] = yield* this.authorize(tu);
        stop = stop || stopNow;
        if (ok) {
          this.ctx.toolUseId = tu.id;
          r = await this.tools.execute(tu.name, tu.input, this.ctx, this.settings.maxToolOutput);
        } else {
          r = denied!;
        }
      }
      yield { type: "ToolEnd", id: tu.id, name: tu.name, result: r };
      for (const ev of this.ctx.pendingEvents.splice(0)) { // 工具执行期间攒下的事件
        if (ev.type === "TasksUpdated") lastTasks = ev; // 一批里多次改清单，只在批末显示最终状态
        else yield ev;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError });
    }
    if (lastTasks !== null) yield lastTasks;
    // 第 20 章：tool_result 必须排在 user 消息最前面，工具追加的文本（skill 正文）放在全部结果之后
    results.push(...this.ctx.followupBlocks.splice(0));
    // 同一条 assistant 里的多个 tool_use，结果必须放进同一条 user 消息（注入的提醒排在 tool_result 之后）
    yield* this.appendUser(results, "tool_result");
    return stop;
  }

  // ------------------------------------------------------------ 一轮对话

  /** 主循环 + 最后一道安全网：无论里面出什么事，这个生成器都不会抛异常，历史也保持合法。 */
  async *runTurn(prompt: string | Block[]): AsyncGenerator<Event> {
    try {
      yield* this.appendUser(prompt, "user");
      yield* this.loop();
    } catch (err) {
      if (err instanceof ModelError) {
        yield notice(`模型请求失败（${err.kind}）：${err.message}`, "error");
      } else {
        // 安全网：未知异常也不能让 REPL 退出
        const e = err as Error;
        yield notice(`内部错误：${e?.name ?? "Error"}: ${e?.message ?? String(err)}`, "error");
      }
      yield turnEnd("error", "");
    } finally {
      // 包括调用方提前 return()（Ctrl+C 中断 / break 出 for await）：补齐悬空的 tool_use
      this.repairHistory();
    }
  }

  private async *hooks<A extends unknown[]>(hooks: Array<(agent: Agent, ...args: A) => HookResult>, ...args: A): AsyncGenerator<Event> {
    for (const fn of hooks) yield* (await fn(this, ...args)) ?? [];
  }

  private async *loop(): AsyncGenerator<Event> {
    for await (const ev of this.steps()) {
      if (ev.type === "TurnEnd") yield* this.hooks(this.turnEnd, ev);
      yield ev;
    }
  }

  private async *steps(): AsyncGenerator<Event> {
    for (let i = 0; i < this.settings.maxIterations; i++) {
      yield* this.hooks(this.beforeRequest);
      let done: MessageDone | null = null;
      for await (const ev of this.callModel()) {
        if (ev.type === "MessageDone") done = ev;
        else yield ev;
      }
      if (done === null) throw new Error("model stream ended without a final message");
      this.usage.add(done.usage);
      // 整个 content 原样存回历史（thinking 块要原样回传，不能只留文本）
      this.append({ role: "assistant", content: done.content }, { usage: done.usage });
      const toolUses = done.content.filter((b) => b.type === "tool_use") as ToolUse[];
      const text = done.content.filter((b) => b.type === "text").map((b) => b.text).join("");

      if (done.stopReason === "refusal") {
        yield notice("模型拒绝了这个请求（stop_reason=refusal）", "error");
        yield turnEnd("refusal", text);
        return;
      }
      if (done.stopReason === "max_tokens" && toolUses.length) {
        // 参数被截断的工具调用绝不能执行；告诉模型原因，让它分小块重来
        yield notice("输出触到 max_tokens，工具参数可能被截断，已跳过执行", "warn");
        this.appendErrorResults(toolUses, "Output hit max_tokens; this tool input may be truncated " +
          "and was NOT executed. Retry with smaller pieces.");
        continue;
      }
      if (done.stopReason === "pause_turn") continue; // 服务端工具（web search 等）跑太久时会暂停，原样续上即可
      if (done.stopReason !== "tool_use" || !toolUses.length) {
        yield turnEnd(done.stopReason, text);
        return;
      }
      if (yield* this.runTools(toolUses)) {
        yield turnEnd("denied", "");
        return;
      }
    }
    yield notice(`达到单轮上限 ${this.settings.maxIterations} 次模型调用，已停止`, "warn");
    yield turnEnd("max_iterations", "");
  }

  // ------------------------------------------------------------ 历史一致性

  private appendErrorResults(toolUses: ToolUse[], msg: string): void {
    this.append({
      role: "user",
      content: toolUses.map((tu) => ({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true })),
    });
  }

  /** API 要求每个 tool_use 后面紧跟对应的 tool_result。被打断时补上，否则下一次请求必然 400。 */
  repairHistory(): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
    const pending = last.content.filter((b) => b.type === "tool_use") as ToolUse[];
    if (pending.length) this.appendErrorResults(pending, "Interrupted by user before this tool finished.");
  }

  /** 不需要实时输出时的便捷封装：把事件攒起来一次返回。 */
  async run(prompt: string): Promise<TurnResult> {
    const events: Event[] = [];
    for await (const ev of this.runTurn(prompt)) events.push(ev);
    const end = events.at(-1);
    return new TurnResult(end?.type === "TurnEnd" ? end.text : "", events);
  }
}
