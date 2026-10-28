/**
 * 离线 fake 模型：按脚本返回预设响应，形状与 @anthropic-ai/sdk 的真实 Message 完全一致。
 *
 * 用法：
 *   const client = new FakeAnthropic([text("你好"), toolUse("read_file", { path: "a.ts" })]);
 *   await client.messages.create({ model: ..., messages: [...] });   // 依次弹出脚本里的响应
 *
 * 每次调用的入参都记在 client.calls 里，测试可以断言「模型这一轮到底看到了什么」。
 * 真实环境下把 FakeAnthropic 换成 new Anthropic() 即可，业务代码一行不改。
 */

import type Anthropic from "@anthropic-ai/sdk";

export type Message = Anthropic.Message;
export type ContentBlock = Anthropic.ContentBlock;
export type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/** agent 只依赖这一个方法；真实的 new Anthropic() 和 FakeAnthropic 都满足它。 */
export interface LLMClient {
  messages: { create(params: CreateParams): PromiseLike<Message> };
}

/** 脚本里的一步：只写关心的字段，其余由 FakeAnthropic 补成完整的 Message。 */
export interface Step {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "thinking"; thinking: string; signature: string }
  >;
  stop_reason: NonNullable<Message["stop_reason"]>;
  usage: { input_tokens: number; output_tokens: number };
}

export type Script = Array<Step | ((params: CreateParams) => Step)>;

let nextId = 1;

/** 一条纯文本回复（stop_reason=end_turn）。 */
export function text(s: string, { inputTokens = 50, outputTokens = 20 } = {}): Step {
  return {
    content: [{ type: "text", text: s }],
    stop_reason: "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/** 一条工具调用回复（stop_reason=tool_use），可选先说一句话。 */
export function toolUse(
  name: string,
  args: Record<string, unknown>,
  { say, inputTokens = 50, outputTokens = 30 }: { say?: string; inputTokens?: number; outputTokens?: number } = {},
): Step {
  const content: Step["content"] = [];
  if (say) content.push({ type: "text", text: say });
  content.push({ type: "tool_use", id: `toolu_${String(nextId++).padStart(4, "0")}`, name, input: args });
  return { content, stop_reason: "tool_use", usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

export class FakeAnthropic implements LLMClient {
  script: Script;
  calls: CreateParams[] = [];
  latency: number;
  messages: { create: (params: CreateParams) => Promise<Message> };

  constructor(script: Script, { latency = 0 } = {}) {
    this.script = [...script];
    this.latency = latency;
    this.messages = { create: (params) => this.create(params) };
  }

  private async create(params: CreateParams): Promise<Message> {
    // 深拷贝：调用方之后再 push messages，不影响我们记录的「当时那一刻」
    this.calls.push(structuredClone(params));
    let step = this.script.shift();
    if (!step) throw new Error("FakeAnthropic: 脚本已用完，agent 多调用了一次模型");
    if (this.latency) await new Promise((r) => setTimeout(r, this.latency * 1000)); // 模拟网络+推理耗时
    if (typeof step === "function") step = step(params); // 允许根据请求动态决定响应
    return toMessage(step, params.model, this.calls.length);
  }
}

/** 把脚本里的简写补成 SDK 的完整 Message：没写的字段一律按真实响应的默认值填 null。 */
function toMessage(step: Step, model: string, n: number): Message {
  const content = step.content.map((b): ContentBlock => {
    if (b.type === "text") return { ...b, citations: null };
    if (b.type === "tool_use") return { ...b, caller: { type: "direct" } };
    return b;
  });
  return {
    id: `msg_fake_${String(n).padStart(3, "0")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: step.stop_reason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: {
      ...step.usage,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

/** 有 script 就返回 fake；否则返回真实 client（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。 */
export async function makeClient(script?: Script): Promise<LLMClient> {
  if (script) return new FakeAnthropic(script);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic();
}
