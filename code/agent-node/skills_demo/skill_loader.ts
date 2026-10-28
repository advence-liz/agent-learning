#!/usr/bin/env node
/**
 * 渐进式披露（progressive disclosure）的最小实现。
 *
 * 三层，按需逐层进入上下文：
 *   L1 listing   —— 每个 skill 只有 name + description，常驻（会话开始就注入）
 *   L2 SKILL.md  —— 被调用时，渲染后的正文作为一条消息追加到对话末尾
 *   L3 支持文件  —— 正文里只放路径，模型自己决定要不要 Read
 *
 * 和官方文档对齐的规则：
 *   - 每条 description（含 when_to_use）在 listing 里截断到 1536 字符；
 *   - listing 总预算 = 上下文窗口的 1%，超了先砍「最少用」的 description，只留名字；
 *   - disable-model-invocation: true 的 skill 不进 listing（模型看不到，只能用户 /name）；
 *   - $ARGUMENTS / $N / ${CLAUDE_SKILL_DIR} 替换；!`cmd` 在发给模型前先执行、输出替换占位；
 *   - 没有占位符接收参数时，末尾追加 "ARGUMENTS: <value>"。
 *
 * 运行：node skills_demo/skill_loader.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DESC_CAP = 1536;

export type Skill = {
  name: string;
  description: string;
  meta: Record<string, string>;
  body: string;
  dir: string;
};

/** 极简 YAML：`key: value` 单行，外加 `key: >-` / `key: |` 的缩进续行（真实实现是完整 YAML）。 */
export function parseFrontmatter(text: string): [Record<string, string>, string] {
  if (!text.startsWith("---\n")) return [{}, text]; // 首行不是 --- → 整个文件当正文
  const end = text.indexOf("\n---", 4);
  if (end < 0) throw new Error("frontmatter 没有结束的 ---");
  const meta: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.slice(4, end).split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && key) {
      meta[key] = (meta[key] + " " + line.trim()).trim();
    } else if (line.includes(":")) {
      const i = line.indexOf(":");
      key = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      meta[key] = [">", ">-", "|", "|-"].includes(v) ? "" : v.replace(/^"+|"+$/g, "");
    }
  }
  return [meta, text.slice(end + 4).replace(/^\n+/, "")];
}

export function loadSkills(root: string): Record<string, Skill> {
  const out: Record<string, Skill> = {};
  for (const d of readdirSync(root).sort()) {
    const p = join(root, d, "SKILL.md");
    if (!existsSync(p)) continue;
    const [meta, body] = parseFrontmatter(readFileSync(p, "utf8"));
    const name = meta.name ?? d;
    const desc = ((meta.description ?? "") + " " + (meta.when_to_use ?? "")).trim();
    out[name] = { name, description: desc, meta, body, dir: join(root, d) };
  }
  return out;
}

/** L1：拼出常驻的 skill 清单。预算按字符算（1% 上下文 × 每 token 约 4 字符，粗估）。 */
export function buildListing(
  skills: Record<string, Skill>,
  contextWindowTokens: number,
  { usage = {}, charsPerToken = 4 }: { usage?: Record<string, number>; charsPerToken?: number } = {},
): string {
  const budget = Math.floor(contextWindowTokens * 0.01 * charsPerToken);
  const visible = Object.values(skills).filter((s) => s.meta["disable-model-invocation"] !== "true");
  const entries: Record<string, string> = Object.fromEntries(visible.map((s) => [s.name, s.description.slice(0, DESC_CAP)]));

  const render = () =>
    Object.entries(entries)
      .map(([n, d]) => (d ? `- ${n}: ${d}` : `- ${n}`))
      .join("\n");

  for (const name of Object.keys(entries).sort((a, b) => (usage[a] ?? 0) - (usage[b] ?? 0))) {
    // 最少用的先被砍
    if (render().length <= budget) break;
    entries[name] = "";
  }
  return render();
}

/** 简化版 shlex.split：按空白切分，支持单/双引号。 */
function shellSplit(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** L2：调用时才渲染正文。 */
export function renderBody(skill: Skill, args: string): string {
  const argv = args ? shellSplit(args) : [];
  let body = skill.body;
  let used = false;

  if (body.includes("$ARGUMENTS")) {
    used = true;
    body = body.replaceAll("$ARGUMENTS", () => args); // 用函数做替换值，避免 args 里的 $ 被当成特殊模式
  }
  body = body.replace(/\$(\d+)/g, (_, n: string) => {
    used = true;
    return argv[Number(n)] ?? "";
  });
  body = body.replaceAll("${CLAUDE_SKILL_DIR}", () => skill.dir);

  body = body.replace(/(?<!\S)!`([^`]+)`/gm, (_, cmd: string) => {
    const r = spawnSync(cmd, { shell: true, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`skill 预处理命令失败，整个调用中止：${cmd}`);
    return r.stdout.trim();
  });
  if (args && !used) body += `\n\nARGUMENTS: ${args}`;
  return `Base directory for this skill: ${skill.dir}\n\n${body}`;
}

/** 把渲染结果**追加**到对话末尾（不改前面任何内容 → prompt cache 前缀不动）。 */
export function invoke(
  messages: Array<{ role: string; content: string }>,
  skills: Record<string, Skill>,
  name: string,
  args = "",
): void {
  messages.push({ role: "user", content: renderBody(skills[name], args) });
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "skills");
  const skills = loadSkills(root);
  console.log("== L1 listing（常驻）==");
  console.log(buildListing(skills, 200_000));
  console.log("\n== L1 listing，上下文只有 1.5k token 时（预算 60 字符）==");
  console.log(buildListing(skills, 1_500));
  const msgs: Array<{ role: string; content: string }> = [];
  invoke(msgs, skills, "pr-summary", "develop");
  console.log("\n== L2 调用 /pr-summary develop 后追加的消息 ==");
  console.log(msgs.at(-1)!.content.replaceAll(root, "<skills_demo/skills>"));
}
