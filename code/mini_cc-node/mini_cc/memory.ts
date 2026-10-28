/**
 * 长期记忆（第 12 章）：一个目录 = 一份 MEMORY.md 索引 + 每条记忆一个 markdown 主题文件。
 *
 * - 写：模型调用 Memory 工具（tools/memory_tool.ts），同时写主题文件和索引里的一行。
 * - 读：会话开始时，索引（截到 200 行 / 25KB）进 system；主题文件不预加载，模型觉得相关再用 Read 读。
 * - 位置：<home>/projects/<仓库根的 slug>/memory/，同一个仓库的子目录共用一份（和 Claude Code 一样按 git 根算）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRoot } from "./context.ts";
import { projectSlug } from "./session.ts";
import { splitLines } from "./tools/file_state.ts";

export const TYPES = ["user", "feedback", "project", "reference"];
export const MAX_LINES = 200; // 和 Claude Code 文档一致：会话开始只加载索引前 200 行或 25KB
export const MAX_BYTES = 25_000;
export const WARN_RATIO = 0.9; // 超过上限的 90% 就在保存结果里提醒模型精简
const INDEX_LINE = /^- \[(?<name>.+?)\]\((?<slug>[^)]+?)\.md\) — (?<desc>.*)$/;

const GUIDE = (dir: string, index: string) => `# Memory
You have a persistent, file-based memory for this project at ${dir}. It survives across sessions.
MEMORY.md (below) is the index: one line per memory, each pointing at a topic file in that directory.
Only the index is loaded at session start. Read a topic file when its line looks relevant to the task.

Save a memory with the Memory tool when you learn something that will matter in FUTURE sessions:
- user: who the user is (role, expertise, how they like to collaborate)
- feedback: a correction or a confirmed preference about how to work; include the reason
- project: goals, decisions, constraints or deadlines that are not visible in the code
- reference: where to find things outside the repo (docs, dashboards, tickets)
Do NOT save: anything derivable from the code or git history, anything already in AGENTS.md / CLAUDE.md,
details of the current task only, or secrets. Update an existing memory (same slug) instead of adding a
duplicate, and delete memories that turn out to be wrong. When the user explicitly asks you to remember or
forget something, do it right away.

## MEMORY.md
${index}`;

/** 文件名：ASCII 部分转小写短横线；含非 ASCII（比如中文）时补一段稳定哈希，避免「提交前缀」「提交规范」撞名。 */
export function slugify(name: string): string {
  const asciiPart = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (/^[\x00-\x7f]*$/.test(name)) return asciiPart || "memory";
  const h = createHash("sha1").update(name, "utf8").digest("hex").slice(0, 8);
  return asciiPart ? `${asciiPart}-${h}` : `memory-${h}`;
}

export interface Entry {
  name: string;
  slug: string;
  description: string;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

export class MemoryStore {
  dir: string;
  indexPath: string;

  constructor(dir: string) {
    this.dir = dir;
    this.indexPath = join(dir, "MEMORY.md");
  }

  static forProject(home: string, cwd: string): MemoryStore {
    return new MemoryStore(join(home, "projects", projectSlug(gitRoot(cwd) ?? cwd), "memory"));
  }

  // ------------------------------------------------------------ 索引

  private lines(): string[] {
    return existsSync(this.indexPath) ? splitLines(readFileSync(this.indexPath, "utf8")) : [];
  }

  entries(): Entry[] {
    const out: Entry[] = [];
    for (const ln of this.lines()) {
      const m = INDEX_LINE.exec(ln);
      if (m) out.push({ name: m.groups!.name, slug: m.groups!.slug, description: m.groups!.desc });
    }
    return out;
  }

  /** 进上下文的那一份：前 MAX_LINES 行且不超过 MAX_BYTES。超出的部分模型看不见，所以要明说。 */
  loadIndex(): string {
    const lines = this.lines();
    const kept: string[] = [];
    let size = 0;
    for (const ln of lines.slice(0, MAX_LINES)) {
      const n = bytes(ln) + 1;
      if (size + n > MAX_BYTES) break;
      kept.push(ln);
      size += n;
    }
    let text = kept.join("\n");
    if (kept.length < lines.length) {
      text += `\n\n(MEMORY.md is truncated: ${lines.length - kept.length} more lines were not loaded. ` +
        "Condense the index.)";
    }
    return text;
  }

  private sizeNote(): string {
    const lines = this.lines();
    const size = bytes(lines.join("\n"));
    if (lines.length < MAX_LINES * WARN_RATIO && size < MAX_BYTES * WARN_RATIO) return "";
    return `\nNote: MEMORY.md is at ${lines.length}/${MAX_LINES} lines and ${size}/${MAX_BYTES} bytes. ` +
      "Please condense it: one short line per memory, merge or delete stale entries. " +
      "Lines past the limit are NOT loaded into future sessions.";
  }

  private writeIndex(lines: string[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, "MEMORY.tmp");
    writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
    renameSync(tmp, this.indexPath);
  }

  // ------------------------------------------------------------ 写

  /** 返回 [主题文件路径, 接近上限时的提醒]。 */
  save(type: string, name: string, description: string, body: string, slug?: string): [string, string] {
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
    slug ||= slugify(name);
    name = name.trim().replaceAll("\n", " ");
    description = description.trim().replaceAll("\n", " ");
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${slug}.md`);
    writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n${body.trim()}\n`, "utf8");
    const line = `- [${name}](${slug}.md) — ${description}`;
    const lines = this.lines();
    const hit = lines.findIndex((ln) => ln.includes(`](${slug}.md)`));
    if (hit >= 0) lines[hit] = line; // 同一个 slug：原地更新那一行，索引里不会重复
    else lines.push(line);
    this.writeIndex(lines);
    return [path, this.sizeNote()];
  }

  delete(slug: string): boolean {
    const path = join(this.dir, `${slug}.md`);
    const lines = this.lines();
    const kept = lines.filter((ln) => !ln.includes(`](${slug}.md)`));
    if (!existsSync(path) && kept.length === lines.length) return false;
    rmSync(path, { force: true });
    this.writeIndex(kept);
    return true;
  }

  // ------------------------------------------------------------ 进上下文

  /** 挂到 ContextBuilder.systemSections：会话开始时求值一次，会话内保持不变（prompt cache 前缀稳定）。 */
  systemSection(): string {
    return GUIDE(this.dir, this.loadIndex() || "(empty: no memories saved yet)");
  }
}
