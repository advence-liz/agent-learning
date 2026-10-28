/** 第 20 章：渐进式加载 Skills。 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import { type Block, call, say } from "../mini_cc/model.ts";
import { listing, loadSkills, renderBody } from "../mini_cc/skills.ts";
import { cleanupTmp, makeApp, makeSettings, tmpPath } from "./conftest.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

function skill(root: string, name: string, desc: string, body: string, extra = ""): string {
  const d = join(root, name);
  mkdirSync(join(d, "references"), { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n${body}`);
  writeFileSync(join(d, "references", "checklist.md"), "# 很长的检查清单\n" + "- item\n".repeat(200));
  return d;
}

function setup(s: Settings): string {
  const root = join(s.home, "skills");
  skill(root, "pr-summary", "汇总当前分支的改动写成 PR 描述。触发：写 PR 描述",
    "# PR 描述\n基线分支：$0（默认 main）\n涉及 UI 时查 ${SKILL_DIR}/references/checklist.md\n");
  skill(root, "release-note", "写发版说明", "# 发版说明\n版本：$ARGUMENTS\n", "disable-model-invocation: true\n");
  skill(join(s.cwd, ".mini_cc", "skills"), "fix-lint", "修 lint 报错", "# 修 lint\n先跑 !`echo eslint-v9`\n");
  return root;
}

test("发现 skill，生成目录", () => {
  setup(settings);
  const skills = loadSkills(settings.cwd, settings.home);
  assert.deepEqual(new Set(skills.keys()), new Set(["pr-summary", "release-note", "fix-lint"]));
  assert.ok(skills.get("fix-lint")!.scope === "project" && skills.get("release-note")!.modelInvocable === false);
  const text = listing(skills.values(), 10_000);
  assert.ok(text.includes("- pr-summary: 汇总当前分支") && !text.includes("release-note")); // 手动专用的不进目录
});

test("超预算时先砍用得最少的描述", () => {
  setup(settings);
  const skills = loadSkills(settings.cwd, settings.home);
  const text = listing(skills.values(), 60, { "pr-summary": 5 });
  assert.ok(text.includes("- pr-summary: 汇总")); // 用得多的保留描述
  assert.ok((text + "\n").includes("- fix-lint\n")); // 用得少的只剩名字
  assert.ok(text.includes("descriptions omitted"));
});

test("渲染参数、目录占位符和 !`cmd`", async () => {
  setup(settings);
  const tmp = tmpPath();
  const skills = loadSkills(settings.cwd, settings.home);
  const pr = skills.get("pr-summary")!;
  const body = await renderBody(pr, "develop", tmp);
  assert.ok(body.startsWith(`Base directory for this skill: ${pr.dir}`));
  assert.ok(body.includes("基线分支：develop") && body.includes(`${pr.dir}/references/checklist.md`));
  assert.ok(!body.includes("很长的检查清单")); // 第 3 层不自动加载
  assert.ok((await renderBody(skills.get("fix-lint")!, "", tmp)).endsWith("先跑 eslint-v9\n"));
  const noPlaceholder = await renderBody(skills.get("fix-lint")!, "src/a.ts", tmp);
  assert.ok(noPlaceholder.trimEnd().endsWith("ARGUMENTS: src/a.ts"));
});

test("模型调 Skill 工具", async () => {
  setup(settings);
  const { app, client, ui } = makeApp(settings, [call("Skill", { skill: "pr-summary", args: "develop" }), say("写好了")]);
  await app.handleLine("帮我写个 PR 描述");
  const system = client.requests[0].system.map((b) => b.text).join("\n");
  assert.ok(system.includes("# Skills") && system.includes("- pr-summary:") && !system.includes("# PR 描述")); // 第 1 层只有目录
  const last = client.requests[1].messages.at(-1)!.content as Block[];
  assert.ok(last[0].type === "tool_result" && last[0].content === "Launching skill: pr-summary");
  const body = last.slice(1).find((b) => b.type === "text" && b.text.includes("Base directory"))!.text;
  assert.ok(body.includes("基线分支：develop")); // 第 2 层：作为一条普通文本追加在结果之后
  assert.ok(ui.text.includes("pr-summary"));
});

test("手动专用和不存在的 skill 被拒绝", async () => {
  setup(settings);
  const { app, client } = makeApp(settings, [call("Skill", { skill: "release-note" }), call("Skill", { skill: "nope" }), say("ok")]);
  await app.handleLine("发版");
  const r1 = (client.requests[1].messages.at(-1)!.content as Block[])[0];
  const r2 = (client.requests[2].messages.at(-1)!.content as Block[])[0];
  assert.ok(r1.is_error && r1.content.includes("only by the user"));
  assert.ok(r2.is_error && r2.content.includes("pr-summary"));
});

test("/skill-name 展开成 prompt", async () => {
  setup(settings);
  const { app, client, ui } = makeApp(settings, [say("v1.2.0 发版说明如下")]);
  await app.handleLine("/release-note v1.2.0");
  const blob = JSON.stringify(client.requests[0].messages[0].content);
  assert.ok(blob.includes("<command-name>/release-note</command-name>") && blob.includes("版本：v1.2.0"));
  assert.ok(!ui.text.includes("未知命令"));
});

test("预处理命令失败，整个调用失败", async () => {
  skill(join(settings.home, "skills"), "broken", "坏的", "x !`exit 3` y");
  const { app, client } = makeApp(settings, [call("Skill", { skill: "broken" }), say("ok")]);
  await app.handleLine("用 broken");
  const r = (client.requests[1].messages.at(-1)!.content as Block[])[0];
  assert.ok(r.is_error && r.content.includes("exit code 3"));
});

test("调用过的 skill 压缩后还在", async () => {
  setup(settings);
  const { app } = makeApp(settings, [call("Skill", { skill: "pr-summary", args: "develop" }), say("ok"),
    say("<summary>在写 PR 描述</summary>")]);
  await app.handleLine("写 PR 描述");
  await app.handleLine("/compact");
  const blob = JSON.stringify(app.agent.messages[0]);
  assert.ok(blob.includes("基线分支：develop") && blob.includes("Re-attached skill after compaction: pr-summary"));
});

test("/skills 列出全部", async () => {
  setup(settings);
  const { app, ui } = makeApp(settings);
  await app.handleLine("/skills");
  assert.ok(ui.text.includes("pr-summary") && ui.text.includes("release-note") && ui.text.includes("手动"));
});
