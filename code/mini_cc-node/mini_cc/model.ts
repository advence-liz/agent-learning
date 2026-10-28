/**
 * 模型层：把「调 LLM」收敛成一个很窄的接口，让 agent 循环不认识 @anthropic-ai/sdk。（第 1–3、6、9 章）
 *
 * - ModelRequest：循环发给模型的全部数据，content 一律是纯对象（能直接 JSON.stringify 落盘，也能原样回传 API）。
 * - ModelClient.stream()：产出 TextDelta / ThinkingDelta，最后一定产出一个 MessageDone。
 * - complete()：不关心中间过程时（auto 模式的审查员、第 14 章的压缩）用它一次拿到结果。
 * - AnthropicClient 走真实 API；FakeClient 按脚本回放，测试和 --fake 演示都用它。
 */

import { readFileSync } from "node:fs";
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";

export type Block = Record<string, any>;
export interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface ModelRequest {
  system: Block[];
  messages: Message[];
  tools?: Block[];
  maxTokens?: number;
  // 透传给 API 的 output_config（effort / 结构化输出 format）
  outputConfig?: Record<string, any> | null;
  // null = 不传；循环里默认 adaptive + summarized，让终端能看到思考摘要
  thinking?: Record<string, any> | null;
  // 第 9 章：顶层自动缓存——缓存到最后一个可缓存块（agent 循环里历史只增不改，前缀几乎总能命中）
  cache?: boolean;
}

// ---------------------------------------------------------------- 流式事件

export interface TextDelta {
  type: "TextDelta";
  text: string;
}
export interface ThinkingDelta {
  type: "ThinkingDelta";
  text: string;
}
export interface MessageDone {
  type: "MessageDone";
  content: Block[];
  stopReason: string;
  usage: Record<string, any>;
}
export type ModelEvent = TextDelta | ThinkingDelta | MessageDone;

/** 模型调用失败。retryable 决定循环要不要重试；kind 给人看，也给测试断言。 */
export class ModelError extends Error {
  override name = "ModelError";
  retryable: boolean;
  kind: string;
  status: number | null;
  retryAfter: number | null;

  constructor(
    message: string,
    { retryable, kind = "api", status = null, retryAfter = null }:
      { retryable: boolean; kind?: string; status?: number | null; retryAfter?: number | null },
  ) {
    super(message);
    this.retryable = retryable;
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** 把 SDK 异常翻译成 ModelError。顺序从具体到宽泛：先判网络错误（它们没有状态码），再判状态码。 */
export function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  if (e instanceof APIConnectionError) {
    // 含 APIConnectionTimeoutError
    return new ModelError(`network: ${e.message}`, { retryable: true, kind: "network" });
  }
  if (e instanceof APIError && typeof e.status === "number") {
    const status = e.status;
    const ra = e.headers?.get("retry-after");
    const retryAfter = ra && /^\d+(\.\d+)?$/.test(ra) ? Number(ra) : null;
    // 408 超时 / 409 冲突 / 429 限流 / 5xx（含 529 overloaded）可以重试；其余 4xx 重试也没用
    const retryable = [408, 409, 429].includes(status) || status >= 500;
    const kinds: Record<number, string> = {
      401: "auth", 403: "permission", 404: "not_found", 413: "too_large", 429: "rate_limit", 529: "overloaded",
    };
    const kind = kinds[status] ?? (status >= 500 ? "server" : "bad_request");
    // SDK 的 message 已经是「529 Overloaded」这种带状态码的形式
    const msg = e.message.startsWith(String(status)) ? e.message : `${status} ${e.message}`;
    return new ModelError(msg, { retryable, kind, status, retryAfter });
  }
  if (e instanceof SyntaxError) {
    // eager_input_streaming 下 SDK 解析不了工具参数 JSON 时，从流迭代器里抛 SyntaxError（JSON.parse）：重发这一轮
    return new ModelError(`invalid tool input json: ${e.message}`, { retryable: true, kind: "invalid_json" });
  }
  const err = e as Error;
  return new ModelError(`${err?.name ?? "Error"}: ${err?.message ?? String(e)}`, { retryable: false, kind: "unknown" });
}

export interface ModelClient {
  model: string;
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
}

/** 把流消费完，只要最终消息。 */
export async function complete(client: ModelClient, req: ModelRequest): Promise<MessageDone> {
  let done: MessageDone | null = null;
  for await (const ev of client.stream(req)) {
    if (ev.type === "MessageDone") done = ev;
  }
  if (done === null) throw new Error("model stream ended without a final message");
  return done;
}

// ---------------------------------------------------------------- 真实客户端

/** SDK 里我们用到的那一小块；测试里用 tests/sdk_stub.ts 的假对象顶替。 */
export interface SdkLike {
  messages: { stream(params: any): StreamLike };
  beta: { messages: { stream(params: any): StreamLike } };
}
export interface StreamLike extends AsyncIterable<any> {
  finalMessage(): Promise<any>;
}

/** 直接用 @anthropic-ai/sdk。ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 由 SDK 自己读环境变量。 */
export class AnthropicClient implements ModelClient {
  static FALLBACK_BETA = "server-side-fallback-2026-07-01";
  model: string;
  fallbacks: boolean;
  private sdk: SdkLike;

  constructor(model: string, { sdkClient, fallbacks = true }: { sdkClient?: SdkLike; fallbacks?: boolean } = {}) {
    this.model = model;
    // maxRetries: 0：重试由 agent 循环自己做（第 3 章），这样每次重试 UI 都看得见
    this.sdk = sdkClient ?? (new Anthropic({ maxRetries: 0 }) as unknown as SdkLike);
    // 服务端 fallback：模型因安全分类器拒答（stop_reason=refusal）时，API 在同一次调用里换模型重跑。
    // 走中转站不支持这个 beta 时，设 MINI_CC_FALLBACKS=0 关掉
    this.fallbacks = fallbacks;
  }

  kwargs(req: ModelRequest): Record<string, any> {
    const kwargs: Record<string, any> = {
      model: this.model, max_tokens: req.maxTokens ?? 64000, system: req.system, messages: req.messages,
    };
    if (req.tools?.length) {
      // eager_input_streaming：工具参数（比如 Write 的整份文件内容）边生成边流过来，
      // 代价是服务端不再校验参数 → 第 3 章在执行前自己校验
      kwargs.tools = req.tools.map((t) => ({ ...t, eager_input_streaming: true }));
    }
    if (req.outputConfig) kwargs.output_config = req.outputConfig;
    if (req.thinking) kwargs.thinking = req.thinking;
    if (req.cache) kwargs.cache_control = { type: "ephemeral" };
    return kwargs;
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const kwargs = this.kwargs(req);
    let final: any;
    try {
      const s = this.fallbacks
        ? this.sdk.beta.messages.stream({ ...kwargs, betas: [AnthropicClient.FALLBACK_BETA], fallbacks: "default" })
        : this.sdk.messages.stream(kwargs);
      // Node SDK 的 MessageStream 迭代出来的是原始 SSE 事件；文本和思考增量在 content_block_delta 里
      for await (const ev of s) {
        if (ev.type !== "content_block_delta") continue;
        if (ev.delta.type === "text_delta") yield { type: "TextDelta", text: ev.delta.text };
        else if (ev.delta.type === "thinking_delta") yield { type: "ThinkingDelta", text: ev.delta.thinking };
      }
      final = await s.finalMessage();
    } catch (e) {
      throw toModelError(e); // 统一翻译，由循环决定重试与否
    }
    yield {
      type: "MessageDone",
      // 转成纯对象：SDK 的 tool_use.input 是惰性 getter，JSON 往返一次就固定下来
      content: JSON.parse(JSON.stringify(final.content)),
      stopReason: final.stop_reason,
      usage: JSON.parse(JSON.stringify(final.usage)),
    };
  }
}

// ---------------------------------------------------------------- 测试替身

let nextId = 1;

export function textBlock(text: string): Block {
  return { type: "text", text };
}

export function toolBlock(name: string, input: Record<string, any>, id?: string): Block {
  return { type: "tool_use", id: id ?? `toolu_fake_${String(nextId++).padStart(3, "0")}`, name, input };
}

/** FakeClient 的一步脚本：模型这一次「会」回什么。 */
export class FakeTurn {
  content: Block[];
  stopReason: string | null; // null → 有 tool_use 就是 tool_use，否则 end_turn
  usage: Record<string, number>;
  // 流到第几个字符时抛出 failWith（模拟网络中途断开），null 表示不出错
  failAfter: number | null;
  failWith: Error | null;

  constructor(
    content: Block[],
    { stopReason = null, usage = { input_tokens: 100, output_tokens: 20 }, failAfter = null, failWith = null }:
      { stopReason?: string | null; usage?: Record<string, number>; failAfter?: number | null; failWith?: Error | null } = {},
  ) {
    this.content = content;
    this.stopReason = stopReason;
    this.usage = usage;
    this.failAfter = failAfter;
    this.failWith = failWith;
  }

  resolvedStopReason(): string {
    if (this.stopReason) return this.stopReason;
    return this.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  }
}

export function say(text: string, thinking?: string): FakeTurn {
  const blocks = thinking ? [{ type: "thinking", thinking, signature: "fake-sig" }] : [];
  return new FakeTurn([...blocks, textBlock(text)]);
}

export function call(name: string, input: Record<string, any>, text?: string, id?: string): FakeTurn {
  const blocks = text ? [textBlock(text)] : [];
  return new FakeTurn([...blocks, toolBlock(name, input, id)]);
}

/** 一次回复里并行调多个工具。 */
export function calls(pairs: Array<[string, Record<string, any>]>, text?: string): FakeTurn {
  const blocks = text ? [textBlock(text)] : [];
  return new FakeTurn([...blocks, ...pairs.map(([n, i]) => toolBlock(n, i))]);
}

export type Script = FakeTurn | Error | ((req: ModelRequest) => FakeTurn);

/** 按脚本回放的模型。每次 stream() 弹出一步；同时把收到的请求存进 this.requests 供断言。 */
export class FakeClient implements ModelClient {
  static CHUNK = 4; // 每个文本增量的字符数，模拟 token 一点点流出来

  script: Script[];
  // 剧本放完之后，如果有 responder 就一直用它回答（比如 auto 模式的假审查员）
  responder: ((req: ModelRequest) => FakeTurn) | null;
  requests: ModelRequest[] = [];
  model: string;
  // 第 21 章：离线剧本里的 {name} 占位符（比如 {plan_file}），发出前替换成运行时的值（值可以是函数）
  vars: Record<string, unknown> = {};
  // 第 17 章：--fake 剧本里给 sub agent 单独写的台词（按 Agent 工具的 description 查）
  agentClients: Record<string, FakeClient> = {};

  constructor(
    script: Script[] = [],
    { model = "fake-model", responder = null }: { model?: string; responder?: ((req: ModelRequest) => FakeTurn) | null } = {},
  ) {
    this.script = [...script];
    this.responder = responder;
    this.model = model;
  }

  push(...turns: Script[]): void {
    this.script.push(...turns);
  }

  /**
   * 离线演示用：从 JSON 读脚本。每项是 {"say": 文本, "thinking": 可选} / {"call": 工具名, "input": {...}, "text": 可选}
   * / {"calls": [...]} / {"error": kind}；每项可以带 "usage"（第 14 章：演示「上下文快满了」）。
   */
  static fromJson(path: string): FakeClient {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data)) {
      // 第 17 章：{"main": [...], "agents": {"<description>": [...]}}：sub agent 各用各的剧本
      const client = FakeClient.fromItems(data.main);
      for (const [k, v] of Object.entries(data.agents ?? {})) client.agentClients[k] = FakeClient.fromItems(v as any[]);
      return client;
    }
    return FakeClient.fromItems(data);
  }

  private static fromItems(items: Array<Record<string, any>>): FakeClient {
    const turns: Script[] = [];
    for (const item of items) {
      if ("error" in item) {
        // {"error": "overloaded"} / {"error": "auth"}：模拟 API 失败
        const k = item.error;
        turns.push(new ModelError(item.message ?? k, { retryable: ["overloaded", "rate_limit", "network"].includes(k), kind: k }));
      } else if ("calls" in item) {
        turns.push(calls(item.calls.map((c: any) => [c.call, c.input ?? {}]), item.text));
      } else if ("call" in item) {
        turns.push(call(item.call, item.input ?? {}, item.text));
      } else {
        turns.push(say(item.say, item.thinking));
      }
      const last = turns.at(-1);
      if ("usage" in item && last instanceof FakeTurn) last.usage = { output_tokens: 20, ...item.usage };
    }
    return new FakeClient(turns);
  }

  private next(req: ModelRequest): FakeTurn {
    this.requests.push(structuredClone(req));
    const step = this.script.shift();
    if (step === undefined) {
      if (this.responder) return this.responder(req);
      throw new Error("FakeClient: 脚本已经放完了，但循环还在请求模型");
    }
    if (step instanceof Error) throw step;
    const turn = typeof step === "function" ? step(req) : step;
    return Object.keys(this.vars).length ? this.fill(turn) : turn;
  }

  private fill(turn: FakeTurn): FakeTurn {
    const sub = (v: any): any => {
      if (typeof v === "string") {
        for (const [k, val] of Object.entries(this.vars)) {
          v = v.replaceAll(`{${k}}`, String(typeof val === "function" ? val() : val));
        }
        return v;
      }
      if (Array.isArray(v)) return v.map(sub);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
      return v;
    };
    return new FakeTurn(sub(turn.content), {
      stopReason: turn.stopReason, usage: turn.usage, failAfter: turn.failAfter, failWith: turn.failWith,
    });
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const turn = this.next(req);
    const fail = () => turn.failWith ?? new Error("fake stream failure");
    let sent = 0;
    for (const b of turn.content) {
      const key = b.type === "text" ? "text" : b.type === "thinking" ? "thinking" : null;
      if (key === null) continue;
      const chars = Array.from(b[key] as string); // 按字符（code point）切，不切坏 emoji
      for (let i = 0; i < chars.length; i += FakeClient.CHUNK) {
        if (turn.failAfter !== null && sent >= turn.failAfter) throw fail();
        const piece = chars.slice(i, i + FakeClient.CHUNK).join("");
        sent += i + FakeClient.CHUNK > chars.length ? chars.length - i : FakeClient.CHUNK;
        yield key === "text" ? { type: "TextDelta", text: piece } : { type: "ThinkingDelta", text: piece };
      }
    }
    if (turn.failAfter !== null && sent >= turn.failAfter) throw fail();
    yield { type: "MessageDone", content: structuredClone(turn.content), stopReason: turn.resolvedStopReason(), usage: { ...turn.usage } };
  }
}
