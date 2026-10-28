/**
 * 第 2 章：最小 Coding Agent —— tool_use → 执行 → tool_result 的 while 循环。
 *
 * 真实运行： node coding_agent/agent.ts "<任务>" [工作目录]
 * 离线演示： node coding_agent/demo.ts
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "../fake_llm/index.ts";

export const MODEL = "claude-opus-5-5";
const SYSTEM = (cwd: string) =>
  `你是一个编程 Agent，工作目录是 ${cwd}。先读代码再改；改完用 run_command 跑测试验证；全部完成后用一两句话总结。`;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "读取工作目录内一个文本文件的全部内容。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "相对工作目录的路径" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "用 content 整体覆盖写入文件（不存在则创建）。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "在工作目录执行一条 shell 命令，返回退出码和输出（超时 60 秒）。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

export type Tools = Record<string, (args: any) => string>;

export function makeTools(cwd: string): Tools {
  const root = resolve(cwd);

  const safe = (path: string): string => {
    const p = resolve(root, path);
    const rel = relative(root, p);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new RangeError(`路径越界：${path}`); // 模型给的路径是不可信输入
    return p;
  };

  return {
    read_file: ({ path }: { path: string }) => readFileSync(safe(path), "utf8"),

    write_file: ({ path, content }: { path: string; content: string }) => {
      const p = safe(path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return `已写入 ${path}（${content.length} 字符）`;
    },

    run_command: ({ command }: { command: string }) => {
      let code = 0, out: string;
      try {
        out = execSync(command, { cwd: root, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
      } catch (e: any) {
        if (e.status == null) throw e; // 超时 / 起不来：交给 runAgent 当工具错误回报
        [code, out] = [e.status, `${e.stdout}${e.stderr}`];
      }
      return `exit=${code}\n${out.slice(-4000)}`; // 截尾，防止撑爆上下文
    },
  };
}

export async function runAgent(
  client: LLMClient,
  task: string,
  cwd: string,
  {
    tools = makeTools(cwd),
    toolSpecs = TOOLS,
    system = SYSTEM(cwd),
    maxTurns = 20,
    log = console.log,
  }: { tools?: Tools; toolSpecs?: Anthropic.Tool[]; system?: string; maxTurns?: number; log?: (s: string) => void } = {},
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system,
      tools: toolSpecs,
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });

    const calls = resp.content.filter((b) => b.type === "tool_use");
    if (calls.length === 0) {
      // 模型不再要工具 → 任务结束
      return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      // 一轮可能有多个并行 tool_use，结果要放进同一条 user 消息
      log(`⏺ ${call.name}(${short(call.input as Record<string, unknown>)})`);
      let out: string, isError: boolean;
      try {
        [out, isError] = [tools[call.name](call.input), false];
      } catch (e) {
        // 工具出错也要回报给模型，让它自己纠正
        [out, isError] = [`${(e as Error).name}: ${(e as Error).message}`, true];
      }
      log(`  ${isError ? "✘" : "✔"} ${(out.split("\n").filter(Boolean).at(-1) ?? "").slice(0, 70)}`);
      results.push({ type: "tool_result", tool_use_id: call.id, content: out, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  return `（达到 maxTurns=${maxTurns}，强制停止）`;
}

function short(args: Record<string, unknown>, n = 60): string {
  const s = Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
  return s.length <= n ? s : s.slice(0, n) + "…";
}

if (import.meta.main) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const [task, cwd = "."] = process.argv.slice(2);
  console.log(await runAgent(new Anthropic(), task, cwd));
}
