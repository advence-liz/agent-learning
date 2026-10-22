/** 第 4 章：JSONL 持久化 + /resume。 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { App } from "../mini_cc/cli.ts";
import type { Settings } from "../mini_cc/config.ts";
import { call, FakeClient, say, toolBlock } from "../mini_cc/model.ts";
import { projectSlug, SessionStore } from "../mini_cc/session.ts";
import { BufferUI } from "../mini_cc/ui.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath, withoutSessionContext } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("slug 规则和 Claude Code 一样", () => {
  const tmp = tmpPath();
  assert.ok(projectSlug(join(tmp, "my.proj")).endsWith("-my-proj"));
  assert.ok(!projectSlug(tmp).includes("/"));
});

test("每条消息立刻追加一行", async () => {
  const { app } = makeApp(settings, [call("Bash", { command: "echo hi" }), say("done")]);
  assert.equal(existsSync(app.session.path), false); // 第一条消息之前不建文件
  await app.handleLine("跑一下");
  const recs = lines(app.session.path);
  assert.deepEqual(recs.map((r) => r.type), ["user", "assistant", "user", "assistant"]);
  // parentUuid 串成一条链（第 13 章 rewind 靠它）
  assert.equal(recs[0].parentUuid, null);
  for (let i = 1; i < 4; i++) assert.equal(recs[i].parentUuid, recs[i - 1].uuid);
  assert.equal(recs[1].usage.input_tokens, 100);
  assert.equal(recs[2].message.content[0].type, "tool_result");
});

test("resume 恢复历史并接着写同一个文件", async () => {
  const { app } = makeApp(settings, [say("记住了，42")]);
  await app.handleLine("记住数字 42");
  const sid = app.session.id, path = app.session.path;

  // 「重启进程」：新的 App，同一个 home/cwd
  const { app: app2, client: client2, ui: ui2 } = makeApp(settings, [say("你让我记的是 42")]);
  await app2.handleLine("/resume");
  assert.ok(ui2.text.includes("记住数字 42"));
  await app2.handleLine("/resume 1");
  assert.equal(app2.session.id, sid);
  await app2.handleLine("我让你记的是几？");
  // 模型收到了完整历史
  const sent = client2.requests[0].messages;
  assert.equal(withoutSessionContext(sent[0].content), "记住数字 42");
  assert.equal(sent[1].role, "assistant");
  // 新消息追加在同一个文件上
  assert.equal(lines(path).length, 4);
  // usage 也从文件里恢复了
  assert.equal(app2.agent.usage.requests, 2);
});

test("/new 之后旧会话还在磁盘上", async () => {
  const { app } = makeApp(settings, [say("a"), say("b")]);
  await app.handleLine("第一个会话");
  const first = app.session.path;
  await app.handleLine("/new");
  await app.handleLine("第二个会话");
  assert.ok(existsSync(first) && app.session.path !== first);
  const titles = new Set(app.store.list().map((i) => i.title));
  assert.deepEqual(titles, new Set(["第一个会话", "第二个会话"]));
});

test("最后一行写了半截也能读", async () => {
  const { app } = makeApp(settings, [say("ok")]);
  await app.handleLine("hi");
  appendFileSync(app.session.path, '{"type": "assistant", "mess'); // 进程被杀时写了半行
  const [, msgs] = app.store.load(app.session.id);
  assert.equal(msgs.length, 2);
});

test("恢复时修复悬空的 tool_use", () => {
  const store = new SessionStore(settings.home, settings.cwd);
  const s = store.new();
  s.record({ role: "user", content: "go" });
  s.record({ role: "assistant", content: [toolBlock("Bash", { command: "sleep 99" }, "t1")] });
  const app = new App(settings, new FakeClient([]), { ui: new BufferUI() });
  app.resume(s.id);
  const last = (app.agent.messages.at(-1)!.content as any[])[0];
  assert.equal(last.tool_use_id, "t1");
  assert.equal(last.is_error, true);
  assert.equal(SessionStore.readRecords(s.path).length, 3); // 修复记录也落盘了
});

test("按 id 前缀解析，以及报错", async () => {
  const { app, ui } = makeApp(settings, [say("a")]);
  await app.handleLine("x");
  assert.equal(app.store.resolve(app.session.id.slice(0, 6)), app.session.id);
  await app.handleLine("/resume zzzz");
  assert.ok(ui.text.includes("没有会话匹配"));
});
