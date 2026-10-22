import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as sl from "./skill_loader.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "skills");

const tmpPath = () => mkdtempSync(join(tmpdir(), "skills-"));

test("手动专用的 skill 不进 listing", () => {
  const listing = sl.buildListing(sl.loadSkills(ROOT), 200_000);
  assert.ok(listing.includes("pr-summary") && !listing.includes("release-note"));
});

test("预算不够时只砍描述、不砍名字", () => {
  const skills = sl.loadSkills(ROOT);
  const small = sl.buildListing(skills, 1_000); // 预算 40 字符
  assert.equal(small, "- pr-summary");
});

test("参数替换与 shell 预处理", () => {
  const skills = sl.loadSkills(ROOT);
  const body = sl.renderBody(skills["pr-summary"], "develop");
  assert.ok(body.includes("git diff develop...HEAD"));
  assert.match(body, /\nv\d+\.\d+\.\d+\n/); // !`node --version` 被替换成了真实版本号
  assert.ok(!body.includes("!`"));
  assert.ok(body.startsWith("Base directory for this skill:"));
});

test("没有占位符时末尾追加 ARGUMENTS", () => {
  const tmp = tmpPath();
  mkdirSync(join(tmp, "x"));
  writeFileSync(join(tmp, "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\n做事");
  const body = sl.renderBody(sl.loadSkills(tmp).x, "foo");
  assert.ok(body.endsWith("ARGUMENTS: foo"));
});

test("预处理命令失败时整个调用中止", () => {
  const tmp = tmpPath();
  mkdirSync(join(tmp, "y"));
  writeFileSync(join(tmp, "y", "SKILL.md"), "---\nname: y\n---\n!`false`");
  assert.throws(() => sl.renderBody(sl.loadSkills(tmp).y, ""), Error);
});

test("调用只追加消息，不改已有消息", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const before = structuredClone(msgs);
  sl.invoke(msgs, sl.loadSkills(ROOT), "release-note", "v1..v2");
  assert.deepEqual(msgs.slice(0, 1), before);
  assert.ok(msgs.at(-1)!.content.includes("v1..v2"));
});
