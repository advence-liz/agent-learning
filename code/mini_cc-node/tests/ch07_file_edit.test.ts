/** 第 7 章：可靠的文件编辑——先读后改、读后未变、唯一匹配、replace_all。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { call, say } from "../mini_cc/model.ts";
import { ACCEPT_EDITS, PermissionManager } from "../mini_cc/permissions.ts";
import { defaultTools, ToolContext, ToolRegistry } from "../mini_cc/tools/index.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

/** 同 Python 的 env fixture：一个临时目录 + 注册表 + 上下文，run(name, args) 直接执行工具。 */
function env() {
  const root = tmpPath();
  const reg = new ToolRegistry(defaultTools());
  const ctx = new ToolContext(root);
  const run = (name: string, args: Record<string, any>) => reg.execute(name, args, ctx);
  return { root, run, ctx };
}

const read = (p: string) => readFileSync(p, "utf8");

test("Read 带行号，并登记文件状态", async () => {
  const { root, run, ctx } = env();
  writeFileSync(join(root, "a.py"), "x = 1\ny = 2\n");
  const r = await run("Read", { file_path: "a.py" });
  assert.equal(r.content, "     1\tx = 1\n     2\ty = 2");
  assert.notEqual(ctx.fileState.get(join(root, "a.py")), undefined);
});

test("Read 的 offset / limit", async () => {
  const { root, run, ctx } = env();
  writeFileSync(join(root, "big.txt"), Array.from({ length: 100 }, (_, i) => `line${i + 1}\n`).join(""));
  const r = await run("Read", { file_path: "big.txt", offset: 50, limit: 2 });
  assert.ok(String(r.content).startsWith("    50\tline50\n    51\tline51"));
  assert.ok(String(r.content).includes("[showing lines 50-51 of 100]"));
  assert.equal(ctx.fileState.get(join(root, "big.txt"))!.partial, true);
});

test("没读过不许 Edit", async () => {
  const { root, run } = env();
  writeFileSync(join(root, "a.py"), "x = 1\n");
  const r = await run("Edit", { file_path: "a.py", old_string: "x = 1", new_string: "x = 2" });
  assert.ok(r.isError && String(r.content).includes("File has not been read yet"));
  assert.equal(read(join(root, "a.py")), "x = 1\n");
});

test("覆盖已存在文件要先读，新文件可以直接写", async () => {
  const { root, run } = env();
  assert.equal((await run("Write", { file_path: "new.txt", content: "hi" })).isError, false);
  writeFileSync(join(root, "old.txt"), "keep me");
  const r = await run("Write", { file_path: "old.txt", content: "clobber" });
  assert.ok(r.isError);
  assert.equal(read(join(root, "old.txt")), "keep me");
});

test("读后被外部修改，必须重读", async () => {
  const { root, run } = env();
  const f = join(root, "a.py");
  writeFileSync(f, "x = 1\n");
  await run("Read", { file_path: "a.py" });
  await sleep(10);
  writeFileSync(f, "x = 1\n# 你在编辑器里加了一行\n"); // 外部修改
  const r = await run("Edit", { file_path: "a.py", old_string: "x = 1", new_string: "x = 2" });
  assert.ok(r.isError && String(r.content).includes("modified since read"));
  await run("Read", { file_path: "a.py" });
  assert.equal((await run("Edit", { file_path: "a.py", old_string: "x = 1", new_string: "x = 2" })).isError, false);
  assert.ok(read(f).includes("你在编辑器里加了一行")); // 外部修改没被覆盖
});

test("只 touch 不改内容不算过期", async () => {
  const { root, run } = env();
  const f = join(root, "a.py");
  writeFileSync(f, "x = 1\n");
  await run("Read", { file_path: "a.py" });
  const st = statSync(f);
  utimesSync(f, st.atime, new Date(st.mtimeMs + 10)); // mtime 往后挪 10ms
  assert.equal((await run("Edit", { file_path: "a.py", old_string: "x = 1", new_string: "x = 2" })).isError, false);
});

test("唯一匹配与 replace_all", async () => {
  const { root, run } = env();
  const f = join(root, "a.py");
  writeFileSync(f, "print('a')\nprint('a')\n");
  await run("Read", { file_path: "a.py" });
  let r = await run("Edit", { file_path: "a.py", old_string: "print('a')", new_string: "print('b')" });
  assert.ok(r.isError && String(r.content).includes("Found 2 matches") && String(r.content).includes("replace_all"));
  r = await run("Edit", { file_path: "a.py", old_string: "print('a')", new_string: "print('b')", replace_all: true });
  assert.ok(!r.isError && String(r.content).includes("2 replacements"));
  assert.equal(read(f), "print('b')\nprint('b')\n");
});

test("多给上下文就唯一了", async () => {
  const { root, run } = env();
  const f = join(root, "a.py");
  writeFileSync(f, "def a():\n    return 1\n\ndef b():\n    return 1\n");
  await run("Read", { file_path: "a.py" });
  const r = await run("Edit", { file_path: "a.py", old_string: "def b():\n    return 1", new_string: "def b():\n    return 2" });
  assert.equal(r.isError, false);
  assert.equal(read(f), "def a():\n    return 1\n\ndef b():\n    return 2\n");
  assert.ok(String(r.content).includes("     5\t    return 2")); // 返回改动附近的带行号片段
});

test("no-op 编辑被拒绝", async () => {
  const { root, run } = env();
  writeFileSync(join(root, "a.py"), "x\n");
  await run("Read", { file_path: "a.py" });
  const r = await run("Edit", { file_path: "a.py", old_string: "x", new_string: "x" });
  assert.ok(String(r.content).includes("No changes to make"));
});

test("找不到时给出诊断", async () => {
  const { root, run } = env();
  const f = join(root, "a.py");
  writeFileSync(f, "def f():\n    return 1\n");
  await run("Read", { file_path: "a.py" });
  let r = await run("Edit", { file_path: "a.py", old_string: "     2\t    return 1", new_string: "    return 2" });
  assert.ok(String(r.content).includes("line-number prefixes"));
  r = await run("Edit", { file_path: "a.py", old_string: "\treturn 1", new_string: "\treturn 2" }); // 文件里是 4 空格
  assert.ok(String(r.content).includes("indentation"));
  writeFileSync(f, "msg = “hi”\n");
  await run("Read", { file_path: "a.py" });
  r = await run("Edit", { file_path: "a.py", old_string: 'msg = "hi"', new_string: 'msg = "yo"' });
  assert.ok(String(r.content).includes("curly quotes"));
});

test("CRLF 保留", async () => {
  const { root, run } = env();
  const f = join(root, "win.txt");
  writeFileSync(f, Buffer.from("a\r\nb\r\n"));
  await run("Read", { file_path: "win.txt" });
  assert.equal((await run("Edit", { file_path: "win.txt", old_string: "a\nb", new_string: "a\nB" })).isError, false);
  assert.deepEqual(readFileSync(f), Buffer.from("a\r\nB\r\n"));
});

test("空 old_string 新建文件，自己写的文件接着改不用重读", async () => {
  const { root, run } = env();
  assert.equal((await run("Edit", { file_path: "pkg/new.py", old_string: "", new_string: "x = 1\n" })).isError, false);
  // 自己刚写的文件，接着改不需要重读
  assert.equal((await run("Edit", { file_path: "pkg/new.py", old_string: "x = 1", new_string: "x = 2" })).isError, false);
  assert.equal(read(join(root, "pkg/new.py")), "x = 2\n");
});

test("写盘前调用 writeHooks", async () => {
  const { run, ctx } = env();
  const seen: Array<[string, boolean]> = [];
  ctx.writeHooks.push((p) => seen.push([basename(p), existsSync(p)]));
  await run("Write", { file_path: "a.txt", content: "1" });
  assert.deepEqual(seen, [["a.txt", false]]);
});

test("Edit 在权限上算编辑类工具", async () => {
  const edit = defaultTools().find((t) => t.name === "Edit")!;
  const pm = new PermissionManager(tmpPath(), { mode: ACCEPT_EDITS });
  assert.equal((await pm.decide(edit, { file_path: "a.py", old_string: "a", new_string: "b" })).behavior, "allow");
});

test("agent 级：Edit 失败 → Read → Edit 成功", async () => {
  const { app, client } = makeApp(settings, [
    call("Edit", { file_path: "app.py", old_string: "DEBUG = True", new_string: "DEBUG = False" }),
    call("Read", { file_path: "app.py" }),
    call("Edit", { file_path: "app.py", old_string: "DEBUG = True", new_string: "DEBUG = False" }),
    say("已关闭 DEBUG"),
  ]);
  writeFileSync(join(app.settings.cwd, "app.py"), "DEBUG = True\n");
  await app.handleLine("关掉 debug");
  const first = (client.requests[1].messages.at(-1)!.content as any[])[0];
  assert.ok(first.is_error && first.content.includes("Read it first"));
  assert.equal(read(join(app.settings.cwd, "app.py")), "DEBUG = False\n");
});
