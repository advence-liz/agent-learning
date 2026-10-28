/**
 * 第 6 章：用 Claude Agent SDK（npm 包 @anthropic-ai/claude-agent-sdk）重写第 2 章的 Coding Agent。
 *
 * 对比第 2 章的 ~120 行：循环、工具执行、tool_result 拼装全部交给 SDK（它背后就是 Claude Code）。
 * 我们只剩三件事：写 prompt、配 options、（可选）挂自定义工具和 hook。
 *
 * 真实运行（会启动 SDK 自带的 claude CLI，并真实调用模型，需要 ANTHROPIC_API_KEY）：
 *     node agent_sdk/sdk_agent.ts "test_calc.py 挂了，帮我修好" /path/to/project
 * 离线演示（把 CLI 换成按脚本回放的假 CLI，不调用任何模型）：
 *     node agent_sdk/demo.ts
 */

import { globSync, readFileSync, statSync } from "node:fs";
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const DANGEROUS = ["rm -rf", "git push --force", "git reset --hard"];

// ---------- 1. 自定义工具：进程内 MCP server（不用另起进程） ----------
export const countTodos = tool("count_todos", "统计项目里 TODO 注释的数量", { glob: z.string() }, async (args) => {
  const n = globSync(args.glob)
    .filter((p) => statSync(p).isFile())
    .reduce((sum, p) => sum + readFileSync(p, "utf8").split("TODO").length - 1, 0);
  return { content: [{ type: "text", text: `${args.glob} 中共有 ${n} 个 TODO` }] };
});

export const TOOLS_SERVER = createSdkMcpServer({ name: "proj", version: "1.0.0", tools: [countTodos] });

// ---------- 2. Hook：在工具执行前拦截危险命令 ----------
export const blockDangerous: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const cmd = String((input.tool_input as { command?: string }).command ?? "");
  if (DANGEROUS.some((d) => cmd.includes(d))) {
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: `禁止执行危险命令：${cmd}`,
      },
    };
  }
  return {};
};

export function makeOptions(cwd: string): Options {
  return {
    model: "claude-opus-5-5",
    cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append: "改完代码必须跑测试验证。" },
    allowedTools: ["Read", "Edit", "Write", "Bash", "mcp__proj__count_todos"],
    permissionMode: "acceptEdits",
    mcpServers: { proj: TOOLS_SERVER },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [blockDangerous] }] },
    maxTurns: 20,
  };
}

// ---------- 3. 跑起来：遍历消息流 ----------
/** extra 会合并进 options；离线演示用它把 CLI 换成假的（见 fake_cli.ts）。 */
export async function run(prompt: string, cwd: string, extra: Partial<Options> = {}): Promise<SDKResultMessage | undefined> {
  let result: SDKResultMessage | undefined;
  for await (const msg of query({ prompt, options: { ...makeOptions(cwd), ...extra } })) {
    if (msg.type === "assistant") {
      for (const b of msg.message.content) {
        if (b.type === "text") console.log(`⏺ ${b.text}`);
        else if (b.type === "tool_use") console.log(`⏺ ${b.name}(${JSON.stringify(b.input)})`);
      }
    } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
      for (const b of msg.message.content) {
        if (b.type === "tool_result") console.log(`  ${b.is_error ? "✘" : "✔"} ${b.content}`);
      }
    } else if (msg.type === "result") {
      result = msg;
      console.log(`■ result: turns=${msg.num_turns} cost=$${msg.total_cost_usd} stop=${msg.stop_reason}`);
    }
  }
  return result;
}

if (import.meta.main) {
  const [prompt, cwd = "."] = process.argv.slice(2);
  await run(prompt, cwd);
}
