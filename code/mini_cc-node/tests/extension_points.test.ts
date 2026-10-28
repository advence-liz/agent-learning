/** 给第 11–21 章预留的扩展点：这里只验证「挂得上、按时触发」，具体功能由后续章节实现。 */

import assert from "node:assert/strict";
import { basename } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { notice } from "../mini_cc/events.ts";
import { call, say } from "../mini_cc/model.ts";
import { Decision } from "../mini_cc/permissions.ts";
import { type Args, Tool, ToolResult } from "../mini_cc/tools/base.ts";
import { cleanupTmp, collect, makeApp, makeSettings } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

test("beforeRequest 与 turnEnd 钩子", async () => {
  const { app } = makeApp(settings, [call("Bash", { command: "true" }), say("ok")]);
  const seen: Array<[string, unknown]> = [];
  app.agent.beforeRequest.push((a) => (seen.push(["req", a.messages.length]), [notice("compact?")]));
  app.agent.turnEnd.push((_a, end) => void seen.push(["end", end.stopReason]));
  const evs = await collect(app.agent.runTurn("go"));
  assert.deepEqual(seen, [["req", 1], ["req", 3], ["end", "end_turn"]]);
  assert.equal(evs.filter((e) => e.type === "Notice" && e.text === "compact?").length, 2);
  assert.equal(evs.at(-1)!.type, "TurnEnd");
});

test("listeners / writeHooks / systemSections / extraChecks", async () => {
  const { app, client, ui } = makeApp(settings, [call("Write", { file_path: "a.txt", content: "x" }), say("ok")]);
  const msgs: string[] = [], writes: string[] = [];
  app.agent.listeners.push((m) => msgs.push(m.role)); // 第 13 章 rewind
  app.agent.ctx.writeHooks.push((p) => writes.push(basename(p))); // 第 13 章文件快照
  app.agent.context.systemSections.push(() => "# Memory\n- prefers pnpm"); // 第 12 章记忆 / 第 20 章 skills
  app.agent.context.invalidate();
  app.agent.permissions.extraChecks.push( // 第 21 章 plan 模式
    (t) => (t.kind === "edit" ? new Decision("allow", "plan file", "check") : null));
  await collect(app.agent.runTurn("写"));
  assert.deepEqual(msgs, ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(writes, ["a.txt"]);
  assert.equal(client.requests[0].system.at(-1)!.text, "# Memory\n- prefers pnpm");
  assert.ok(!ui.text.includes("是否允许")); // extraCheck 放行了编辑
});

test("运行时注册新工具，下一次请求就带上 schema", async () => {
  // 第 15 章 MCP / 第 17 章 sub agent
  class Echo extends Tool {
    override name = "mcp__demo__echo";
    override readOnly = true;
    override inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    override run(args: Args) {
      return new ToolResult(args.text);
    }
  }
  const { app, client } = makeApp(settings, [call("mcp__demo__echo", { text: "pong" }), say("ok")]);
  app.agent.tools.register(new Echo());
  await collect(app.agent.runTurn("ping"));
  assert.equal(client.requests[0].tools!.at(-1)!.name, "mcp__demo__echo");
  assert.equal((client.requests[1].messages.at(-1)!.content as any[])[0].content, "pong");
});
