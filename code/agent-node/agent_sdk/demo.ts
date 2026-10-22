/**
 * 离线演示：真实的 @anthropic-ai/claude-agent-sdk 的 query() + 假 CLI 子进程。
 *
 * node agent_sdk/demo.ts          # 看 agent 视角的输出
 * node agent_sdk/demo.ts --wire   # 额外打印 SDK 与 CLI 之间的原始 JSON 行
 */

import { FakeCLI, type Step } from "./fake_cli.ts";
import { run } from "./sdk_agent.ts";

export const SCRIPT: Step[] = [
  { tool: "Bash", input: { command: "rm -rf build && python test_calc.py" } },
  { tool: "Bash", input: { command: "python test_calc.py" }, fake_result: "AssertionError: -1" },
  { tool: "mcp__proj__count_todos", input: { glob: "*.md" } },
  { text: "危险命令被 hook 拦下后，我改用了安全命令；测试失败原因已定位。" },
];

export function summarize(msg: any): string {
  const t = msg.type;
  if (t === "control_request") {
    const r = msg.request;
    if (r.subtype === "initialize") return `control_request initialize  hooks=${JSON.stringify(r.hooks)}`;
    if (r.subtype === "hook_callback")
      return `control_request hook_callback  ${r.callback_id} ${r.input.tool_name} ${JSON.stringify(r.input.tool_input)}`;
    if (r.subtype === "mcp_message") {
      const m = r.message;
      return `control_request mcp_message  ${r.server_name} ${m.method} id=${m.id ?? null}`;
    }
  }
  if (t === "control_response") {
    const body = JSON.stringify(msg.response.response) ?? "null";
    return `control_response ${msg.response.request_id}  ${body.slice(0, 80)}`;
  }
  if (t === "assistant" || t === "user") return `${t}  ${JSON.stringify(msg.message.content).slice(0, 80)}`;
  return `${t} ${msg.subtype ?? ""}`;
}

export async function main(showWire: boolean): Promise<FakeCLI> {
  const cli = new FakeCLI(SCRIPT);
  await run("test_calc.py 挂了，帮我修好", ".", cli.options());
  if (showWire) {
    console.log("\n---- 线上的原始消息（截断） ----");
    for (const [direction, msg] of cli.wire) console.log(`${direction}  ${summarize(msg)}`);
  }
  return cli;
}

if (import.meta.main) {
  await main(process.argv.includes("--wire"));
}
