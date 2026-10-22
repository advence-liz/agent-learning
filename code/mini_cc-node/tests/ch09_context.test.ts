/** 第 9 章：上下文组装与注入。 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { dateProvider, findInstructionFiles } from "../mini_cc/context.ts";
import { AnthropicClient, call, type Message, say } from "../mini_cc/model.ts";
import { cleanupTmp, collect, makeApp, makeSettings, tmpPath } from "./conftest.ts";
import { StubSDK, textStream } from "./sdk_stub.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

function reminders(msg: Message): string[] {
  const c = msg.content;
  return Array.isArray(c) ? c.filter((b) => String(b.text ?? "").startsWith("<system-reminder>")).map((b) => b.text) : [];
}

test("system 在会话内稳定，并打了缓存断点", async () => {
  const { app, client } = makeApp(settings, [call("Bash", { command: "true" }), say("ok")]);
  await collect(app.agent.runTurn("hi"));
  const s1 = client.requests[0].system, s2 = client.requests[1].system;
  assert.deepEqual(s1, s2); // 同一会话内逐字节相同 → prompt cache 能命中
  assert.deepEqual(s1.at(-1)!.cache_control, { type: "ephemeral" });
  const env = s1.find((b) => b.text.startsWith("# Environment"))!.text; // 第 12 章起后面还有 # Memory 段
  assert.ok(env.includes(app.settings.cwd));
  assert.ok(!s1.map((b) => b.text).join("").includes("Today's date")); // 会变的东西不进 system
  assert.equal(client.requests[0].cache, true);
});

test("适配层把顶层 cache_control 传给 SDK", async () => {
  const sdk = new StubSDK([textStream("ok")]);
  const c = new AnthropicClient("claude-opus-5-5", { sdkClient: sdk, fallbacks: false });
  await collect(c.stream({ system: [], messages: [], cache: true }));
  assert.deepEqual(sdk.calls[0].cache_control, { type: "ephemeral" });
});

test("项目说明只在第一条 user 消息里注入一次", async () => {
  const { app, client, ui } = makeApp(settings, [say("一"), say("二")]);
  writeFileSync(join(app.settings.cwd, "AGENTS.md"), "变量名必须用 snake_case");
  await app.handleLine("第一句");
  await app.handleLine("第二句");
  const first = client.requests[1].messages[0], third = client.requests[1].messages[2];
  assert.ok(reminders(first).some((r) => r.includes("变量名必须用 snake_case")));
  assert.ok(!reminders(third).some((r) => r.includes("# Project instructions")));
  assert.ok(ui.text.includes("◇ system  项目说明 1 个文件"));
});

test("说明文件的查找顺序", () => {
  const tmp = tmpPath();
  const repo = join(tmp, "repo");
  const sub = join(repo, "pkg", "web");
  mkdirSync(sub, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "AGENTS.md"), "root");
  writeFileSync(join(repo, "pkg", "CLAUDE.md"), "pkg");
  writeFileSync(join(sub, "AGENTS.md"), "web");
  const home = join(tmp, "home");
  mkdirSync(home);
  writeFileSync(join(home, "AGENTS.md"), "user");
  const got = findInstructionFiles(sub, home).map((p) => readFileSync(p, "utf8"));
  assert.deepEqual(got, ["user", "root", "pkg", "web"]); // 用户级 → 仓库根 → … → cwd，越近越靠后
});

test("/new 重新注入，/resume 不重复注入", async () => {
  const { app, client } = makeApp(settings, [say("a"), say("b"), say("c")]);
  await app.handleLine("x");
  await app.handleLine("/new");
  await app.handleLine("y");
  assert.ok(reminders(client.requests[1].messages[0]).some((r) => r.includes("# Project instructions")));
  const sid = app.session.id;
  await app.handleLine("/new");
  await app.handleLine(`/resume ${sid.slice(0, 8)}`);
  await app.handleLine("z");
  const msgs = client.requests[2].messages;
  const n = msgs.filter((m) => m.role === "user").flatMap(reminders).filter((r) => r.includes("# Project instructions")).length;
  assert.equal(n, 1); // 恢复的会话里已经有了，不再重复注入
});

test("日期变化时提醒", async () => {
  const { app, client } = makeApp(settings, [say("a"), say("b")]);
  const days = [new Date(2026, 9, 21), new Date(2026, 9, 22)];
  app.agent.context.providers[1] = dateProvider(() => days.shift()!);
  await app.handleLine("今天");
  await app.handleLine("明天了");
  assert.ok(reminders(client.requests[0].messages[0]).some((r) => r.includes("Today's date is 2026-10-21.")));
  assert.ok(reminders(client.requests[1].messages[2]).some((r) => r.includes("The date has changed. Today's date is now 2026-10-22.")));
});

test("外部修改带 diff 注入", async () => {
  const { app, client } = makeApp(settings, [call("Read", { file_path: "a.py" }), say("读完了"), say("看到你的修改了")]);
  const f = join(app.settings.cwd, "a.py");
  writeFileSync(f, "x = 1\ny = 2\n");
  await app.handleLine("读 a.py");
  writeFileSync(f, "x = 1\ny = 3\n"); // 用户在编辑器里改了
  await app.handleLine("我刚改了点东西");
  const rem = reminders(client.requests[2].messages.at(-1)!).join("\n");
  assert.ok(rem.includes("a.py was modified outside of your tools") && rem.includes("-y = 2") && rem.includes("+y = 3"));
  // 提醒过之后按新内容登记：直接 Edit 不会撞「modified since read」
  assert.equal(app.agent.ctx.fileState.isStale(f), false);
});

test("自己的 Edit 不触发提醒，Bash 改的会", async () => {
  const { app, client, ui } = makeApp(settings, [
    call("Read", { file_path: "a.py" }),
    call("Edit", { file_path: "a.py", old_string: "1", new_string: "2" }),
    call("Bash", { command: "echo 'z = 9' >> a.py" }),
    say("done"),
  ]);
  writeFileSync(join(app.settings.cwd, "a.py"), "x = 1\n");
  ui.answers = ["1"];
  await app.handleLine("改");
  const afterEdit = client.requests[2].messages.at(-1)!;
  const afterBash = client.requests[3].messages.at(-1)!;
  assert.ok(!reminders(afterEdit).some((r) => r.includes("modified outside")));
  // Bash 改的文件也算「外部修改」，提醒跟在 tool_result 后面
  assert.equal((afterBash.content as any[])[0].type, "tool_result");
  assert.ok(reminders(afterBash).some((r) => r.includes("+z = 9")));
});

test("别处（另一个回调）发来的通知送达模型", async () => {
  const { app, client } = makeApp(settings, [call("Bash", { command: "true" }), say("收到通知")]);
  // Node 没有线程：用一个定时器回调模拟「后台任务结束时调 notify」（Python 版用 threading.Thread）
  await new Promise<void>((r) => setTimeout(() => (app.agent.notify("<task-notification>build finished</task-notification>"), r()), 1));
  const evs = await collect(app.agent.runTurn("go"));
  assert.ok(evs.some((e) => e.type === "ContextInjected" && e.kind === "notification"));
  assert.ok(reminders(client.requests[0].messages[0]).some((r) => r.includes("build finished")));
  assert.deepEqual(app.agent.drainNotifications(), []);
});

test("历史严格只追加", async () => {
  const { app, client } = makeApp(settings, [call("Bash", { command: "true" }), call("Bash", { command: "true" }), say("ok")]);
  await collect(app.agent.runTurn("go"));
  const [a, b, c] = client.requests.map((r) => r.messages);
  assert.deepEqual(b.slice(0, a.length), a); // 每次请求都是上一次的严格前缀扩展
  assert.deepEqual(c.slice(0, b.length), b);
});

test("坏掉的提供者被跳过", async () => {
  const { app } = makeApp(settings, [say("ok")]);
  app.agent.context.providers.unshift(() => {
    throw new Error("boom");
  });
  const end = (await collect(app.agent.runTurn("hi"))).at(-1)!;
  assert.ok(end.type === "TurnEnd" && end.stopReason === "end_turn");
});

test("/context 命令", async () => {
  const { app, ui } = makeApp(settings, [say("ok")]);
  await app.handleLine("hi");
  await app.handleLine("/context");
  assert.ok(ui.text.includes("system[0]") && ui.text.includes("<system-reminder> 块"));
});
