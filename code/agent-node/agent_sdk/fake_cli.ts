/**
 * 一个假的「Claude Code CLI」：SDK 把它当成真的 claude 可执行文件启动，它按脚本回放 stream-json 消息。
 *
 * 为什么能这么做？因为 SDK 和 CLI 之间就是 stdin/stdout 上一行一个 JSON：
 *   SDK → CLI： control_request(initialize, 带 hooks 回调 id)、user 消息、control_response
 *   CLI → SDK： system/assistant/user/result 消息、control_request(hook_callback / mcp_message)
 * 我们把 CLI 那一侧换成脚本，就能离线观察 SDK 的 hook 和进程内 MCP 工具是怎么被「反向调用」的。
 *
 * 和 Python 版的区别：Python SDK 允许直接传一个 Transport 对象替掉子进程；
 * Node SDK 没有公开的 Transport 参数，但有 options.pathToClaudeCodeExecutable——
 * 路径以 .ts/.js 结尾时，SDK 会用 `node <路径> --output-format stream-json ...` 启动它。
 * 所以这里的假 CLI 是一个真的子进程：脚本从环境变量 FAKE_CLI_SCRIPT 读入，
 * 收发的每一行都追加写到 FAKE_CLI_WIRE 指向的文件里，父进程读这个文件来打印/断言。
 *
 * 注意：消息字段按 @anthropic-ai/claude-agent-sdk 0.3.308 的源码对齐，只覆盖本 demo 用到的最小子集。
 */

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const SESSION = "fake-session-0001";

/** 一个「CLI 动作」：要么模型说一句话，要么调一个工具（见 demo.ts）。 */
export type Step = { text: string } | { tool: string; input: Record<string, unknown>; fake_result?: string };
export type Wire = Array<[direction: "SDK→CLI" | "CLI→SDK", msg: any]>;

// ---------------------------------------------------------------- 父进程这一侧：把假 CLI 配进 options
export class FakeCLI {
  script: Step[];
  wirePath: string;

  constructor(script: Step[]) {
    this.script = script;
    this.wirePath = join(mkdtempSync(join(tmpdir(), "fake-cli-")), "wire.jsonl");
    writeFileSync(this.wirePath, "");
  }

  /** 合并进 query() 的 options：可执行文件换成本文件，脚本和日志路径走环境变量。 */
  options(): Partial<Options> {
    return {
      pathToClaudeCodeExecutable: import.meta.filename,
      executable: "node",
      env: { ...process.env, FAKE_CLI_SCRIPT: JSON.stringify(this.script), FAKE_CLI_WIRE: this.wirePath },
    };
  }

  /** 记录的所有收发，便于打印/断言。 */
  get wire(): Wire {
    return readFileSync(this.wirePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

// ---------------------------------------------------------------- 子进程这一侧：假 CLI 的内部逻辑
class FakeCLIProcess {
  script: Step[];
  wirePath: string;
  private pending = new Map<string, (resp: any) => void>();
  private hooks: Record<string, Array<{ matcher?: string; hookCallbackIds: string[] }>> = {};
  private n = 0;
  private rpcId = 0;
  private mcpReady = new Set<string>();

  constructor(script: Step[], wirePath: string) {
    this.script = script;
    this.wirePath = wirePath;
  }

  async serve(): Promise<void> {
    let playing: Promise<void> | undefined;
    for await (const line of createInterface({ input: process.stdin })) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      this.record("SDK→CLI", msg);
      if (msg.type === "control_request") {
        if (msg.request.subtype === "initialize") this.hooks = msg.request.hooks ?? {};
        // initialize 和其它我们不关心的控制请求，一律回 success
        this.emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
      } else if (msg.type === "control_response") {
        const rid = msg.response.request_id;
        this.pending.get(rid)?.(msg.response.response);
        this.pending.delete(rid);
      } else if (msg.type === "user") {
        // 收到用户 prompt 后开始「跑 agent」：不 await，好让本循环继续读 SDK 的 control_response
        playing = this.play();
      }
    }
    await playing; // SDK 关了 stdin（收到 result 后）→ 进程退出
  }

  private record(direction: string, msg: unknown): void {
    appendFileSync(this.wirePath, JSON.stringify([direction, msg]) + "\n");
  }

  private emit(msg: unknown): void {
    this.record("CLI→SDK", msg);
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  /** CLI 反向请求 SDK（hook 回调 / 进程内 MCP），等它回 control_response。 */
  private askSdk(request: Record<string, unknown>): Promise<any> {
    const rid = `cli_req_${++this.n}`;
    const done = new Promise((resolve) => this.pending.set(rid, resolve));
    this.emit({ type: "control_request", request_id: rid, request });
    return done;
  }

  private async runHooks(event: string, toolName: string, toolInput: unknown, toolUseId: string): Promise<any[]> {
    const outs = [];
    for (const m of this.hooks[event] ?? []) {
      if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test(toolName)) continue;
      for (const cid of m.hookCallbackIds) {
        outs.push(
          await this.askSdk({
            subtype: "hook_callback",
            callback_id: cid,
            tool_use_id: toolUseId,
            input: {
              hook_event_name: event, session_id: SESSION, cwd: ".",
              transcript_path: "", tool_name: toolName, tool_input: toolInput,
            },
          }),
        );
      }
    }
    return outs;
  }

  /** 把一条 JSON-RPC 包进 control_request(mcp_message) 发给 SDK 里的 MCP server。 */
  private async mcp(server: string, method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.mcpReady.has(server)) {
      // 和任何 MCP server 一样，先握手（第 11 章细讲）
      this.mcpReady.add(server);
      await this.mcp(server, "initialize", {
        protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "fake-cli", version: "0" },
      });
      await this.mcp(server, "notifications/initialized");
    }
    const id = ++this.rpcId;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    if (!method.startsWith("notifications/")) msg.id = id;
    const resp = await this.askSdk({ subtype: "mcp_message", server_name: server, message: msg });
    return resp.mcp_response;
  }

  private assistant(content: Array<Record<string, unknown>>, i: number) {
    return {
      type: "assistant", session_id: SESSION, parent_tool_use_id: null,
      message: {
        id: `msg_${i}`, role: "assistant", model: "claude-opus-5-5", content,
        stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
        usage: { input_tokens: 100, output_tokens: 30 },
      },
    };
  }

  private async play(): Promise<void> {
    this.emit({ type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5-5" });
    let turns = 0;
    for (const [i, step] of this.script.entries()) {
      turns += 1;
      if ("text" in step) {
        this.emit(this.assistant([{ type: "text", text: step.text }], i));
        continue;
      }
      const tid = `toolu_${String(i).padStart(2, "0")}`;
      const { tool: name, input: args } = step;
      this.emit(this.assistant([{ type: "tool_use", id: tid, name, input: args }], i));
      // 1) PreToolUse hooks：问 SDK 要不要放行
      const outs = await this.runHooks("PreToolUse", name, args, tid);
      const denied = outs.find((o) => o?.hookSpecificOutput?.permissionDecision === "deny")?.hookSpecificOutput
        .permissionDecisionReason;
      let result: string, isError: boolean;
      if (denied) {
        [result, isError] = [denied, true];
      } else if (name.startsWith("mcp__")) {
        // 2) 进程内 MCP 工具：CLI 把 JSON-RPC 包在 control_request 里转给 SDK
        const [server, toolName] = name.split("__").slice(1, 3);
        const resp = await this.mcp(server, "tools/call", { name: toolName, arguments: args });
        [result, isError] = [resp.result.content[0].text, false];
      } else {
        [result, isError] = [step.fake_result ?? "(fake CLI 未真正执行内置工具)", false];
      }
      this.emit({
        type: "user", session_id: SESSION, parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: result, is_error: isError }] },
      });
    }
    const last = this.script.at(-1);
    this.emit({
      type: "result", subtype: "success", session_id: SESSION, is_error: false,
      duration_ms: 1234, duration_api_ms: 1000, num_turns: turns, stop_reason: "end_turn",
      total_cost_usd: 0.0, result: last && "text" in last ? last.text : "", usage: {},
    });
  }
}

// SDK 用 `node fake_cli.ts --output-format stream-json ...` 启动本文件时走这里
if (import.meta.main) {
  await new FakeCLIProcess(JSON.parse(process.env.FAKE_CLI_SCRIPT ?? "[]"), process.env.FAKE_CLI_WIRE!).serve();
}
