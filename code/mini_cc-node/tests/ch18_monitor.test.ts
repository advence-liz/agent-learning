/** 第 18 章：Monitor —— 命令的每一行输出都是一个事件。 */

import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Settings } from "../mini_cc/config.ts";
import { JobManager } from "../mini_cc/jobs.ts";
import { type Block, call, say } from "../mini_cc/model.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

function mgr(kw: Partial<Pick<JobManager, "maxEvents" | "eventWindow" | "maxBatchLines">> = {}): [JobManager, string[], string] {
  const dir = tmpPath();
  const got: string[] = [];
  const m = new JobManager(join(dir, "tasks"), (t) => got.push(t));
  Object.assign(m, kw);
  return [m, got, dir];
}

test("每一行是一个事件，结束时报告", async () => {
  const [m, got, dir] = mgr();
  const job = m.startMonitor("for i in 1 2; do echo ERROR $i; sleep 0.5; done", dir, "errors in app.log", 10);
  await job.wait(5);
  const events = got.filter((g) => g.includes('Monitor event: "errors in app.log"'));
  assert.equal(events.length, 2);
  assert.ok(events[0].includes("<event>ERROR 1</event>") && events[1].includes("<event>ERROR 2</event>"));
  assert.ok(got.at(-1)!.includes('Monitor "errors in app.log" stream ended (exit code 0, 2 events)'));
  assert.ok(got.at(-1)!.includes("<status>completed</status>"));
  assert.equal(readFileSync(job.outputFile, "utf8"), "ERROR 1\nERROR 2\n");
});

test("200ms 内的行合并成一个事件", async () => {
  const [m, got, dir] = mgr();
  const job = m.startMonitor("echo a; echo b; echo c", dir, "burst", 10);
  await job.wait(5);
  const events = got.filter((g) => g.includes("Monitor event"));
  assert.ok(events.length === 1 && events[0].includes("<event>a\nb\nc</event>"));
});

test("stderr 不是事件", async () => {
  const [m, got, dir] = mgr();
  const job = m.startMonitor("echo oops >&2; echo fine", dir, "mixed", 10);
  await job.wait(5);
  assert.ok(!got.join("").includes("oops") && got.join("").includes("<event>fine</event>"));
  assert.ok(readFileSync(job.outputFile, "utf8").includes("oops"));
});

test("monitor 到期", async () => {
  const [m, got, dir] = mgr();
  const t0 = performance.now();
  const job = m.startMonitor("while true; do sleep 0.1; done", dir, "quiet log", 0.5);
  await job.wait(5);
  assert.ok(performance.now() - t0 < 3000);
  assert.equal(job.status, "killed");
  assert.ok(got.at(-1)!.includes('Monitor "quiet log" expired after 0.5s with 0 events') && got.at(-1)!.includes("re-arm"));
});

test("事件太多自动停掉", async () => {
  const [m, got, dir] = mgr({ maxEvents: 3, eventWindow: 60.0 });
  const job = m.startMonitor("while true; do echo tick; sleep 0.25; done", dir, "ticks", 10);
  await job.wait(5);
  assert.equal(job.status, "killed");
  assert.equal(got.filter((g) => g.includes("Monitor event")).length, 3);
  assert.ok(got.at(-1)!.includes("too many events") && got.at(-1)!.includes("tighter filter"));
});

test("一批太多行会截断", async () => {
  const [m, got, dir] = mgr({ maxBatchLines: 5 });
  const job = m.startMonitor("seq 1 100", dir, "flood", 10);
  await job.wait(5);
  const ev = got.find((g) => g.includes("Monitor event"))!;
  assert.ok(ev.includes("<event>1\n2\n3\n4\n5\n(… 95 more lines in the output file)</event>"));
});

test("Monitor 工具与 TaskStop", async () => {
  const { app, client, ui } = makeApp(settings, [
    call("Monitor", { command: "tail -n 0 -F app.log | grep --line-buffered ERROR",
      description: "errors in app.log", timeout_ms: 60000 }),
    say("在盯着了"), say("看到一个 ERROR"), call("TaskStop", { task_id: "m1" }), say("停了"),
  ]);
  writeFileSync(join(settings.cwd, "app.log"), "");
  ui.answers = ["1"];
  await app.handleLine("盯着 app.log，一出现 ERROR 就告诉我");
  const first: string = (client.requests[1].messages.at(-1)!.content as Block[])[0].content;
  assert.ok(first.startsWith("Monitor started (task m1") && first.includes("an event is not their reply"));
  await sleep(500);
  appendFileSync(join(settings.cwd, "app.log"), "INFO ok\nERROR db timeout\n");
  const deadline = performance.now() + 5000;
  while (!app.agent.notifications.length && performance.now() < deadline) await sleep(50);
  assert.ok(await app.wakeIfIdle());
  assert.ok(JSON.stringify(client.requests[2].messages.at(-1)).includes("<event>ERROR db timeout</event>"));
  await app.handleLine("可以停了");
  assert.equal(app.jobs.get("m1")!.status, "killed");
  await app.handleLine("/tasks");
  assert.ok(ui.text.includes("monitor"));
});
