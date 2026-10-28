import assert from "node:assert/strict";
import { test } from "node:test";

import { main } from "./demo.ts";
import { FakeCLI } from "./fake_cli.ts";
import { makeOptions, run } from "./sdk_agent.ts";

function wire(cli: FakeCLI, kind: string) {
  return cli.wire.map(([, m]) => m).filter((m) => m.type === "control_request" && m.request.subtype === kind);
}

/** 对应 pytest 的 capsys：把这段时间里 console.log 的输出收集起来。 */
async function capture<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return [await fn(), lines.join("\n")];
  } finally {
    console.log = orig;
  }
}

test("hook 拦下危险的 Bash 命令", async () => {
  const [cli, out] = await capture(() => main(false));
  assert.match(out, /✘ 禁止执行危险命令：rm -rf build/);
  // hook 只对 Bash 触发两次（matcher="Bash"），MCP 工具不触发
  assert.deepEqual(wire(cli, "hook_callback").map((r) => r.request.input.tool_name), ["Bash", "Bash"]);
});

test("SDK MCP 工具在进程内被调用", async () => {
  const [cli, out] = await capture(() => main(false));
  const methods = wire(cli, "mcp_message").map((r) => r.request.message.method);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]);
  assert.match(out, /\*\.md 中共有/);
});

test("options 的形状", () => {
  const o = makeOptions("/tmp");
  assert.equal(o.model, "claude-opus-5-5");
  assert.ok(o.allowedTools!.includes("mcp__proj__count_todos"));
  assert.equal(o.hooks!.PreToolUse![0].matcher, "Bash");
});

test("result 消息", async () => {
  const [r] = await capture(() => run("hi", ".", new FakeCLI([{ text: "hello" }]).options()));
  assert.ok(r && r.subtype === "success");
  assert.ok(r.num_turns === 1 && r.result === "hello" && !r.is_error);
});
