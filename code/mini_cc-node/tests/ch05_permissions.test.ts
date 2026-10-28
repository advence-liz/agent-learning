/** 第 5 章：权限模式与审批。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { call, calls, say } from "../mini_cc/model.ts";
import { ACCEPT_EDITS, BYPASS, DEFAULT, Decision, PermissionManager } from "../mini_cc/permissions.ts";
import { SessionStore } from "../mini_cc/session.ts";
import { isReadOnly } from "../mini_cc/tools/bash.ts";
import { defaultTools, type Tool } from "../mini_cc/tools/index.ts";
import { cleanupTmp, collect, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const tools = (): Record<string, Tool> => Object.fromEntries(defaultTools().map((t) => [t.name, t]));

// 同 Python 的 @pytest.mark.parametrize：每条命令一个测试
for (const [cmd, ro] of [
  ["ls -la", true], ["git status && git diff", true], ["cat a.txt | grep x | wc -l", true],
  ["npm test", false], ["ls > out.txt", false], ["echo $(rm x)", false], ["find . -delete", false],
  ["git push", false], ["sleep 1 &", false],
] as const) {
  test(`只读命令判定：${cmd} → ${ro}`, () => {
    assert.equal(isReadOnly(cmd), ro);
  });
}

test("判定表", async () => {
  const pm = new PermissionManager(tmpPath());
  const { Bash: bash, Write: write, Read: read } = tools();
  const behavior = async (t: Tool, a: Record<string, any>) => (await pm.decide(t, a)).behavior;
  assert.equal(await behavior(read, { file_path: "x" }), "allow");
  assert.equal(await behavior(bash, { command: "ls" }), "allow");
  assert.equal(await behavior(bash, { command: "npm test" }), "ask");
  assert.equal(await behavior(write, { file_path: "a.txt", content: "" }), "ask");
  pm.setMode(ACCEPT_EDITS);
  assert.equal(await behavior(write, { file_path: "a.txt", content: "" }), "allow");
  // acceptEdits 只放行项目目录内的编辑
  assert.equal(await behavior(write, { file_path: "/etc/hosts", content: "" }), "ask");
  assert.equal(await behavior(write, { file_path: "../outside.txt", content: "" }), "ask");
  assert.equal(await behavior(bash, { command: "npm test" }), "ask");
  pm.setMode(BYPASS);
  assert.equal(await behavior(bash, { command: "rm -rf /" }), "allow");
  pm.setMode(DEFAULT);
  pm.denyRules.add("Bash(rm -rf build)");
  assert.equal(await behavior(bash, { command: "rm -rf build" }), "deny");
});

test("高危命令压过 allow 规则", async () => {
  const pm = new PermissionManager(tmpPath(), { mode: ACCEPT_EDITS, allowRules: ["Bash"] });
  assert.equal((await pm.decide(tools().Bash, { command: "sudo rm -rf /" })).behavior, "ask");
});

test("extraChecks 钩子最先跑（排在 bypass 之前）", async () => {
  const pm = new PermissionManager(tmpPath(), { mode: BYPASS });
  pm.extraChecks.push((t) => (t.kind === "edit" ? new Decision("deny", "frozen", "check") : null));
  assert.equal((await pm.decide(tools().Write, { file_path: "a", content: "" })).behavior, "deny");
  assert.equal((await pm.decide(tools().Bash, { command: "npm test" })).behavior, "allow");
});

test("模式循环", () => {
  const pm = new PermissionManager(tmpPath(), { cycle: [DEFAULT, ACCEPT_EDITS] }); // 第 5 章时的循环；第 6 章起默认多了 auto
  const seen: string[] = [];
  pm.onModeChange.push((_old, mode) => seen.push(mode));
  assert.deepEqual([pm.nextMode(), pm.nextMode()], [ACCEPT_EDITS, DEFAULT]);
  assert.deepEqual(seen, [ACCEPT_EDITS, DEFAULT]);
});

// ---------------------------------------------------------------- 循环里的审批

test("用户允许一次", async () => {
  const { app, ui } = makeApp(settings, [call("Bash", { command: "echo ok > f.txt" }), say("写好了")]);
  ui.answers = ["1"];
  await app.handleLine("写个文件");
  assert.ok(ui.text.includes("是否允许 Bash(echo ok > f.txt)？"));
  assert.equal(readFileSync(join(app.settings.cwd, "f.txt"), "utf8").trim(), "ok");
});

test("「不再询问」记住规则", async () => {
  const cmd = { command: "echo hi > a.txt" };
  const { app, ui } = makeApp(settings, [call("Bash", cmd), say("1"), call("Bash", cmd), say("2")]);
  ui.answers = ["2"];
  await app.handleLine("第一次");
  const nPrompts = ui.text.split("是否允许").length - 1;
  await app.handleLine("第二次");
  assert.equal(ui.text.split("是否允许").length - 1, nPrompts);
  assert.equal(nPrompts, 1);
  assert.ok(app.agent.permissions.allowRules.has("Bash(echo hi > a.txt)"));
});

test("拒绝并给理由：模型带着理由继续", async () => {
  const { app, client, ui } = makeApp(settings, [call("Bash", { command: "rm -rf build" }), say("好的，改用 make clean")]);
  ui.answers = ["3", "别删 build，用 make clean"];
  await app.handleLine("清理一下");
  const result = (client.requests[1].messages.at(-1)!.content as any[])[0];
  assert.ok(result.is_error && result.content.includes("NOT executed"));
  assert.ok(result.content.includes("别删 build，用 make clean"));
  assert.ok(ui.text.includes("好的，改用 make clean"));
});

test("拒绝不给理由：结束本轮，同批剩余调用跳过", async () => {
  const { app, client, ui } = makeApp(settings, [calls([["Bash", { command: "touch a" }], ["Bash", { command: "touch b" }]])]);
  ui.answers = ["3", ""];
  const evs = await collect(app.agent.runTurn("建两个文件"));
  assert.deepEqual(evs.at(-1), { type: "TurnEnd", stopReason: "denied", text: "", extra: {} });
  assert.equal(client.requests.length, 1); // 没有再请求模型：等用户发话
  const results = app.agent.messages.at(-1)!.content as any[];
  assert.ok(results[0].content.includes("STOP") && results[1].content.includes("Skipped"));
  assert.ok(!existsSync(join(app.settings.cwd, "a")) && !existsSync(join(app.settings.cwd, "b")));
});

test("deny 规则产出事件", async () => {
  const { app } = makeApp(settings, [call("Bash", { command: "git push" }), say("那我不推了")]);
  app.agent.permissions.denyRules.add("Bash(git push)");
  const evs = await collect(app.agent.runTurn("推一下"));
  assert.ok(evs.some((e) => e.type === "PermissionDecision" && e.behavior === "deny" && e.source === "rule"));
});

test("没有 approver 就当拒绝", async () => {
  const { app } = makeApp(settings, [call("Write", { file_path: "x.txt", content: "x" })]);
  app.agent.approver = null;
  await collect(app.agent.runTurn("写"));
  assert.equal(existsSync(join(app.settings.cwd, "x.txt")), false);
});

test("/mode 命令与会话记录", async () => {
  const { app, ui } = makeApp(settings, [say("ok")]);
  await app.handleLine("hi");
  await app.handleLine("/mode acceptEdits");
  assert.equal(app.agent.permissions.mode, ACCEPT_EDITS);
  const recs = SessionStore.readRecords(app.session.path);
  assert.deepEqual(recs.at(-1), { type: "permission-mode", permissionMode: "acceptEdits", sessionId: app.session.id });
  await app.handleLine("/mode yolo");
  assert.ok(ui.text.includes("unknown mode"));
});
