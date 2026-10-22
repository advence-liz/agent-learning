/** 第 10 章：让 Agent 主动向你提问。 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { call, type ModelRequest, say } from "../mini_cc/model.ts";
import { parseAnswer, Question } from "../mini_cc/tools/ask_user.ts";
import { defaultTools, ToolContext, ToolRegistry } from "../mini_cc/tools/index.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const QS = {
  questions: [
    {
      question: "博客用什么技术栈？", header: "技术栈",
      options: [{ label: "Next.js (Recommended)", description: "SSR + 静态导出" },
        { label: "Astro", description: "内容站首选" }],
    },
    {
      question: "需要哪些功能？", header: "功能", multiSelect: true,
      options: [{ label: "评论" }, { label: "RSS" }, { label: "全文搜索" }],
    },
  ],
};

const lastResult = (req: ModelRequest) => (req.messages.at(-1)!.content as any[])[0];

test("parseAnswer", () => {
  const q = new Question("x", "h", [{ label: "A" }, { label: "B" }, { label: "C" }], true);
  assert.deepEqual(parseAnswer("2", q)!.choices, ["B"]);
  assert.deepEqual(parseAnswer("1, 3", q)!.choices, ["A", "C"]);
  assert.deepEqual(parseAnswer("1，3", q)!.choices, ["A", "C"]); // 中文逗号
  assert.deepEqual(parseAnswer("用 Hugo", q)!.choices, ["用 Hugo"]); // Other
  assert.equal(parseAnswer("", q)!.skipped, true);
  assert.equal(parseAnswer("9", q), null);
  const single = new Question("x", "h", [{ label: "A" }, { label: "B" }]);
  assert.equal(parseAnswer("1,2", single), null); // 单选不能选两个
});

test("agent 提问后带着答案继续", async () => {
  const { app, client, ui } = makeApp(settings, [call("AskUserQuestion", QS, "先确认两件事。"), say("好的：Astro + 评论、RSS。")]);
  ui.answers = ["2", "1,2"];
  await app.handleLine("帮我开发一个博客系统");
  assert.ok(ui.text.includes("[技术栈] (1/2) 博客用什么技术栈？"));
  assert.ok(ui.text.includes("  1. Next.js (Recommended) — SSR + 静态导出"));
  assert.ok(!ui.text.includes("是否允许")); // 提问不需要权限审批
  const result = lastResult(client.requests[1]);
  assert.equal(result.is_error, false);
  assert.equal(result.content, 'Your questions have been answered: "博客用什么技术栈？"="Astro", ' +
    '"需要哪些功能？"="评论, RSS". You can now continue with these answers in mind.');
});

test("Other 与跳过", async () => {
  const { app, client, ui } = makeApp(settings, [call("AskUserQuestion", QS), say("ok")]);
  ui.answers = ["用 Hugo，我熟", ""];
  await app.handleLine("博客");
  const content = lastResult(client.requests[1]).content;
  assert.ok(content.includes('"博客用什么技术栈？"="用 Hugo，我熟"') && content.includes('"需要哪些功能？"=(no answer)'));
});

test("输入无效时重问一次", async () => {
  const { app, client, ui } = makeApp(settings, [call("AskUserQuestion", { questions: QS.questions.slice(0, 1) }), say("ok")]);
  ui.answers = ["7", "1"];
  await app.handleLine("博客");
  assert.ok(ui.text.includes("输入无效"));
  assert.ok(lastResult(client.requests[1]).content.includes('"Next.js (Recommended)"'));
});

test("全部跳过 = 拒绝回答", async () => {
  const { app, client, ui } = makeApp(settings, [call("AskUserQuestion", QS), say("那你说说想要什么")]);
  ui.answers = ["", ""];
  await app.handleLine("博客");
  assert.ok(lastResult(client.requests[1]).content.includes("User declined to answer"));
});

test("schema 限制由校验器把关", async () => {
  const reg = new ToolRegistry(defaultTools());
  const ctx = new ToolContext(tmpPath());
  const five = { questions: Array(5).fill(QS.questions[0]) };
  const oneOption = { questions: [{ question: "q", header: "h", options: [{ label: "only" }] }] };
  assert.ok(String((await reg.execute("AskUserQuestion", five, ctx)).content).includes("at most 4 items"));
  assert.ok(String((await reg.execute("AskUserQuestion", oneOption, ctx)).content).includes("at least 2 items"));
});

test("没有 UI 时让模型按默认值继续", async () => {
  const reg = new ToolRegistry(defaultTools());
  const r = await reg.execute("AskUserQuestion", QS, new ToolContext(tmpPath()));
  assert.ok(r.isError && String(r.content).includes("sensible defaults"));
});

test("system prompt 讲了何时提问，工具也发给了模型", async () => {
  const { app, client } = makeApp(settings, [say("ok")]);
  await app.handleLine("hi");
  assert.ok(client.requests[0].system[0].text.includes("AskUserQuestion"));
  assert.ok(client.requests[0].tools!.some((t) => t.name === "AskUserQuestion"));
});
