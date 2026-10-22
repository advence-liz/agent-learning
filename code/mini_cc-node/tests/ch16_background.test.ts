/** 第 16 章：让 Agent 在后台运行命令。 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { type Block, call, type ModelRequest, say } from "../mini_cc/model.ts";
import { cleanupTmp, makeApp, makeSettings } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const bg = (cmd: string, desc = "demo") => call("Bash", { command: cmd, run_in_background: true, description: desc });
const resultText = (req: ModelRequest) => (req.messages.at(-1)!.content as Block[])[0].content as string;

test("后台命令立即返回，退出时通知", async () => {
  const { app, client } = makeApp(settings, [bg("sleep 1; echo done", "sleep then echo"), say("已在后台跑"),
    say("后台命令跑完了，输出 done")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("后台跑个命令");
  const job = app.jobs.get("b1")!;
  // 没有等命令结束（Python 版量耗时 < 0.3s；全量测试并行跑时耗时不稳，这里直接看任务还在跑）
  assert.equal(app.jobs.get("b1")!.status, "running");
  const first = resultText(client.requests[1]);
  assert.ok(first.startsWith("Command running in background with ID: b1.") && first.includes(".output"));
  await job.wait(5);
  assert.ok(job.status === "completed" && job.exitCode === 0);
  assert.equal(readFileSync(job.outputFile, "utf8"), "done\n");
  // 通知在下一条 user 消息里送达；空闲时 REPL 会主动唤醒模型
  assert.equal(await app.wakeIfIdle(), true);
  const sent = JSON.stringify(client.requests[2].messages.at(-1));
  assert.ok(sent.includes("<task-notification>") && sent.includes("<status>completed</status>"));
  assert.ok(sent.includes('Background command \\"sleep then echo\\" completed (exit code 0)'));
  assert.equal(await app.wakeIfIdle(), false); // 队列空了就不再唤醒
});

test("后台命令失败", async () => {
  const { app, client } = makeApp(settings, [bg("echo boom >&2; exit 3"), say("ok"), say("失败了")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("跑");
  const job = app.jobs.get("b1")!;
  await job.wait(5);
  assert.ok(job.status === "failed" && job.exitCode === 3 && readFileSync(job.outputFile, "utf8").includes("boom"));
  await app.wakeIfIdle();
  assert.ok(JSON.stringify(client.requests[2].messages.at(-1)).includes("failed with exit code 3"));
});

test("忙的时候，通知跟着下一个工具结果送达", async () => {
  const { app, client } = makeApp(settings, [bg("true"), call("Bash", { command: "sleep 0.5" }), say("ok")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("跑");
  // 第二个工具（前台 sleep）执行期间后台命令结束：通知跟着 tool_result 一起送达，不用等这一轮结束
  const last = JSON.stringify(client.requests[2].messages.at(-1));
  assert.ok(last.includes("tool_result") && last.includes("<task-notification>"));
});

test("TaskStop 停掉任务", async () => {
  const { app, client } = makeApp(settings, [bg("sleep 30"), call("TaskStop", { task_id: "b1" }), say("停了")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("跑一个长命令然后停掉");
  const job = app.jobs.get("b1")!;
  await job.wait(5);
  assert.equal(job.status, "killed");
  assert.ok(resultText(client.requests[2]).includes("Stopped task b1"));
  assert.equal(await app.wakeIfIdle(), false); // 自己停掉的不再通知
  const bad = await app.agent.tools.execute("TaskStop", { task_id: "nope" }, app.agent.ctx);
  assert.ok(bad.isError && (bad.content as string).includes("No task"));
});

test("/tasks 列出后台任务", async () => {
  const { app, ui } = makeApp(settings, [bg("sleep 30", "long sleep"), say("ok")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("跑");
  await app.handleLine("/tasks");
  assert.ok(ui.text.includes("b1") && ui.text.includes("running") && ui.text.includes("long sleep"));
  await app.handleLine("/tasks stop b1");
  await app.jobs.get("b1")!.wait(5);
  assert.equal(app.jobs.get("b1")!.status, "killed");
});

test("读输出文件不会触发「外部修改」提醒", async () => {
  const { app, client } = makeApp(settings, [bg("for i in 1 2 3; do echo $i; sleep 0.1; done"), say("ok"),
    say("ok"), say("ok")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("跑");
  const path = app.jobs.get("b1")!.outputFile;
  await app.agent.tools.execute("Read", { file_path: path }, app.agent.ctx); // 模型中途 Read 输出文件
  await app.jobs.get("b1")!.wait(5);
  await app.handleLine("怎么样了");
  assert.ok(!JSON.stringify(client.requests.at(-1)!.messages.at(-1)).includes("modified outside"));
});

test("前台超时提示改用后台", async () => {
  const { app, client } = makeApp(settings, [call("Bash", { command: "sleep 3", timeout: 1 }), say("超时了")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("跑");
  assert.ok(resultText(client.requests[1]).includes("run_in_background"));
});

test("close() 停掉还在跑的任务", async () => {
  const { app } = makeApp(settings, [bg("sleep 30"), say("ok")]);
  app.agent.permissions.setMode("bypassPermissions");
  await app.handleLine("跑");
  await app.close();
  assert.equal(app.jobs.get("b1")!.status, "killed");
});
