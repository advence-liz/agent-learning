/**
 * 第 11 章：不用任何 MCP 库，直接起第 10 章的 server，手写 JSON-RPC 收发并打印原始报文。
 *
 *     node mcp_protocol/raw_client.ts
 *     node mcp_protocol/raw_client.ts --edge
 *
 * stdio 传输的分帧规则很朴素：一条消息 = 一行 JSON（UTF-8，以 \n 结尾，消息内部不能有裸换行）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const SERVER = join(import.meta.dirname, "..", "mcp_tool", "notes_server.ts");

type Msg = Record<string, any>;

export class RawClient {
  p: ChildProcessWithoutNullStreams;
  nextId = 0;
  verbose: boolean;
  log: Array<["→" | "←", Msg]> = [];
  private stderr = "";
  private lines: string[] = []; // 已到达、还没人取的行
  private waiters: Array<(line: string | null) => void> = []; // 在等下一行的 _recv
  private eof = false;

  constructor(cmd: string[], verbose = true) {
    // stderr 单独接走：server 的日志在那里，绝不会混进协议流
    this.p = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    this.verbose = verbose;
    this.p.stderr.setEncoding("utf8").on("data", (d: string) => (this.stderr += d));
    // 按行切 stdout：Python 版用阻塞的 readline()，Node 只能异步地收「一行到了」的事件，这里排个队
    const rl = createInterface({ input: this.p.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.lines.push(line);
    });
    rl.on("close", () => {
      this.eof = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  private send(msg: Msg): void {
    const line = JSON.stringify(msg);
    this.log.push(["→", msg]);
    if (this.verbose) console.log(`→ ${line}`);
    this.p.stdin.write(line + "\n");
  }

  private async recv(): Promise<Msg> {
    const line =
      this.lines.shift() ?? (this.eof ? null : await new Promise<string | null>((r) => this.waiters.push(r)));
    if (line === null) {
      if (this.p.exitCode === null && this.p.signalCode === null) await once(this.p, "close");
      throw new Error(`EOF：server 已退出\n${this.stderr}`);
    }
    const msg = JSON.parse(line);
    this.log.push(["←", msg]);
    if (this.verbose) console.log(`← ${line.trimEnd()}`);
    return msg;
  }

  async request(method: string, params?: Msg): Promise<Msg> {
    this.nextId += 1;
    const msg: Msg = { jsonrpc: "2.0", id: this.nextId, method };
    if (params !== undefined) msg.params = params;
    this.send(msg);
    while (true) {
      // 等到 id 对上的那条响应；中途 server 发来的通知/请求先打印再跳过
      const resp = await this.recv();
      if (resp.id === this.nextId && !("method" in resp)) return resp;
    }
  }

  notify(method: string, params?: Msg): void {
    const msg: Msg = { jsonrpc: "2.0", method }; // 没有 id = 通知，对方不回
    if (params !== undefined) msg.params = params;
    this.send(msg);
  }

  async close(): Promise<string> {
    const closed = once(this.p, "close"); // close 在子进程退出且 stdio 都读完后才触发
    this.p.stdin.end(); // stdio 传输里，关 stdin 就是「断开连接」
    const timer = setTimeout(() => this.p.kill(), 5000);
    await closed;
    clearTimeout(timer);
    return this.stderr;
  }
}

export async function session(verbose = true): Promise<RawClient> {
  const c = new RawClient([process.execPath, SERVER], verbose);
  const step = (title: string) => {
    if (verbose) console.log(`\n## ${title}`);
  };

  step("1. initialize：客户端报协议版本和能力，服务端回它的版本、能力和简介");
  await c.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw-client", version: "0.0.1" },
  });
  step("2. notifications/initialized：握手完成（通知，没有 id，也没有响应）");
  c.notify("notifications/initialized");

  step("3. tools/list：动态拉取工具清单（含 JSON Schema）");
  await c.request("tools/list");

  step("4. tools/call：调用工具");
  await c.request("tools/call", { name: "search_notes", arguments: { query: "stop hook" } });

  step("5. 工具执行失败：不是 JSON-RPC error，而是 result.isError = true");
  await c.request("tools/call", { name: "read_note", arguments: { path: "/etc/passwd" } });

  step("6. 协议层错误：调用不存在的方法 → JSON-RPC error 对象");
  await c.request("resources/subscribe_everything");

  step("7. ping：保活");
  await c.request("ping");
  return c;
}

export async function edgeCases(verbose = true): Promise<Record<string, Msg>> {
  const out: Record<string, Msg> = {};
  let c = new RawClient([process.execPath, SERVER], verbose);
  if (verbose) console.log("\n## 边界 A：不握手直接 tools/list");
  out.no_handshake = await c.request("tools/list");
  await c.close();
  c = new RawClient([process.execPath, SERVER], verbose);
  if (verbose) console.log("\n## 边界 B：客户端报一个服务端不认识的版本 → 服务端还价");
  out.bad_version = await c.request("initialize", {
    protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "0" } });
  await c.close();
  return out;
}

if (import.meta.main) {
  if (process.argv.includes("--edge")) {
    await edgeCases();
  } else {
    const c = await session();
    const err = await c.close();
    console.log("\n## server 的 stderr（日志都在这里）");
    console.log(err.trim());
  }
}
