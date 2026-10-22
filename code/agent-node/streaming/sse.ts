/**
 * 第 9 章：手写 SSE 解析 + 流式消息拼装（含 tool_use 参数的 input_json_delta 拼接）。
 *
 * fixture.sse 是按 Messages API 流式事件格式手工构造的一段响应（离线，不是真实录制），
 * 和 Python 版共用同一个文件：code/agent/streaming/fixture.sse。
 *   node streaming/sse.ts            # 逐事件回放，打印拼装过程
 *   node streaming/sse.ts --sdk      # 同一段字节喂给真实 @anthropic-ai/sdk（自定义 fetch），对比结果
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";

export const FIXTURE = join(import.meta.dirname, "..", "..", "agent", "streaming", "fixture.sse");

type Event = Record<string, any>;

// ---------- 1. SSE 帧解析：空行分隔事件，每行 "field: value" ----------
export function* parseSse(lines: Iterable<string>): Generator<[string, Event]> {
  let event = "message";
  let data: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r?\n$/, "");
    if (line === "") {
      // 空行 = 一个事件结束
      if (data.length) yield [event, JSON.parse(data.join("\n"))];
      [event, data] = ["message", []];
    } else if (line.startsWith(":")) {
      continue; // 注释行（常被用作心跳）
    } else {
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      let value = i === -1 ? "" : line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value); // 多行 data 要用 \n 拼回去
    }
  }
  if (data.length) yield [event, JSON.parse(data.join("\n"))];
}

/** 网络 chunk 的边界和事件边界无关（可能切在一个汉字的 UTF-8 字节中间），先按行重组。 */
export function* linesFromChunks(chunks: Iterable<Uint8Array>): Generator<string> {
  let buf = Buffer.alloc(0);
  for (const c of chunks) {
    buf = Buffer.concat([buf, c]);
    let nl: number;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      // 按字节找 \n，整行凑齐了才解码，所以不会把一个汉字解成两半
      yield buf.subarray(0, nl).toString("utf8") + "\n";
      buf = buf.subarray(nl + 1);
    }
  }
  if (buf.length) yield buf.toString("utf8");
}

/** 把文件按行切开（保留行尾 \n），相当于 Python 里直接迭代文件对象。 */
export function fileLines(path = FIXTURE): string[] {
  return readFileSync(path, "utf8").split(/(?<=\n)/);
}

// ---------- 2. 事件 → 完整消息 ----------
export class Accumulator {
  message: Record<string, any> = {};
  private jsonBuf = new Map<number, string>(); // index → 尚未闭合的 tool 参数 JSON 片段

  /** 吃一个事件；返回一句人类可读的说明（演示用）。 */
  feed(ev: Event): string | null {
    const t = ev.type;
    if (t === "message_start") {
      this.message = ev.message;
      return `开始 id=${this.message.id} input_tokens=${this.message.usage.input_tokens}`;
    }
    if (t === "content_block_start") {
      const block = { ...ev.content_block };
      this.message.content.push(block); // index 就是它在 content 里的位置
      if (block.type === "tool_use") {
        this.jsonBuf.set(ev.index, "");
        return `[${ev.index}] tool_use 开始 name=${block.name}（参数还没来）`;
      }
      return `[${ev.index}] ${block.type} 块开始`;
    }
    if (t === "content_block_delta") {
      const [i, d] = [ev.index as number, ev.delta];
      const block = this.message.content[i];
      if (d.type === "text_delta") {
        block.text += d.text;
        return `[${i}] +${JSON.stringify(d.text).padEnd(14)} → ${block.text}`;
      }
      if (d.type === "input_json_delta") {
        const buf = this.jsonBuf.get(i)! + d.partial_json;
        this.jsonBuf.set(i, buf);
        return `[${i}] +${JSON.stringify(d.partial_json).padEnd(32)} 缓冲区能解析吗？${parses(buf)}`;
      }
      if (d.type === "thinking_delta") block.thinking += d.thinking;
      else if (d.type === "signature_delta") block.signature = d.signature;
      return null;
    }
    if (t === "content_block_stop") {
      const i = ev.index as number;
      if (this.jsonBuf.has(i)) {
        // 只有到 stop 才保证 JSON 完整
        const raw = this.jsonBuf.get(i)!;
        this.jsonBuf.delete(i);
        this.message.content[i].input = raw ? JSON.parse(raw) : {};
        return `[${i}] tool_use 结束 → input=${JSON.stringify(this.message.content[i].input)}`;
      }
      return `[${i}] 块结束`;
    }
    if (t === "message_delta") {
      Object.assign(this.message, ev.delta); // stop_reason 在这里才出现
      Object.assign(this.message.usage, ev.usage); // output_tokens 是累计值，直接覆盖
      return `message_delta stop_reason=${ev.delta.stop_reason} output_tokens=${ev.usage.output_tokens}`;
    }
    if (t === "message_stop") return "结束";
    if (t === "ping") return "ping（心跳，忽略）";
    if (t === "error") throw new Error(JSON.stringify(ev.error)); // 流中途也可能来 error 事件（如 overloaded_error）
    return null;
  }
}

function parses(s: string): string {
  try {
    JSON.parse(s);
    return "✔";
  } catch {
    return "✘";
  }
}

export function replay(path = FIXTURE, log: (s: string) => void = console.log): Record<string, any> {
  const acc = new Accumulator();
  for (const [name, ev] of parseSse(fileLines(path))) {
    const note = acc.feed(ev);
    if (note) log(`${name.padEnd(20)} ${note}`);
  }
  return acc.message;
}

// ---------- 3. 同样的字节交给真 SDK：验证我们拼得对 ----------
export async function viaSdk(path = FIXTURE): Promise<[string[], Anthropic.Message]> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const body = readFileSync(path);

  // 自定义 fetch 相当于 Python 版的 httpx.MockTransport：请求在这里就被截住，不出本机
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const client = new Anthropic({
    apiKey: "offline-fake-key",
    baseURL: "http://offline.invalid", // 永远不会真的发出去：fakeFetch 截住了
    fetch: fakeFetch,
  });
  const stream = client.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    messages: [{ role: "user", content: "修 calc.py" }],
  });
  const kinds: string[] = [];
  for await (const ev of stream) kinds.push(ev.type);
  const final = await stream.finalMessage();
  return [kinds, final];
}

/** 去掉值为 null/undefined 的字段，相当于 Python 的 model_dump(exclude_none=True)。 */
export function dropNulls(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (x === null ? undefined : x)));
}

if (import.meta.main) {
  const msg = replay();
  console.log("\n拼装结果：");
  console.log(JSON.stringify(msg, null, 2));
  if (process.argv.includes("--sdk")) {
    const [kinds, final] = await viaSdk();
    console.log("\nSDK 产出的事件类型：", JSON.stringify(kinds));
    console.log("SDK final message 的 tool_use.input：", (final.content[1] as Anthropic.ToolUseBlock).input);
    console.log("与手写拼装一致：", isDeepStrictEqual(dropNulls(final.content), dropNulls(msg.content)));
  }
}
