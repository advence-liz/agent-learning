/**
 * Claude Code 抓包用的本地反向代理（明文 HTTP 入，HTTPS 出）。见 p3-agent-internals/01-http-analyzer.md。
 *
 * 用法：
 *     node http_analyzer/proxy.ts --port 8787 --out captures/
 *     ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude     # 另一个终端
 *
 * 为什么是「反向代理」而不是 mitmproxy 那种「中间人」：
 *     Claude Code 支持 ANTHROPIC_BASE_URL，客户端自己就会把请求发到我们这里，
 *     不需要伪造证书、不需要装根 CA。代理再用正常的 HTTPS 转发给上游。
 *
 * 每个请求落盘为 <out>/<seq>-<method>-<path>/：
 *     request.json      method / path / 脱敏 header / 解析后的 JSON body
 *     response.json     status / header / 若是 SSE 则附上重组后的 message
 *     response.raw      原始响应体（SSE 就是一行行 event/data）
 *     index.jsonl       <out> 下每个请求一行摘要
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { redactHeaders, redactText } from "./redact.ts";
import { assembleMessage, parseSse } from "./sse.ts";

type Obj = Record<string, any>;

export const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
  "accept-encoding", // 不转发客户端的压缩偏好；fetch 自己协商并自动解压，落盘的是明文
]);

/** 给每个 exchange 分配目录并写文件。Node 单线程，序号自增不需要锁；文件用同步写，保证先后顺序。 */
export class Recorder {
  out: string;
  private seq = 0;

  constructor(out: string) {
    this.out = out;
    mkdirSync(out, { recursive: true });
  }

  newDir(method: string, path: string): string {
    const n = ++this.seq;
    const slug = path.split("?")[0].replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    const d = join(this.out, `${String(n).padStart(4, "0")}-${method}-${slug}`);
    mkdirSync(d, { recursive: true });
    return d;
  }

  appendIndex(row: Obj): void {
    appendFileSync(join(this.out, "index.jsonl"), JSON.stringify(row) + "\n", "utf8");
  }
}

function writeJson(path: string, obj: unknown): void {
  const text = JSON.stringify(obj, null, 2);
  writeFileSync(path, redactText(text), "utf8");
}

/** rawHeaders 保留了客户端发来的原始大小写（落盘时好看），req.headers 是全小写的。 */
function rawHeaderDict(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) out[req.rawHeaders[i]] = req.rawHeaders[i + 1];
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  // node:http 已经替我们处理了 chunked 解码，这里只管把字节攒齐
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function makeHandler(upstream: string, recorder: Recorder) {
  return async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = performance.now();
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const body = await readBody(req);
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaderDict(req))) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) reqHeaders[k] = v;
    }
    const d = recorder.newDir(method, path);

    let parsed: any = null;
    if (body.length) {
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = body.toString("utf8");
      }
    }
    writeJson(join(d, "request.json"), {
      method,
      path,
      headers: redactHeaders(rawHeaderDict(req)),
      body_bytes: body.length,
      body: parsed,
    });

    const url = upstream.replace(/\/+$/, "") + path;
    const raw: Buffer[] = [];
    let status = 502;
    let respHeaders: Record<string, string> = {};
    try {
      const r = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body.length && method !== "GET" && method !== "HEAD" ? new Uint8Array(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(600_000),
      });
      status = r.status;
      respHeaders = Object.fromEntries(r.headers);
      const out: Record<string, string> = {};
      for (const [k, v] of r.headers) {
        if (!HOP_BY_HOP.has(k) && k !== "content-encoding") out[k] = v;
      }
      // 不设 content-length，node:http 自动用 chunked
      res.writeHead(status, out);
      // 边收边转发：SSE 必须逐块写出，否则 Claude Code 会等到整条响应结束才显示
      if (r.body) {
        for await (const chunk of r.body) {
          const b = Buffer.from(chunk);
          raw.push(b);
          res.write(b);
        }
      }
      // 先落盘再发结束块：客户端读完响应时，记录一定已经写好（测试也靠这点）
      record(recorder, d, parsed, status, respHeaders, Buffer.concat(raw), t0);
      res.end();
      return;
    } catch (e) {
      if (res.headersSent) {
        // 转发到一半上游断了：只能记下来、掐断连接
        record(recorder, d, parsed, status, respHeaders, Buffer.concat(raw), t0);
        res.destroy();
        return;
      }
      const msg = Buffer.from(JSON.stringify({
        type: "error", error: { type: "proxy_error", message: String((e as Error).message ?? e) },
      }));
      raw.push(msg);
      res.writeHead(502, { "content-type": "application/json", "content-length": String(msg.length) });
      res.end(msg);
    }
    record(recorder, d, parsed, status, respHeaders, Buffer.concat(raw), t0);
  };
}

function record(recorder: Recorder, d: string, parsed: any, status: number, respHeaders: Record<string, string>, raw: Buffer, t0: number): void {
  const text = raw.toString("utf8");
  writeFileSync(join(d, "response.raw"), redactText(text), "utf8");
  const isSse = (respHeaders["content-type"] ?? "").includes("text/event-stream");
  const respObj: Obj = { status, headers: redactHeaders(respHeaders) };
  if (isSse) {
    const events = parseSse(text);
    respObj.sse_event_counts = count(events.map((e) => e.event));
    respObj.message = assembleMessage(events);
  } else {
    try {
      respObj.body = text ? JSON.parse(text) : null;
    } catch {
      respObj.body = text.slice(0, 2000);
    }
  }
  writeJson(join(d, "response.json"), respObj);

  const row = summarize(d.split(/[\\/]/).pop()!, parsed, respObj, (performance.now() - t0) / 1000);
  recorder.appendIndex(row);
  console.log(JSON.stringify(row));
}

function count(it: Iterable<string>): Record<string, number> {
  const c: Record<string, number> = {};
  for (const x of it) c[x] = (c[x] ?? 0) + 1;
  return c;
}

export function summarize(name: string, req: any, resp: Obj, secs: number): Obj {
  const row: Obj = { id: name, status: resp.status, secs: Math.round(secs * 100) / 100 };
  if (req !== null && typeof req === "object" && !Array.isArray(req)) {
    row.model = req.model ?? null;
    row.stream = req.stream ?? null;
    row.n_messages = (req.messages ?? []).length;
    row.n_tools = (req.tools ?? []).length;
    const sysp = req.system;
    row.n_system_blocks = Array.isArray(sysp) ? sysp.length : sysp ? 1 : 0;
  }
  const b = resp.body;
  const msg = resp.message || (b !== null && typeof b === "object" && !Array.isArray(b) ? b : null);
  if (msg && typeof msg === "object" && "usage" in msg) {
    const u = msg.usage;
    row.usage = Object.fromEntries(
      ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].map((k) => [k, u[k]]),
    );
  }
  return row;
}

/** 起代理并开始监听；port=0 让系统挑一个空闲端口（测试用）。 */
export async function serve(port: number, upstream: string, out: string, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const server = createServer(makeHandler(upstream, new Recorder(out)));
  await new Promise<void>((ok) => server.listen(port, host, ok));
  return { server, port: (server.address() as AddressInfo).port };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "8787" },
      upstream: { type: "string", default: "https://api.anthropic.com" }, // 真实上游；你用中转站就填中转站地址
      out: { type: "string", default: "captures" },
    },
  });
  const port = Number(a.port);
  if (port === 0) {
    console.error("port 0 只给测试用");
    process.exit(1);
  }
  await serve(port, a.upstream!, a.out!);
  console.log(`listening http://127.0.0.1:${port} -> ${a.upstream}, writing ${a.out}/`);
}

if (import.meta.main) await main();
