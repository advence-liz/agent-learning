/** 第 8 章：@ 引用文件。 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { FileMentionCompleter, findMentions, fuzzyScore, listProjectFiles, rank } from "../mini_cc/mentions.ts";
import { type Block, call, say } from "../mini_cc/model.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath, withoutSessionContext as strip } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

test("解析 @ 引用", () => {
  assert.deepEqual(findMentions("看看 @src/app.py 和 @README.md，然后改"), ["src/app.py", "README.md"]);
  assert.deepEqual(findMentions("发邮件给 a@b.com"), []); // 邮箱不算
  assert.deepEqual(findMentions('打开 @"my notes.txt" 吧'), ["my notes.txt"]);
  assert.deepEqual(findMentions("@a.py @a.py"), ["a.py"]); // 去重
});

test("文件作为附件放在用户原话之前", async () => {
  const { app, client, ui } = makeApp(settings, [say("DEBUG 目前是 True")]);
  writeFileSync(join(app.settings.cwd, "config.py"), "DEBUG = True\nPORT = 8000\n");
  await app.handleLine("@config.py 里 DEBUG 是多少？");
  const content = strip(client.requests[0].messages[0].content) as Block[];
  assert.ok(Array.isArray(content) && content.length === 2);
  assert.ok(content[0].text.startsWith("<system-reminder>"));
  assert.ok(content[0].text.includes("     1\tDEBUG = True"));
  assert.deepEqual(content[1], { type: "text", text: "@config.py 里 DEBUG 是多少？" });
  assert.ok(ui.text.includes("⎿ 已附加 @config.py（2 行）"));
});

test("被 @ 的文件算读过，可以直接 Edit", async () => {
  const { app, client } = makeApp(settings, [
    call("Edit", { file_path: "config.py", old_string: "DEBUG = True", new_string: "DEBUG = False" }),
    say("改好了"),
  ]);
  writeFileSync(join(app.settings.cwd, "config.py"), "DEBUG = True\n");
  await app.handleLine("把 @config.py 的 DEBUG 关掉");
  assert.equal(client.requests.length, 2); // 省掉了一轮 Read
  assert.equal(readFileSync(join(app.settings.cwd, "config.py"), "utf8"), "DEBUG = False\n");
});

test("不是路径的 @ 原样保留，目录列出条目", async () => {
  const { app, client } = makeApp(settings, [say("ok")]);
  mkdirSync(join(app.settings.cwd, "src"));
  writeFileSync(join(app.settings.cwd, "src", "a.py"), "");
  await app.handleLine("@nobody 帮我看下 @src");
  const content = strip(client.requests[0].messages[0].content) as Block[];
  assert.equal(content.length, 2);
  assert.ok(content[0].text.includes("a.py") && content[0].text.includes("directory @src"));
});

test("大文件截断", async () => {
  const { app, client } = makeApp(settings, [say("ok")]);
  writeFileSync(join(app.settings.cwd, "big.log"), Array.from({ length: 5000 }, (_, i) => `${i}\n`).join(""));
  await app.handleLine("@big.log 看下");
  const text = (strip(client.requests[0].messages[0].content) as Block[])[0].text;
  assert.ok(text.includes("showing first 2000 of 5000 lines"));
});

test("会话标题跳过附件", async () => {
  const { app } = makeApp(settings, [say("ok")]);
  writeFileSync(join(app.settings.cwd, "a.py"), "x=1\n");
  await app.handleLine("@a.py 解释一下");
  assert.equal(app.store.list()[0].title, "@a.py 解释一下");
});

test("模糊排序", () => {
  const files = ["src/components/Button.tsx", "src/utils/format.ts", "README.md", "src/components/button.css"];
  assert.deepEqual(rank("btn", files).slice(0, 2), ["src/components/Button.tsx", "src/components/button.css"]);
  assert.equal(rank("fmt", files)[0], "src/utils/format.ts");
  assert.equal(fuzzyScore("zzz", "README.md"), null);
});

test("文件列表跳过 node_modules", () => {
  const tmp = tmpPath();
  mkdirSync(join(tmp, "node_modules", "x"), { recursive: true });
  writeFileSync(join(tmp, "node_modules", "x", "i.js"), "");
  mkdirSync(join(tmp, "src"));
  writeFileSync(join(tmp, "src", "app.py"), "");
  const files = listProjectFiles(tmp);
  assert.ok(files.includes("src/app.py") && files.includes("src/"));
  assert.ok(!files.some((f) => f.includes("node_modules")));
});

test("补全候选", () => {
  const tmp = tmpPath();
  mkdirSync(join(tmp, "src"));
  writeFileSync(join(tmp, "src", "app.py"), "");
  writeFileSync(join(tmp, "setup.cfg"), "");
  const comp = new FileMentionCompleter(tmp);
  const got = comp.getCompletions("看看 @app").map((c) => c.text);
  assert.equal(got[0], "@src/app.py");
  assert.deepEqual(comp.getCompletions("没有 at 符号"), []);
});
