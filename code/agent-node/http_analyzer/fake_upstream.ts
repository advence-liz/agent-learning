/**
 * 离线假上游：模拟 /v1/messages 的流式 SSE 响应，用来自测代理，不碰真实 Anthropic。
 *
 * 它还会「假装」实现 prompt cache：在每个 cache_control 断点处记下前缀，
 * 下次请求取最长的已记前缀算作 cache_read。数字是按字符数/4 粗估的，只为演示形状。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Obj = Record<string, any>;

function blocks(c: any): any[] {
  return typeof c === "string" ? [{ type: "text", text: c }] : c || [];
}

const isObj = (x: any): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);

// 对应 json.dumps(sort_keys=True)
function sortedJson(x: any): string {
  return JSON.stringify(x, (_k, v) =>
    isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

/** 按缓存前缀顺序 tools → system → messages 展开成块序列，并返回带断点的块下标。 */
function linear(body: Obj): [string[], number[]] {
  const seq: string[] = [];
  const bps: number[] = [];
  const items: [string, any][] = (body.tools ?? []).map((t: any) => ["tools", t]);
  items.push(...blocks(body.system).map((b): [string, any] => ["system", b]));
  for (const m of body.messages ?? []) {
    items.push(...blocks(m.content).map((b): [string, any] => [m.role, b]));
  }
  items.forEach(([role, b], i) => {
    if (isObj(b) && "cache_control" in b) {
      bps.push(i);
      const { cache_control: _, ...rest } = b;
      b = rest;
    }
    seq.push(role + sortedJson(b));
  });
  return [seq, bps];
}

/**
 * 极简 prompt cache 模型：
 * - 写：每个 cache_control 断点处，把「从头到这个块」的前缀记下来；
 * - 读：找本次请求里最长的、之前写过的前缀 → cache_read；
 * - 最后一个断点之前、没命中的部分 → cache_creation；断点之后 → 普通 input。
 * token 数按字符数 / 4 粗估，只为演示三个字段的关系。
 * （Node 单线程处理请求，不需要 Python 版那把锁。）
 */
export class FakeAnthropic {
  store = new Set<string>();
  receivedHeaders: Record<string, string>[] = [];

  usageFor(body: Obj): Obj {
    const [seq, bps] = linear(body);
    const cum: string[] = [];
    let acc = "";
    for (const s of seq) {
      acc += s;
      cum.push(acc);
    }
    let hit = 0;
    seq.forEach((_, i) => {
      if (this.store.has(cum[i])) hit = Math.max(hit, i + 1);
    });
    for (const i of bps) this.store.add(cum[i]);
    const lastBp = bps.length ? bps[bps.length - 1] + 1 : 0;
    const tok = (a: number, b: number) => Math.floor(seq.slice(a, b).reduce((n, x) => n + x.length, 0) / 4);
    const read = tok(0, hit);
    const create = lastBp > hit ? tok(hit, lastBp) : 0;
    const rest = tok(Math.max(hit, lastBp), seq.length);
    return {
      input_tokens: rest, cache_creation_input_tokens: create,
      cache_read_input_tokens: read, output_tokens: 0,
    };
  }
}

export function sseFrames(model: string, text: string, usage: Obj): Buffer[] {
  const ev = (name: string, data: Obj) => Buffer.from(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  const startUsage = { ...usage, output_tokens: 1 };
  const frames = [
    ev("message_start", {
      type: "message_start", message: {
        id: "msg_fake_001", type: "message", role: "assistant", model,
        content: [], stop_reason: null, usage: startUsage,
      },
    }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("ping", { type: "ping" }),
  ];
  const half = Math.floor(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) {
    frames.push(ev("content_block_delta", {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece },
    }));
  }
  frames.push(
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", {
      type: "message_delta", delta: { stop_reason: "end_turn" },
      usage: { output_tokens: Math.max(1, half) },
    }),
    ev("message_stop", { type: "message_stop" }),
  );
  return frames;
}

/** 起假上游并开始监听；port=0 让系统挑一个空闲端口。 */
export async function makeServer(port = 0): Promise<{ server: Server; state: FakeAnthropic; port: number }> {
  const state = new FakeAnthropic();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.length ? raw.toString("utf8") : "{}");
    state.receivedHeaders.push({ ...(req.headers as Record<string, string>) }); // Node 已经把 header 名转成小写
    if (req.headers["x-api-key"] === undefined && req.headers["authorization"] === undefined) {
      const msg = Buffer.from('{"type":"error","error":{"type":"authentication_error","message":"no key"}}');
      res.writeHead(401, { "content-type": "application/json", "content-length": String(msg.length) });
      res.end(msg);
      return;
    }
    const usage = state.usageFor(body);
    const frames = sseFrames(body.model ?? "fake", "你好！我是离线假模型。", usage);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "request-id": "req_fake_123",
      "content-length": String(frames.reduce((n, f) => n + f.length, 0)),
    });
    for (const f of frames) res.write(f);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  return { server, state, port: (server.address() as AddressInfo).port };
}
