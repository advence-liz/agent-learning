/**
 * MCP 客户端（第 15 章）：读 .mcp.json → 启动并连接每个 server → 把它们的工具注册成普通的 Tool。
 *
 * Python 版的难点是「MCP SDK 是 async 的，而 agent 循环是同步生成器」，要开后台线程跑 asyncio 循环。
 * Node 版没有这个问题：@modelcontextprotocol/sdk 的 Client 本来就是 Promise 接口，agent 循环也是 async 的，
 * 每个 server 一个常驻的 Client 对象，工具调用直接 await client.callTool()。
 *
 * 配置格式和 Claude Code 一样：
 *     {"mcpServers": {"tracker": {"command": "node", "args": ["server.ts"], "env": {"K": "${TOKEN}"}},
 *                     "remote":  {"type": "http", "url": "https://example.com/mcp"}}}
 * 项目级 <cwd>/.mcp.json（第一次启动前要用户批准）+ 用户级 <home>/mcp.json（自己写的，不用批准）。
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpToolInfo } from "@modelcontextprotocol/sdk/types.js";
import { type Args, Tool, type ToolContext, ToolResult } from "./tools/base.ts";

export const CONNECT_TIMEOUT = 15.0;
export const CALL_TIMEOUT = 120.0;
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

// ---------------------------------------------------------------- 配置

export class ServerConfig {
  name: string;
  scope: "project" | "user";
  type: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;

  constructor(name: string, scope: "project" | "user",
    { type = "stdio", command = "", args = [], env = {}, url = "" }:
      { type?: "stdio" | "http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string } = {}) {
    this.name = name;
    this.scope = scope;
    this.type = type;
    this.command = command;
    this.args = args;
    this.env = env;
    this.url = url;
  }

  /** 批准记录绑定到「这份配置」：命令或参数一变就要重新批准。 */
  fingerprint(): string {
    const raw = JSON.stringify([this.type, this.command, this.args, this.env, this.url]);
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  describe(): string {
    return this.type === "http" ? this.url : [this.command, ...this.args].join(" ");
  }
}

/** ${VAR} 和 ${VAR:-默认值}（Claude Code 的 .mcp.json 也支持这两种写法），让密钥留在环境变量里。 */
function expand(v: any): any {
  if (typeof v === "string") return v.replace(VAR, (_, name: string, dflt?: string) => process.env[name] ?? dflt ?? "");
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}

export function loadConfig(cwd: string, home: string): Map<string, ServerConfig> {
  const out = new Map<string, ServerConfig>();
  const sources: Array<["user" | "project", string]> = [["user", join(home, "mcp.json")], ["project", join(cwd, ".mcp.json")]];
  for (const [scope, path] of sources) { // 后读的覆盖先读的
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const servers = JSON.parse(readFileSync(path, "utf8")).mcpServers ?? {};
    for (const [name, r] of Object.entries<any>(servers)) {
      const raw = expand(r);
      out.set(name, new ServerConfig(name, scope, {
        type: raw.type ?? ("url" in raw ? "http" : "stdio"), command: raw.command ?? "",
        args: [...(raw.args ?? [])], env: { ...(raw.env ?? {}) }, url: raw.url ?? "",
      }));
    }
  }
  return out;
}

/** mcp__<server>__<tool>。API 要求工具名匹配 ^[a-zA-Z0-9_-]{1,64}$，所以先清洗再截断。 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** MCP 的 content → Anthropic 的 content block。图片原样转成 image 块（第 19 章会用到）。 */
export function convertContent(blocks: Array<Record<string, any>>): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const b of blocks) {
    const t = b?.type ?? "";
    if (t === "text") out.push({ type: "text", text: b.text });
    else if (t === "image") out.push({ type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
    else out.push({ type: "text", text: `[${t || "unknown"} content omitted]` }); // audio / resource 等：给模型一个占位
  }
  return out.length ? out : [{ type: "text", text: "(no content)" }];
}

// ---------------------------------------------------------------- 连接管理

export class ServerState {
  name: string;
  config: ServerConfig;
  status: "pending" | "connected" | "failed" | "disabled" | "closed" = "pending";
  error = "";
  tools: McpToolInfo[] = [];
  instructions = "";
  client: Client | null = null;
  logFd: number | null = null;

  constructor(name: string, config: ServerConfig, status: ServerState["status"] = "pending") {
    this.name = name;
    this.config = config;
    this.status = status;
  }
}

const errText = (e: unknown) => {
  const err = e as Error;
  return `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`.slice(0, 300);
};

export class McpManager {
  logDir: string;
  servers = new Map<string, ServerState>();

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  /** 并行连接所有 server，最多等 timeout 秒。连不上的标成 failed，不影响别的 server 和启动。 */
  async start(configs: ServerConfig[], timeout = CONNECT_TIMEOUT): Promise<void> {
    await Promise.all(configs.map((cfg) => {
      const st = new ServerState(cfg.name, cfg);
      this.servers.set(cfg.name, st);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (st.status === "pending") {
            st.status = "failed";
            st.error = `connection timed out after ${timeout.toFixed(0)}s`;
          }
          resolve();
        }, timeout * 1000);
      });
      return Promise.race([this.connect(st), timedOut]).finally(() => clearTimeout(timer));
    }));
  }

  private async connect(st: ServerState): Promise<void> {
    const cfg = st.config;
    const client = new Client({ name: "mini-cc", version: "0.1.0" });
    try {
      let transport;
      if (cfg.type === "http") {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url));
      } else {
        mkdirSync(this.logDir, { recursive: true });
        // server 的 stderr（日志）写文件，不能混进终端，更不能进 stdout（那是协议通道）
        st.logFd = openSync(join(this.logDir, `mcp-${st.name}.log`), "a");
        const env = Object.keys(cfg.env).length
          ? { ...(process.env as Record<string, string>), ...cfg.env } : undefined;
        transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: st.logFd });
      }
      await client.connect(transport); // 握手（initialize）在这里完成
      const tools = (await client.listTools()).tools;
      if (st.status !== "pending") { // 已经超时被判失败：连上了也不要了
        await client.close();
        return;
      }
      st.instructions = client.getInstructions() ?? "";
      st.tools = tools;
      st.client = client;
      st.status = "connected";
    } catch (e) {
      // 子进程起不来、握手失败……都记下来，不往外抛
      if (st.status === "pending") {
        st.status = "failed";
        st.error = errText(e);
      }
      await client.close().catch(() => {});
    }
  }

  async call(server: string, tool: string, args: Args, timeout = CALL_TIMEOUT): Promise<ToolResult> {
    const st = this.servers.get(server);
    if (st === undefined || st.status !== "connected" || st.client === null) {
      return new ToolResult(`MCP server ${server} is not connected (${st ? st.status : "unknown"}).`, true);
    }
    let r;
    try {
      r = await st.client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeout * 1000 });
    } catch (e) {
      // SDK 超时抛 McpError（code = RequestTimeout）；连接断了等其他错误也变成工具错误，不往外抛
      if ((e as any)?.code === -32001) return new ToolResult(`MCP tool ${tool} timed out after ${timeout.toFixed(0)}s.`, true);
      return new ToolResult(`MCP tool ${tool} failed: ${errText(e)}`, true);
    }
    return new ToolResult(convertContent((r.content as any[]) ?? []), Boolean(r.isError));
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map(async (st) => {
      if (st.client) await st.client.close().catch(() => {});
      st.client = null;
      if (st.status === "connected") st.status = "closed";
      if (st.logFd !== null) closeSync(st.logFd);
      st.logFd = null;
    }));
  }

  // ------------------------------------------------------------ 给 Agent 用

  tools(): Tool[] {
    const out: Tool[] = [];
    for (const st of this.servers.values()) {
      if (st.status === "connected") out.push(...st.tools.map((t) => new McpTool(this, st.name, t)));
    }
    return out;
  }

  /** 挂 ContextBuilder.systemSections：server 自带的使用说明（Claude Code 叫 MCP Server Instructions）。 */
  instructionsSection(): string | null {
    const parts = [...this.servers.values()]
      .filter((st) => st.status === "connected" && st.instructions.trim())
      .map((st) => `## ${st.name}\n${st.instructions.trim()}`);
    if (!parts.length) return null;
    return "# MCP server instructions\nThe following MCP servers are connected and gave these instructions " +
      "for their tools (named mcp__<server>__<tool>):\n\n" + parts.join("\n\n");
  }
}

export class McpTool extends Tool {
  override kind = "mcp";
  manager: McpManager;
  server: string;
  remoteName: string;

  constructor(manager: McpManager, server: string, tool: McpToolInfo) {
    super();
    this.manager = manager;
    this.server = server;
    this.remoteName = tool.name;
    this.name = mcpToolName(server, tool.name);
    this.description = tool.description || `MCP tool ${tool.name} from server ${server}`;
    this.inputSchema = tool.inputSchema ?? { type: "object", properties: {} };
    // readOnlyHint 是 server 自己声明的「我不改东西」。它只是提示，所以只用来**放宽**审批，不用来做安全边界
    this.readOnly = Boolean(tool.annotations?.readOnlyHint);
  }

  override summary(args: Args): string {
    const first = args ? Object.values(args)[0] ?? "" : "";
    return `${this.name}(${(typeof first === "string" ? first : JSON.stringify(first)).slice(0, 50)})`;
  }

  override run(args: Args, _ctx: ToolContext): Promise<ToolResult> {
    return this.manager.call(this.server, this.remoteName, args);
  }
}

// ---------------------------------------------------------------- 批准项目级 server

/** <home>/mcp-approvals.json：{项目目录: {server 名: 配置指纹}}。 */
export class Approvals {
  path: string;
  project: string;
  data: Record<string, Record<string, string>>;

  constructor(path: string, project: string) {
    this.path = path;
    this.project = project;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  approved(cfg: ServerConfig): boolean {
    return this.data[this.project]?.[cfg.name] === cfg.fingerprint();
  }

  approve(cfg: ServerConfig): void {
    (this.data[this.project] ??= {})[cfg.name] = cfg.fingerprint();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 1), "utf8");
  }
}

/** 项目级 server 没批准过就问一次。返回 [要启动的, 被拒绝的]。 */
export async function selectServers(
  configs: Map<string, ServerConfig>, approvals: Approvals,
  ask: (prompt: string) => Promise<string>, info: (msg: string) => void,
): Promise<[ServerConfig[], ServerConfig[]]> {
  const start: ServerConfig[] = [], rejected: ServerConfig[] = [];
  for (const cfg of configs.values()) {
    if (cfg.scope === "user" || approvals.approved(cfg)) {
      start.push(cfg);
      continue;
    }
    info(`项目 .mcp.json 声明了 MCP server ${cfg.name}：${cfg.describe()}`);
    info("  它会以你的身份在本机运行。是否启动？  1. 启动并记住  2. 本次不启动");
    if ((await ask("选择 [1/2]: ")).trim().startsWith("1")) {
      approvals.approve(cfg);
      start.push(cfg);
    } else {
      rejected.push(cfg);
    }
  }
  return [start, rejected];
}
