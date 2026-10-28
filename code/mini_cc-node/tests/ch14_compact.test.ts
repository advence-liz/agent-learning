/** 第 14 章：compact 压缩上下文。 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { App } from "../mini_cc/cli.ts";
import { extractSummary, mergeConsecutiveUsers, SUMMARY_HEADER } from "../mini_cc/compact.ts";
import type { Settings } from "../mini_cc/config.ts";
import type { Notice, TurnEnd } from "../mini_cc/events.ts";
import { type Block, call, FakeClient, FakeTurn, type Message, say, textBlock } from "../mini_cc/model.ts";
import { BufferUI } from "../mini_cc/ui.ts";
import { cleanupTmp, collect, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const summaryTurn = (text = "1. 用户要给 posts 加分页\n2. 已读 posts.py，还没改") => say(`<summary>\n${text}\n</summary>`);

test("extractSummary 与相邻 user 消息合并", () => {
  assert.equal(extractSummary("前言 <summary>\nA\n</summary> 尾巴"), "A");
  assert.equal(extractSummary("没有标签的摘要"), "没有标签的摘要");
  const msgs: Message[] = [{ role: "user", content: "s" }, { role: "user", content: [textBlock("p")] },
    { role: "assistant", content: [textBlock("a")] }];
  const merged = mergeConsecutiveUsers(msgs);
  assert.deepEqual(merged.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(merged[0].content, [textBlock("s"), textBlock("p")]);
  assert.equal(msgs[0].content, "s"); // 只合并请求视图，不动历史
});

test("/compact 用摘要替换历史", async () => {
  writeFileSync(join(settings.cwd, "posts.py"), "def list_posts(posts):\n    return posts\n");
  const { app, client, ui } = makeApp(settings, [call("Read", { file_path: "posts.py" }), say("读完了"), summaryTurn(), say("继续")]);
  await app.handleLine("看看 posts.py");
  const before = [...app.agent.messages];
  await app.handleLine("/compact 重点保留分页相关的内容");
  // 摘要请求：同一个 system、同一套工具（prompt cache 前缀能命中），历史 + 末尾一条摘要指令
  const req = client.requests[2];
  assert.deepEqual(req.system, client.requests[1].system);
  assert.deepEqual(req.tools, client.requests[1].tools);
  assert.deepEqual(req.messages.slice(0, -1), before);
  const ask = (req.messages.at(-1)!.content as Block[]).at(-1)!.text;
  assert.ok(ask.includes("<summary>") && ask.includes("Do not call any tools") && ask.includes("重点保留分页相关的内容"));
  // 压缩后：只剩一条 user 消息（摘要 + 重新挂回的文件 + 重新注入的项目说明）
  assert.equal(app.agent.messages.length, 1);
  const blob = JSON.stringify(app.agent.messages[0]);
  assert.ok(blob.includes(SUMMARY_HEADER) && blob.includes("用户要给 posts 加分页"));
  assert.ok(blob.includes("def list_posts") && blob.includes("# Project instructions"));
  assert.ok(ui.text.includes("已压缩"));
  // 下一轮：摘要和新提示词在请求里合并成一条 user 消息，user/assistant 交替不被打破
  await app.handleLine("开始改吧");
  const sent = client.requests[3].messages;
  assert.deepEqual(sent.map((m) => m.role), ["user"]);
  assert.ok(JSON.stringify(sent).includes("开始改吧"));
});

test("会话文件里的压缩边界，/resume 从边界开始", async () => {
  const { app } = makeApp(settings, [say("hi"), summaryTurn("摘要正文"), say("ok")]);
  await app.handleLine("你好");
  await app.handleLine("/compact");
  const recs = readFileSync(app.session.path, "utf8").trim().split("\n").map((ln) => JSON.parse(ln));
  const b = recs.find((r) => r.subtype === "compact_boundary");
  assert.ok(b.parentUuid === null && b.logicalParentUuid && b.compactMetadata.trigger === "manual");
  const app2 = new App(settings, new FakeClient([]), { ui: new BufferUI() });
  app2.resume(app.session.id);
  assert.equal(app2.agent.messages.length, 1);
  assert.ok(JSON.stringify(app2.agent.messages).includes("摘要正文"));
  // 压缩之前的检查点不再能 rewind（那段对话已经不在上下文里）
  assert.deepEqual(app.checkpoints(), []);
});

test("一轮中途自动压缩", async () => {
  settings.contextWindow = 10_000;
  settings.autoCompactBuffer = 2_000;
  const big = new FakeTurn([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo big" } }],
    { usage: { input_tokens: 9_000, output_tokens: 10 } });
  const { app, client, ui } = makeApp(settings, [big, summaryTurn("正在跑 echo big"), say("接着干完了")]);
  ui.answers = ["1"];
  const evs = await collect(app.agent.runTurn("跑一下"));
  const notices = evs.filter((e): e is Notice => e.type === "Notice").map((e) => e.text);
  assert.ok(notices.some((t) => t.includes("自动压缩")));
  // 第 3 次请求（压缩后）只带一条 user 消息，并要求模型接着干、不要复述
  const last = client.requests[2].messages;
  assert.equal(last.length, 1);
  assert.ok(JSON.stringify(last).includes("Continue from where you left off"));
  assert.equal((evs.at(-1) as TurnEnd).text, "接着干完了");
  assert.ok(app.agent.usage.lastInput < 9_000); // 估算值已经更新，不会立刻又触发
});

test("没到阈值不自动压缩", async () => {
  const { app, client } = makeApp(settings, [say("ok")]);
  await collect(app.agent.runTurn("hi"));
  assert.equal(client.requests.length, 1);
});

test("压缩失败时历史不变", async () => {
  const { app, ui } = makeApp(settings, [say("hi"), new FakeTurn([]), say("ok")]);
  await app.handleLine("你好");
  const n = app.agent.messages.length;
  await app.handleLine("/compact");
  assert.equal(app.agent.messages.length, n);
  assert.ok(ui.text.includes("压缩失败"));
});

test("文件状态表只保留重新挂回的文件", async () => {
  for (let i = 0; i < 7; i++) writeFileSync(join(settings.cwd, `f${i}.py`), `x = ${i}\n`);
  const reads = Array.from({ length: 7 }, (_, i) => call("Read", { file_path: `f${i}.py` }));
  const { app } = makeApp(settings, [...reads, say("读完了"), summaryTurn(), say("ok")]);
  await app.handleLine("把 7 个文件都读一遍");
  await app.handleLine("/compact");
  const kept = app.agent.ctx.fileState.paths().map((p) => basename(p)).sort();
  assert.deepEqual(kept, ["f2.py", "f3.py", "f4.py", "f5.py", "f6.py"]); // 最近 5 个：重新挂回上下文，也重新登记
  const blob = JSON.stringify(app.agent.messages[0]);
  assert.ok(blob.includes("x = 6") && !blob.includes("x = 0"));
});

test("剧本里可以给每一步设 usage", () => {
  const p = join(tmpPath(), "s.json");
  writeFileSync(p, JSON.stringify([{ say: "hi", usage: { input_tokens: 975000 } }]));
  const turn = FakeClient.fromJson(p).script[0] as FakeTurn;
  assert.deepEqual(turn.usage, { output_tokens: 20, input_tokens: 975000 });
});
