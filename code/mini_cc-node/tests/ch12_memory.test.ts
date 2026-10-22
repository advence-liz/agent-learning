/** 第 12 章：长期记忆（文件式：MEMORY.md 索引 + 每条记忆一个 markdown）。 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { App } from "../mini_cc/cli.ts";
import type { Settings } from "../mini_cc/config.ts";
import { MAX_LINES, MemoryStore, slugify } from "../mini_cc/memory.ts";
import { type Block, call, FakeClient, say } from "../mini_cc/model.ts";
import { isRelativeTo } from "../mini_cc/tools/base.ts";
import { BufferUI } from "../mini_cc/ui.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

const save = (name = "commit 前缀", desc = "commit message 用 feat/fix 前缀", body = "规则：feat: / fix: 开头。") =>
  call("Memory", { action: "save", type: "feedback", name, description: desc, body });

const read = (p: string) => readFileSync(p, "utf8");
const lastResult = (client: FakeClient, i: number) => (client.requests[i].messages.at(-1)!.content as Block[])[0];

test("MemoryStore 保存、更新、删除", () => {
  const store = new MemoryStore(join(tmpPath(), "memory"));
  const [path, note] = store.save("feedback", "commit 前缀", "用 feat/fix 前缀", "规则正文", "commit-prefix");
  assert.equal(basename(path), "commit-prefix.md");
  assert.equal(note, "");
  assert.ok(read(path).startsWith("---\nname: commit 前缀\ndescription: 用 feat/fix 前缀\ntype: feedback\n---\n"));
  assert.equal(read(store.indexPath).trimEnd().split("\n").at(-1), "- [commit 前缀](commit-prefix.md) — 用 feat/fix 前缀");
  // 同一个 slug 再存一次 = 更新，索引里不会出现两行
  store.save("feedback", "commit 前缀", "改成 conventional commits", "新正文", "commit-prefix");
  assert.equal(read(store.indexPath).split("commit-prefix.md").length - 1, 1);
  assert.ok(read(store.indexPath).includes("conventional"));
  assert.ok(store.delete("commit-prefix") && !existsSync(path));
  assert.ok(!read(store.indexPath).includes("commit-prefix"));
  assert.ok(!store.delete("commit-prefix"));
});

test("slugify 处理中文", () => {
  assert.equal(slugify("Use pnpm, not npm!"), "use-pnpm-not-npm");
  const s = slugify("提交信息加前缀");
  assert.ok(s.startsWith("memory-") && s.length === "memory-".length + 8); // 纯中文名退化成稳定的哈希
  assert.equal(slugify("提交信息加前缀"), s);
});

test("进上下文的索引会被截断", () => {
  const store = new MemoryStore(join(tmpPath(), "memory"));
  for (let i = 0; i < MAX_LINES + 30; i++) store.save("project", `n${i}`, "一次性事实", "...", `n${i}`);
  const text = store.loadIndex();
  assert.ok(text.includes("(n0.md)") && !text.includes(`(n${MAX_LINES + 29}.md)`));
  assert.ok(text.includes("MEMORY.md is truncated"));
  // 接近上限时，保存结果会提醒模型精简索引
  const [, note] = store.save("project", "x", "y", "z", "x");
  assert.ok(note.includes("MEMORY.md") && note.includes("condense"));
});

test("模型保存记忆，不弹审批", async () => {
  const { app, client, ui } = makeApp(settings, [save(), say("记住了")]);
  await app.handleLine("以后 commit message 都加 feat/fix 这类前缀");
  assert.ok(!ui.text.includes("是否允许")); // 只写 agent 自己的记忆目录，免审批
  const store = app.memory;
  assert.ok(isRelativeTo(store.dir, settings.home));
  assert.deepEqual(store.entries().map((e) => e.slug), [slugify("commit 前缀")]);
  const result = lastResult(client, 1).content;
  assert.ok(result.includes("Saved memory") && result.includes("future sessions"));
});

test("记忆索引在下一个会话进 system", async () => {
  const { app, client } = makeApp(settings, [save(), say("记住了")]);
  await app.handleLine("以后 commit 加前缀");
  // 同一个会话里 system 不变（prompt cache 前缀稳定），记忆在下一个会话生效
  assert.ok(!client.requests[1].system.at(-1)!.text.includes("commit 前缀"));
  const client2 = new FakeClient([say("好")]);
  const app2 = new App(settings, client2, { ui: new BufferUI() });
  await app2.handleLine("帮我写个 commit message");
  const system = client2.requests[0].system.map((b) => b.text).join("\n");
  assert.ok(system.includes("# Memory") && system.includes("- [commit 前缀]") && system.includes(app2.memory.dir));
  // /new 也算新会话：system 重新计算
  await app.handleLine("/new");
  client.push(say("好"));
  await app.handleLine("hi");
  assert.ok(client.requests.at(-1)!.system.at(-1)!.text.includes("- [commit 前缀]"));
});

test("同一个仓库的子目录共用一份记忆", () => {
  const root = tmpPath();
  const repo = join(root, "repo");
  mkdirSync(join(repo, "pkg"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  const a = MemoryStore.forProject(join(root, "home"), repo);
  const b = MemoryStore.forProject(join(root, "home"), join(repo, "pkg"));
  assert.equal(a.dir, b.dir);
});

test("/memory 列出与删除", async () => {
  const { app, ui } = makeApp(settings, [save(), say("记住了")]);
  await app.handleLine("记一下 commit 前缀");
  await app.handleLine("/memory");
  assert.ok(ui.text.includes("commit 前缀") && ui.text.includes(app.memory.dir));
  await app.handleLine(`/memory rm ${slugify("commit 前缀")}`);
  assert.deepEqual(app.memory.entries(), []);
});

test("不合法的 Memory 调用返回错误", async () => {
  const { app, client } = makeApp(settings, [
    call("Memory", { action: "save", type: "mood", name: "x", description: "y", body: "z" }),
    call("Memory", { action: "delete", slug: "nope" }),
    say("ok"),
  ]);
  await app.handleLine("记");
  const r1 = lastResult(client, 1), r2 = lastResult(client, 2);
  assert.ok(r1.is_error && r2.is_error && r2.content.includes("No memory"));
});
