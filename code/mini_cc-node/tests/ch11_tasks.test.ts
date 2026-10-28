/** 第 11 章：让 Agent 跟踪多步任务。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { InjectState } from "../mini_cc/context.ts";
import type { TasksUpdated } from "../mini_cc/events.ts";
import { type Block, call, calls, say } from "../mini_cc/model.ts";
import { taskReminderProvider, TaskStore } from "../mini_cc/tasks.ts";
import { cleanupTmp, collect, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const plan = () => calls([
  ["TaskCreate", { subject: "读路由代码", activeForm: "读路由代码" }],
  ["TaskCreate", { subject: "加分页参数", activeForm: "加分页参数" }],
  ["TaskCreate", { subject: "补测试", activeForm: "补测试" }],
], "拆成三步。");

const tasksOf = (app: { agent: { ctx: { extras: Record<string, any> } } }) => app.agent.ctx.extras.tasks as TaskStore;
const blocksOf = (content: string | Block[]) => (Array.isArray(content) ? content : []);

test("TaskStore 落盘与读回", () => {
  const p = join(tmpPath(), "s.tasks.json");
  const s = TaskStore.load(p);
  s.create("a");
  s.update("1", { status: "completed" });
  s.create("b", "", "做 b");
  s.update("2", { status: "in_progress" });
  const again = TaskStore.load(p);
  assert.deepEqual(again.tasks.map((t) => t.status), ["completed", "in_progress"]);
  assert.equal(again.render(), "☒ #1 a\n◼ #2 b  ← 做 b\n(1/2 completed)");
  assert.equal(JSON.parse(readFileSync(p, "utf8"))[0].subject, "a");
});

test("模型建清单、更新状态", async () => {
  const { app, client, ui } = makeApp(settings, [
    plan(),
    call("TaskUpdate", { taskId: "1", status: "in_progress" }),
    call("TaskUpdate", { taskId: "1", status: "completed" }),
    say("第一步做完了"),
  ]);
  const evs = await collect(app.agent.runTurn("给 /posts 加分页"));
  const updates = evs.filter((e): e is TasksUpdated => e.type === "TasksUpdated");
  assert.equal(updates.length, 3); // 一批 3 个 TaskCreate 只显示一次最终清单
  assert.ok(updates.at(-1)!.rendered.startsWith("☒ #1 读路由代码\n☐ #2 加分页参数"));
  assert.deepEqual(tasksOf(app).tasks.map((t) => t.status), ["completed", "pending", "pending"]);
  assert.ok(!ui.text.includes("是否允许")); // 维护清单不需要审批
  const last = (client.requests[3].messages.at(-1)!.content as Block[])[0].content;
  assert.ok(last.includes("2 task(s) remaining"));
});

test("清单跟着会话落盘，/resume 后还在", async () => {
  const { app, ui } = makeApp(settings, [plan(), say("计划好了")]);
  await app.handleLine("加分页");
  const sid = app.session.id;
  assert.ok(existsSync(app.session.tasksPath));
  await app.handleLine("/new");
  assert.deepEqual(tasksOf(app).tasks, []); // 新会话新清单
  await app.handleLine(`/resume ${sid.slice(0, 8)}`);
  assert.equal(tasksOf(app).tasks.length, 3);
  await app.handleLine("/todos");
  assert.ok(ui.text.includes("☐ #3 补测试"));
});

test("连续 6 次没碰清单后提醒", async () => {
  const steps = Array.from({ length: 6 }, () => call("Bash", { command: "true" }));
  const { app, client } = makeApp(settings, [plan(), ...steps, say("ok")]);
  await collect(app.agent.runTurn("干活"));
  const reminders = client.requests
    .map((r, i) => [i, blocksOf(r.messages.at(-1)!.content)] as const)
    .filter(([, bs]) => bs.some((b) => String(b.text ?? "").includes("# Task list reminder")))
    .map(([i]) => i);
  // 第 0 次请求建清单；之后连续 6 次没碰清单 → 第 7 次请求（index 7）前注入提醒
  assert.deepEqual(reminders, [7]);
  const text = (client.requests[7].messages.at(-1)!.content as Block[]).at(-1)!.text;
  assert.ok(text.includes("not updated the task list in the last 6 steps") && text.includes("☐ #1 读路由代码"));
});

test("历史里看不到清单时（比如压缩之后）首条消息就提醒", async () => {
  const { app, client } = makeApp(settings, [say("继续")]);
  tasksOf(app).create("剩下的一步");
  await app.handleLine("我们做到哪了？");
  const first = client.requests[0].messages[0].content as Block[];
  assert.ok(first.some((b) => b.text.includes("current task list for this session")));
});

test("全部完成时不提醒", async () => {
  const { app } = makeApp(settings, [say("ok")]);
  const s = tasksOf(app);
  s.create("x");
  s.update("1", { status: "completed" });
  assert.equal(await taskReminderProvider()(new InjectState(app.agent, "user")), null);
});

test("更新不存在的任务报错、两个 in_progress 时提示", async () => {
  const { app, client } = makeApp(settings, [
    calls([["TaskCreate", { subject: "a" }], ["TaskCreate", { subject: "b" }]]),
    calls([["TaskUpdate", { taskId: "1", status: "in_progress" }],
      ["TaskUpdate", { taskId: "2", status: "in_progress" }],
      ["TaskUpdate", { taskId: "9", status: "completed" }]]),
    say("ok"),
  ]);
  await collect(app.agent.runTurn("go"));
  const results = client.requests[2].messages.at(-1)!.content as Block[];
  assert.ok(results[1].content.includes("#1 also in_progress"));
  assert.ok(results[2].is_error && results[2].content.includes("not found"));
});

test("UI 画出清单", async () => {
  const { app, ui } = makeApp(settings, [plan(), say("ok")]);
  await app.handleLine("加分页");
  assert.ok(ui.text.includes("  ☐ #1 读路由代码") && ui.text.includes("  (0/3 completed)"));
});
