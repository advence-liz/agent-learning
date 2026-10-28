/** 第 17 章：Sub Agent。 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { type Block, call, FakeClient, say } from "../mini_cc/model.ts";
import { cleanupTmp, makeApp, makeSettings } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

function agent(prompt: string, { kind = "Explore", desc = "找分页逻辑", bg = false } = {}) {
  const args: Record<string, any> = { description: desc, prompt, subagent_type: kind };
  if (bg) args.run_in_background = true;
  return call("Agent", args);
}

const lastBlock = (msgs: Array<{ content: string | Block[] }>) => (msgs.at(-1)!.content as Block[])[0];

test("前台 Explore 在自己的上下文里跑", async () => {
  writeFileSync(join(settings.cwd, "posts.js"), "function list_posts(posts) {\n  return posts;\n}\n");
  const { app, client, ui } = makeApp(settings, [
    agent("在项目里找到 list_posts 的定义，回答文件和行号"),
    call("Bash", { command: "grep -n list_posts posts.js" }), // ← 子 agent 的第 1 步
    say("posts.js:1 定义了 list_posts"), // ← 子 agent 的结论
    say("在 posts.js 第 1 行"), // ← 父 agent 继续
  ]);
  await app.handleLine("list_posts 定义在哪？我之前说过别动 utils 目录");
  const childFirst = client.requests[1];
  // 子 agent 看不到父历史：第一条消息就是委派的 prompt
  assert.equal(childFirst.messages.length, 1);
  assert.ok(JSON.stringify(childFirst.messages).includes("在项目里找到 list_posts"));
  assert.ok(!JSON.stringify(childFirst.messages).includes("别动 utils"));
  // 子 agent 有自己的 system 和工具子集
  const sysText = childFirst.system.map((b) => b.text).join("\n");
  assert.ok(sysText.includes("read-only") && !sysText.includes("# Memory"));
  assert.deepEqual(childFirst.tools!.map((t) => t.name).sort(), ["Bash", "Read"]);
  // 父亲只拿到结论（外加一行统计），子 agent 的 grep 输出不进父历史
  const result: string = lastBlock(client.requests[3].messages).content;
  assert.ok(result.startsWith("posts.js:1 定义了 list_posts") && result.includes("1 tool use"));
  assert.ok(!JSON.stringify(app.agent.messages).includes("grep -n"));
  assert.ok(ui.text.includes("⎿ Explore: Bash(grep -n list_posts posts.js)")); // 进度实时显示给人看
});

test("Explore 不能写", async () => {
  const { app, client } = makeApp(settings, [
    agent("顺手建个文件"),
    call("Bash", { command: "touch x.txt" }),
    say("我是只读的，没建"),
    say("ok"),
  ]);
  app.agent.permissions.setMode("bypassPermissions"); // 父亲 bypass 也不能让 Explore 写文件
  await app.handleLine("探索一下");
  assert.ok(!existsSync(join(settings.cwd, "x.txt")));
  const denied = lastBlock(client.requests[2].messages);
  assert.ok(denied.is_error && denied.content.includes("read-only"));
});

test("general-purpose 有工具，但不能再派 agent", async () => {
  const { app, client } = makeApp(settings, [agent("干活", { kind: "general-purpose" }), say("干完了"), say("ok")]);
  await app.handleLine("派个通用 agent");
  const names = new Set(client.requests[1].tools!.map((t) => t.name));
  for (const n of ["Read", "Write", "Edit", "Bash"]) assert.ok(names.has(n));
  for (const n of ["Agent", "AskUserQuestion", "TaskCreate", "Memory", "TaskStop", "Monitor"]) assert.ok(!names.has(n));
});

test("未知类型列出可用的", async () => {
  const { app, client } = makeApp(settings, [agent("x", { kind: "Nope" }), say("ok")]);
  await app.handleLine("派");
  const r = lastBlock(client.requests[1].messages);
  assert.ok(r.is_error && r.content.includes("Explore") && r.content.includes("general-purpose"));
});

test("后台 agent 结束时带着结论通知", async () => {
  const { app, client } = makeApp(settings, [agent("查一下", { bg: true }), say("已派出，先干别的"), say("子 agent 说在 posts.js")]);
  const sub = new FakeClient([say("结论：posts.js 第 1 行")]);
  app.subagentClient = () => sub; // 后台 agent 和主循环交替执行，用自己的剧本
  await app.handleLine("后台派一个 Explore");
  const first: string = lastBlock(client.requests[1].messages).content;
  assert.ok(first.startsWith("Async agent launched successfully") && first.includes("a1"));
  await app.jobs.get("a1")!.wait(5);
  assert.ok(await app.wakeIfIdle());
  const sent = JSON.stringify(client.requests[2].messages.at(-1));
  assert.ok(sent.includes("<task-notification>") && sent.includes("<result>") && sent.includes("结论：posts.js 第 1 行"));
  assert.ok(sent.includes('Agent \\"找分页逻辑\\" completed'));
});

test("自定义 agent 类型", async () => {
  const d = join(settings.cwd, ".mini_cc", "agents");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "reviewer.md"), "---\nname: reviewer\ndescription: 审查改动，只给意见\ntools: Read\n---\n" +
    "你是代码审查员，只读代码，按严重度列问题。\n");
  const { app, client } = makeApp(settings, [agent("审一下 posts.js", { kind: "reviewer" }), say("没问题"), say("ok")]);
  await app.handleLine("派 reviewer");
  const agentTool = client.requests[0].tools!.find((t) => t.name === "Agent")!;
  assert.ok(agentTool.description.includes("reviewer: 审查改动，只给意见"));
  const child = client.requests[1];
  assert.deepEqual(child.tools!.map((t) => t.name), ["Read"]);
  assert.ok(child.system.map((b) => b.text).join("\n").includes("你是代码审查员"));
});

test("transcript 存成 sidechain", async () => {
  const { app } = makeApp(settings, [agent("查"), say("结论"), say("ok")]);
  await app.handleLine("派");
  const dir = join(dirname(app.session.path), app.session.id, "subagents");
  const files = readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f));
  assert.equal(files.length, 1);
  const recs = readFileSync(join(dir, files[0]), "utf8").trim().split("\n").map((ln) => JSON.parse(ln));
  assert.ok(recs.every((r) => r.isSidechain && r.agentId === "a1"));
  assert.deepEqual(recs.map((r) => r.type), ["user", "assistant"]);
});

test("达到 maxTurns 返回 [partial]", async () => {
  const { app, client } = makeApp(settings, [agent("一直查"), ...[0, 1, 2].map(() => call("Bash", { command: "true" })), say("ok")]);
  app.subagentMaxTurns = 3;
  await app.handleLine("派");
  const r: string = lastBlock(client.requests[4].messages).content;
  assert.ok(r.startsWith("[partial]"));
});
