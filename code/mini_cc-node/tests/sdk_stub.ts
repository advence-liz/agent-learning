/**
 * 一个假的 @anthropic-ai/sdk 对象：只实现 AnthropicClient 用到的那几个方法，用来测适配层。不联网。
 *
 * 真实 SDK 的 messages.stream() 返回一个 MessageStream：for await 迭代出原始 SSE 事件，
 * finalMessage() 给出累积好的整条消息。这里按同样的形状造数据。
 */

import type { SdkLike, StreamLike } from "../mini_cc/model.ts";

class Stream implements StreamLike {
  private events: any[];
  private final: any;
  private error: Error | undefined;

  constructor(events: any[], final: any, error?: Error) {
    this.events = events;
    this.final = final;
    this.error = error;
  }

  async *[Symbol.asyncIterator]() {
    for (const e of this.events) yield e;
    if (this.error) throw this.error;
  }

  async finalMessage() {
    return this.final;
  }
}

/** stub.messages.stream(kw) 依次返回 responses 里的结果；收到的参数存在 calls。 */
export class StubSDK implements SdkLike {
  responses: Array<Stream | Error>;
  calls: any[] = [];
  messages = { stream: (kw: any) => this.stream(kw) };
  beta = { messages: { stream: (kw: any) => this.stream(kw) } };

  constructor(responses: Array<Stream | Error>) {
    this.responses = [...responses];
  }

  private stream(kw: any): Stream {
    this.calls.push(kw);
    const r = this.responses.shift()!;
    if (r instanceof Error) throw r;
    return r;
  }
}

const delta = (index: number, d: any) => ({ type: "content_block_delta", index, delta: d });

export function textStream(text: string, { stopReason = "end_turn", thinking, error }:
  { stopReason?: string; thinking?: string; error?: Error } = {}): Stream {
  const events: any[] = [];
  const blocks: any[] = [];
  if (thinking) {
    events.push(delta(0, { type: "thinking_delta", thinking }));
    blocks.push({ type: "thinking", thinking, signature: "sig" });
  }
  const i = blocks.length;
  events.push(delta(i, { type: "text_delta", text: text.slice(0, 3) }), delta(i, { type: "text_delta", text: text.slice(3) }));
  blocks.push({ type: "text", text });
  const final = { content: blocks, stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } };
  return new Stream(events, final, error);
}
