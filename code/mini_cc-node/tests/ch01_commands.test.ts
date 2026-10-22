/** 第 1 章：命令系统 + 最小 agent 循环。 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { EXIT } from "../mini_cc/cli.ts";
import type { Settings } from "../mini_cc/config.ts";
import { call, say } from "../mini_cc/model.ts";
import { cleanupTmp, makeApp, makeSettings, withoutSessionContext } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

test("普通输入进模型", async () => {
  const { app, client, ui } = makeApp(settings, [say("你好，我是 mini-cc")]);
  await app.handleLine("hi");
  assert.ok(ui.text.includes("你好，我是 mini-cc"));
  const first = client.requests[0].messages[0];
  assert.equal(first.role, "user");
  assert.equal(withoutSessionContext(first.content), "hi");
});

test("工具循环跑 Bash 并把结果回传", async () => {
  const { app, client, ui } = makeApp(settings, [call("Bash", { command: "echo hello" }), say("命令输出了 hello")]);
  await app.handleLine("跑一下 echo");
  // 第二次请求里，最后一条是 tool_result
  const last = client.requests[1].messages.at(-1)!;
  assert.equal(last.role, "user");
  const block = (last.content as any[])[0];
  assert.equal(block.type, "tool_result");
  assert.ok(block.content.includes("hello"));
  assert.ok(ui.text.includes("⏺ Bash(echo hello)"));
});

test("斜杠命令不请求模型", async () => {
  const { app, client, ui } = makeApp(settings);
  await app.handleLine("/help");
  assert.deepEqual(client.requests, []);
  assert.ok(ui.text.includes("/status") && ui.text.includes("/new"));
});

test("/new 清空历史", async () => {
  const { app } = makeApp(settings, [say("ok")]);
  await app.handleLine("记住 42");
  assert.equal(app.agent.messages.length, 2);
  await app.handleLine("/new");
  assert.deepEqual(app.agent.messages, []);
});

test("别名与退出", async () => {
  const { app } = makeApp(settings);
  assert.equal(await app.handleLine("/quit"), EXIT);
  assert.equal(await app.handleLine("/clear"), null);
});

test("未知命令提示最接近的", async () => {
  const { app, ui } = makeApp(settings);
  await app.handleLine("/stauts");
  assert.ok(ui.text.includes("/status"));
});

test("/status 显示用量", async () => {
  const { app, ui } = makeApp(settings, [say("ok")]);
  await app.handleLine("hi");
  await app.handleLine("/status");
  assert.ok(ui.text.includes("messages  2"));
  assert.ok(ui.text.includes("100 tokens"));
});

test("/model 切换模型", async () => {
  const { app } = makeApp(settings);
  await app.handleLine("/model claude-sonnet-5-5");
  assert.equal(app.settings.model, "claude-sonnet-5-5");
});
