/** 第 21 章：plan 模式（先规划再动手）。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { type Block, call, complete, FakeClient, FakeTurn, type ModelRequest, say, type Script } from "../mini_cc/model.ts";
import { ACCEPT_EDITS, AUTO, DEFAULT, PermissionManager, PLAN } from "../mini_cc/permissions.ts";
import { EXIT_HEADER, FULL_HEADER, SPARSE_HEADER } from "../mini_cc/plan_mode.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

function planApp(script: Script[], answers: string[] = []) {
  const r = makeApp(settings, script);
  r.ui.answers = [...answers];
  r.app.agent.permissions.setMode(PLAN);
  return r;
}

const reminders = (req: ModelRequest) => req.messages
  .filter((m) => m.role === "user" && Array.isArray(m.content))
  .flatMap((m) => (m.content as Block[]).filter((b) => b.type === "text" && b.text.startsWith("<system-reminder>")).map((b) => b.text as string));
const firstResult = (req: ModelRequest) => (req.messages.at(-1)!.content as Block[])[0];
/** 剧本里第 i 步的计划文件路径要等 App 建好才知道：直接改那一步的 input（同 Python 版改 client.script）。 */
const setPlanPath = (client: FakeClient, i: number, path: string) => ((client.script[i] as FakeTurn).content[0].input.file_path = path);

test("Shift+Tab 循环里有 plan", () => {
  const pm = new PermissionManager(tmpPath());
  assert.deepEqual([0, 1, 2, 3].map(() => pm.nextMode()), [ACCEPT_EDITS, PLAN, AUTO, DEFAULT]);
});

test("plan 模式拦住编辑，但允许写计划文件", async () => {
  writeFileSync(join(settings.cwd, "posts.js"), "x = 1\n");
  const { app, client, ui } = planApp([
    call("Read", { file_path: "posts.js" }),
    call("Bash", { command: "grep -n x posts.js" }),
    call("Edit", { file_path: "posts.js", old_string: "x = 1", new_string: "x = 2" }),
    call("Write", { file_path: "{PLAN}", content: "# Plan\n1. 改 x\n" }),
    say("计划写好了"),
  ]);
  const plan = app.planFile;
  setPlanPath(client, 3, plan);
  await app.handleLine("把 x 改成 2");
  const results = [1, 2, 3, 4].map((i) => firstResult(client.requests[i]));
  assert.ok(!results[0].is_error && !results[1].is_error); // 读、只读命令照常
  assert.ok(results[2].is_error && results[2].content.includes("plan mode")); // 改源码被拒
  assert.ok(results[2].content.includes(plan)); // 拒绝理由里告诉它该写哪
  assert.ok(!results[3].is_error && readFileSync(plan, "utf8").startsWith("# Plan"));
  assert.equal(readFileSync(join(settings.cwd, "posts.js"), "utf8"), "x = 1\n");
  assert.ok(!ui.text.includes("是否允许")); // 写计划文件不用审批
});

test("plan 模式下非只读命令也要问", async () => {
  const { app, client, ui } = planApp([call("Bash", { command: "npm install" }), say("ok")], ["3 规划阶段别装依赖"]);
  await app.handleLine("看看");
  assert.ok(ui.text.includes("是否允许 Bash(npm install)"));
  assert.ok(firstResult(client.requests[1]).content.includes("别装依赖"));
});

test("完整规则 → 精简提醒 → 已退出", async () => {
  const { app, client } = planApp([...[0, 1, 2, 3, 4, 5].map(() => call("Bash", { command: "true" })), say("ok"), say("好")]);
  await app.handleLine("规划一下");
  const first = reminders(client.requests[0]);
  assert.ok(first.some((r) => r.includes(FULL_HEADER) && r.includes(app.planFile) && r.includes("ExitPlanMode")));
  const sparse = client.requests.map((req, i) => [i, reminders(req).some((r) => r.includes(SPARSE_HEADER))] as const)
    .filter(([, hit]) => hit).map(([i]) => i);
  assert.ok(sparse.length && sparse[0] === 5); // 每 5 次请求提醒一次精简版
  app.agent.permissions.setMode(DEFAULT);
  await app.handleLine("算了直接改");
  const last = reminders(client.requests.at(-1)!);
  assert.ok(last.some((r) => r.includes(EXIT_HEADER)));
  assert.equal(last.filter((r) => r.includes(EXIT_HEADER)).length, 1);
});

test("ExitPlanMode 批准", async () => {
  writeFileSync(join(settings.cwd, "posts.js"), "x = 1\n");
  const { app, client, ui } = planApp([
    call("Write", { file_path: "{PLAN}", content: "# Plan\n1. 把 x 改成 2\n" }),
    call("ExitPlanMode", {}),
    call("Read", { file_path: "posts.js" }),
    call("Edit", { file_path: "posts.js", old_string: "x = 1", new_string: "x = 2" }),
    say("改好了"),
  ], ["1"]);
  setPlanPath(client, 0, app.planFile);
  await app.handleLine("把 x 改成 2");
  assert.ok(ui.text.includes("# Plan") && ui.text.includes("1. 批准，之后的编辑自动通过"));
  const r: string = firstResult(client.requests[2]).content;
  assert.ok(r.startsWith("User has approved your plan. You can now start coding.") && r.includes("1. 把 x 改成 2"));
  assert.equal(app.agent.permissions.mode, ACCEPT_EDITS);
  assert.equal(readFileSync(join(settings.cwd, "posts.js"), "utf8"), "x = 2\n");
  const recs = readFileSync(app.session.path, "utf8").trim().split("\n").map((ln) => JSON.parse(ln));
  assert.equal(recs.filter((x) => x.type === "permission-mode").at(-1).permissionMode, ACCEPT_EDITS);
});

test("ExitPlanMode 被打回，继续规划", async () => {
  const { app, client } = planApp([call("Write", { file_path: "{PLAN}", content: "# Plan\n重写整个模块\n" }),
    call("ExitPlanMode", {}), say("那我缩小范围")], ["3 范围太大，只改分页"]);
  setPlanPath(client, 0, app.planFile);
  await app.handleLine("规划");
  const r = firstResult(client.requests[2]);
  assert.ok(r.content.includes("keep planning") && r.content.includes("只改分页"));
  assert.equal(app.agent.permissions.mode, PLAN);
});

test("ExitPlanMode 要先有计划文件", async () => {
  const { app, client } = planApp([call("ExitPlanMode", {}), say("先写计划")]);
  await app.handleLine("规划");
  const r = firstResult(client.requests[1]);
  assert.ok(r.is_error && r.content.includes(app.planFile));
});

test("模型可以主动进入 plan 模式", async () => {
  const { app, client } = makeApp(settings, [call("EnterPlanMode", {}), say("我先规划")]);
  await app.handleLine("这个重构有点大，你看着办");
  assert.equal(app.agent.permissions.mode, PLAN);
  assert.ok(reminders(client.requests[1]).some((r) => r.includes(FULL_HEADER))); // 工具结果里就带上完整规则
});

test("plan 模式下派出的 sub agent 只读", async () => {
  const { app, client } = planApp([
    call("Agent", { description: "设计方案", prompt: "设计分页方案", subagent_type: "Plan" }),
    call("Bash", { command: "touch x.txt" }), say("方案：……"), say("ok"),
  ]);
  await app.handleLine("规划");
  assert.ok(!existsSync(join(settings.cwd, "x.txt")));
  assert.deepEqual(new Set(client.requests[1].tools!.map((t) => t.name)), new Set(["Read", "Bash"]));
});

test("/plan 命令", async () => {
  const { app, client } = makeApp(settings, [say("先看看代码")]);
  await app.handleLine("/plan 给 posts 加分页");
  assert.equal(app.agent.permissions.mode, PLAN);
  assert.ok(reminders(client.requests[0]).some((r) => r.includes(FULL_HEADER)));
});

test("剧本占位符", async () => {
  const c = new FakeClient([call("Write", { file_path: "{plan_file}", content: "x" })]);
  c.vars.plan_file = () => "/tmp/p.md";
  const done = await complete(c, { system: [], messages: [] });
  assert.equal(done.content[0].input.file_path, "/tmp/p.md");
});
