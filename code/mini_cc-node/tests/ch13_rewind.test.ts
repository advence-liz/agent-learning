/** 第 13 章：/rewind 回退对话和代码。 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { App } from "../mini_cc/cli.ts";
import type { Settings } from "../mini_cc/config.ts";
import { call, FakeClient, type Message, say } from "../mini_cc/model.ts";
import { FileHistory } from "../mini_cc/rewind.ts";
import { BufferUI } from "../mini_cc/ui.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const read = (p: string) => readFileSync(p, "utf8");

/** 第 1 轮：新建 a.py；第 2 轮：改 a.py、新建 b.py。 */
async function twoTurns() {
  const made = makeApp(settings, [
    call("Write", { file_path: "a.py", content: "x = 1\n" }), say("建好了"),
    call("Read", { file_path: "a.py" }),
    call("Edit", { file_path: "a.py", old_string: "x = 1", new_string: "x = 2" }),
    call("Write", { file_path: "b.py", content: "y = 1\n" }), say("改好了"),
  ]);
  made.app.agent.permissions.setMode("acceptEdits");
  await made.app.handleLine("建 a.py");
  const firstTurn: Message[] = structuredClone(made.app.agent.messages);
  await made.app.handleLine("把 x 改成 2，再建 b.py");
  return { ...made, firstTurn };
}

test("FileHistory 每个检查点每个文件只备份一次", () => {
  const root = tmpPath();
  const proj = join(root, "p");
  mkdirSync(proj);
  const f = join(proj, "f.txt");
  writeFileSync(f, "v0");
  const h = new FileHistory(join(root, "fh"));
  h.begin("m1", "第一轮");
  h.beforeWrite(f);
  writeFileSync(f, "v1");
  h.beforeWrite(f); // 同一检查点里第二次写：不再备份（要的是「这一轮开始前」的版本）
  writeFileSync(f, "v2");
  h.begin("m2", "第二轮");
  h.beforeWrite(join(proj, "new.txt")); // 写之前不存在 → 记成 null
  writeFileSync(join(proj, "new.txt"), "n");
  assert.ok(h.checkpoints[0].files[f]!.endsWith("@v1"));
  assert.deepEqual(h.checkpoints[1].files, { [join(proj, "new.txt")]: null });
  const changes = h.restore("m1");
  assert.equal(read(f), "v0");
  assert.ok(!existsSync(join(proj, "new.txt")));
  assert.deepEqual(changes.map(([, a]) => a).sort(), ["deleted", "restored"]);
  // 落盘后能读回（/resume 之后照样能回退代码）
  const again = FileHistory.load(join(root, "fh"));
  assert.deepEqual(again.checkpoints.map((c) => c.uuid), ["m1", "m2"]);
});

test("/rewind 列出检查点", async () => {
  const { app, ui } = await twoTurns();
  await app.handleLine("/rewind");
  assert.ok(ui.text.includes("1. 建 a.py") && ui.text.includes("2. 把 x 改成 2，再建 b.py"));
  assert.ok(ui.text.includes("改了 2 个文件"));
});

test("/rewind both：恢复代码、截断历史", async () => {
  const { app, ui, firstTurn } = await twoTurns();
  assert.equal(read(join(settings.cwd, "a.py")), "x = 2\n");
  const nBefore = app.agent.messages.length;
  await app.handleLine("/rewind 2");
  assert.equal(read(join(settings.cwd, "a.py")), "x = 1\n");
  assert.ok(!existsSync(join(settings.cwd, "b.py")));
  assert.equal(app.agent.messages.length, 4); // 只剩第 1 轮
  assert.equal(firstTurn.length, 4);
  assert.ok(4 < nBefore);
  assert.ok(ui.text.includes("原话：把 x 改成 2，再建 b.py"));
  // 回退后历史是原来的前缀：逐字节相同（prompt cache 和 thinking 块都还有效）
  assert.deepEqual(app.agent.messages, firstTurn);
  // 回退后文件状态清空：模型得重新 Read 才能改
  assert.deepEqual(app.agent.ctx.fileState.paths(), []);
});

test("/rewind conversation：只回退对话，文件保留", async () => {
  const { app, firstTurn } = await twoTurns();
  await app.handleLine("/rewind 2 conversation");
  assert.ok(existsSync(join(settings.cwd, "b.py")));
  assert.deepEqual(app.agent.messages, firstTurn);
});

test("/rewind code：只恢复代码，对话保留", async () => {
  const { app, ui } = await twoTurns();
  const n = app.agent.messages.length;
  await app.handleLine("/rewind 2 code");
  assert.equal(read(join(settings.cwd, "a.py")), "x = 1\n");
  assert.equal(app.agent.messages.length, n);
  assert.ok(ui.text.includes("b.py"));
});

test("会话文件分叉，/resume 沿新分支走", async () => {
  const { app, client } = await twoTurns();
  const sid = app.session.id;
  await app.handleLine("/rewind 2");
  client.push(say("换个做法"));
  await app.handleLine("只把 x 改成 3");
  const recs = read(app.session.path).trim().split("\n").map((ln) => JSON.parse(ln));
  const msgs = recs.filter((r) => r.type === "user" || r.type === "assistant");
  // 文件只追加：废弃分支的记录还在，新消息的 parentUuid 指回分叉点
  const newUser = msgs.find((r) => JSON.stringify(r.message).includes("只把 x 改成 3"))!;
  assert.equal(newUser.parentUuid, msgs[3].uuid); // 第 1 轮最后一条 assistant
  const app2 = new App(settings, new FakeClient([]), { ui: new BufferUI() });
  app2.resume(sid);
  const texts = JSON.stringify(app2.agent.messages);
  assert.ok(texts.includes("只把 x 改成 3") && !texts.includes("再建 b.py"));
  assert.equal(app2.agent.messages.length, 6);
});

test("Bash 改的文件不在检查点里", async () => {
  const { app, ui } = makeApp(settings, [call("Bash", { command: "echo hi > c.txt" }), say("ok")]);
  ui.answers = ["1"];
  await app.handleLine("用 bash 建 c.txt");
  await app.handleLine("/rewind 1 code");
  assert.ok(existsSync(join(settings.cwd, "c.txt")));
  assert.ok(ui.text.includes("没有可恢复的文件改动"));
});

test("/rewind 参数不对", async () => {
  const { app, ui } = makeApp(settings, [say("hi")]);
  await app.handleLine("/rewind");
  assert.ok(ui.text.includes("还没有可回退的检查点"));
  await app.handleLine("hello");
  await app.handleLine("/rewind 9");
  assert.ok(ui.text.includes("没有第 9 个检查点"));
  await app.handleLine("/rewind 1 everything");
  assert.ok(ui.text.includes("both / conversation / code"));
});
