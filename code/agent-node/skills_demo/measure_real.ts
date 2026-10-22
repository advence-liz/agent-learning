#!/usr/bin/env node
/**
 * 只读统计 ~/.claude/skills：常驻层（frontmatter）和按需层（正文 + 支持文件）各有多大。
 *
 * 只打印数字，不打印任何 skill 内容。
 *
 * 运行：node skills_demo/measure_real.ts [skills 目录]
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import { DESC_CAP, loadSkills } from "./skill_loader.ts";

const arg = process.argv[2];
const root = arg ? arg.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".claude", "skills");
const skills = Object.values(loadSkills(root));
// 按 Unicode 码点数字符（和 Python 的 len() 一致）；JS 的 .length 数的是 UTF-16 码元，emoji 会算成 2
const chars = (s: string) => [...s].length;
const descChars = skills.reduce((n, s) => n + Math.min(chars(s.description), DESC_CAP), 0);
const bodyChars = skills.reduce((n, s) => n + chars(s.body), 0);
const EXTS = new Set([".md", ".py", ".sh", ".js", ".txt", ".json"]);
let extra = 0;
for (const s of skills) {
  for (const f of readdirSync(s.dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile() && f.name !== "SKILL.md" && EXTS.has(extname(f.name))) {
      extra += statSync(join(f.parentPath, f.name)).size;
    }
  }
}
const overCap = skills.filter((s) => chars(s.description) > DESC_CAP).length;
const manualOnly = skills.filter((s) => s.meta["disable-model-invocation"] === "true").length;
const n = (x: number) => x.toLocaleString("en-US").padStart(9);
console.log(`skills: ${skills.length}  (disable-model-invocation: ${manualOnly}, description 超 ${DESC_CAP} 字符: ${overCap})`);
console.log(`L1 常驻 description 合计: ${n(descChars)} 字符`);
console.log(`L2 SKILL.md 正文合计:     ${n(bodyChars)} 字符  (${(bodyChars / Math.max(descChars, 1)).toFixed(0)}x)`);
console.log(`L3 支持文件合计:          ${n(extra)} 字节`);
