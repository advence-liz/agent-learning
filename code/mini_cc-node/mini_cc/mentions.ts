/**
 * @ 引用文件：输入时补全路径，提交时把文件内容作为附件塞进这条 user 消息。（第 8 章；第 19 章加图片）
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { Attachment, render } from "./attachments.ts";
import { findImagePaths, ImageError, isImagePath, loadImage } from "./images.ts";
import type { Block } from "./model.ts";
import { realResolve, type ToolContext } from "./tools/base.ts";
import { readText, splitLines } from "./tools/file_state.ts";
import { MAX_LINES, numberLines } from "./tools/read.ts";

// @ 前面必须是开头或空白（避免误伤邮箱 a@b.com）；路径可以用引号包住带空格的名字
// 中文标点也视为路径结束（「看看 @a.py，然后」）
const MENTION = /(?:^|(?<=\s))@("[^"]+"|[^\s"，。；：！？（）、]+)/gu;
const TRAILING = ",.;:!?)，。；：！？）";
export const IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".mypy_cache",
  ".pytest_cache", ".next", ".turbo", "coverage"]);

function rstripChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

export function findMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    let raw = m[1];
    raw = raw.startsWith('"') ? raw.slice(1, -1) : rstripChars(raw, TRAILING);
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** 第 19 章：图片作为 image 块附加（前面放一句说明）；不合规就只附加原因。 */
export function imageAttachment(path: string, ref: string): Attachment {
  let block, meta;
  try {
    [block, meta] = loadImage(path);
  } catch (e) {
    if (!(e instanceof ImageError)) throw e;
    return new Attachment("image", `@${ref}（图片无法附加）`, `The user attached @${ref}, but it was not sent: ${e.message}`);
  }
  return new Attachment("image", `@${ref}（图片 ${meta.short} ${meta.width}×${meta.height}，≈${meta.tokens} visual tokens）`,
    `The user attached the image @${ref} (${meta.note()}). It follows this note.`, [block]);
}

export function fileAttachment(path: string, ref: string, ctx: ToolContext, maxLines: number): Attachment {
  if (isImagePath(path)) return imageAttachment(path, ref);
  const raw = readFileSync(path);
  if (raw.subarray(0, 8000).includes(0)) {
    return new Attachment("file", `@${ref}（二进制，已跳过）`, `The user mentioned @${ref}, a binary file (not shown).`);
  }
  const text = readText(path);
  const lines = splitLines(text);
  const shown = lines.slice(0, maxLines);
  // 内容进了上下文 = 模型「读过」了：登记文件状态，模型可以直接 Edit，不用再 Read 一遍
  ctx.fileState.remember(path, text, shown.length < lines.length);
  const more = shown.length < lines.length
    ? `\n\n[showing first ${shown.length} of ${lines.length} lines; use Read with offset to see more]` : "";
  const body = shown.length ? numberLines(shown, 1) : "(file is empty)";
  return new Attachment("file", `@${ref}（${lines.length} 行）`,
    `The user mentioned @${ref}. Contents of ${ctx.rel(path)} (same format as the Read tool):\n${body}${more}`);
}

function dirAttachment(path: string, ref: string, limit = 200): Attachment {
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((e) => !IGNORED_DIRS.has(e.name))
    .map((e) => e.name + (isDir(join(path, e.name)) ? "/" : ""))
    .sort();
  const listing = entries.slice(0, limit).join("\n") + (entries.length > limit ? `\n… (${entries.length - limit} more)` : "");
  return new Attachment("directory", `@${ref}（目录，${entries.length} 项）`,
    `The user mentioned the directory @${ref}. Its entries:\n${listing}`);
}

export function resolveMentions(text: string, ctx: ToolContext, maxLines = MAX_LINES): Attachment[] {
  const atts: Attachment[] = [];
  for (const ref of findMentions(text)) {
    const path = ctx.resolve(ref);
    if (isFile(path)) atts.push(fileAttachment(path, ref, ctx, maxLines));
    else if (isDir(path)) atts.push(dirAttachment(path, ref));
    // 都不是：不是路径（比如 @someone），原样留在文本里
  }
  // 第 19 章：拖进终端的图片路径（不带 @）也附加
  const seen = new Set(findMentions(text).map((r) => ctx.resolve(r)));
  for (const p of findImagePaths(text, ctx.cwd)) {
    const real = realResolve(p);
    if (!seen.has(real)) {
      seen.add(real);
      atts.push(imageAttachment(p, basename(p)));
    }
  }
  return atts;
}

/** 附件在前、用户原话在后：长资料放前面、问题放最后，是 Anthropic 长上下文提示的建议顺序。 */
export function buildUserContent(text: string, attachments: Attachment[]): string | Block[] {
  if (!attachments.length) return text;
  // 图片紧跟它的说明；全部在原话之前（官方建议：图片在前、问题在后）
  return [...attachments.flatMap((a) => [render(a), ...a.blocks]), { type: "text", text }];
}

// ---------------------------------------------------------------- 输入补全

/** 优先 git ls-files（尊重 .gitignore，快）；不是 git 仓库就自己走目录树。 */
export function listProjectFiles(cwd: string, limit = 20000): string[] {
  const out = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd, encoding: "utf8", timeout: 5000 });
  if (!out.error && out.status === 0) {
    const files = splitLines(out.stdout).filter(Boolean);
    const dirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => posix.dirname(f) + "/"))].sort();
    return [...files, ...dirs].slice(0, limit);
  }
  // 和 os.walk 一样深度优先：先列出这一层的文件，再按字母序进子目录
  const found: string[] = [];
  const walk = (rel: string): void => {
    if (found.length >= limit) return;
    const abs = rel ? join(cwd, rel) : cwd;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel) found.push(`${rel}/`);
    const dirs = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith(".")).map((e) => e.name).sort();
    const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
    found.push(...files.map((f) => (rel ? `${rel}/${f}` : f)));
    for (const d of dirs) walk(rel ? `${rel}/${d}` : d);
  };
  walk("");
  return found.slice(0, limit);
}

/** 子序列匹配：query 的字符按顺序出现在 candidate 里就算命中。分数越小越好；不命中返回 null。 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase(), c = candidate.toLowerCase();
  if (!q) return c.length;
  let pos = 0, gaps = 0, last = -1;
  for (const ch of q) {
    const i = c.indexOf(ch, pos);
    if (i < 0) return null;
    gaps += i - last - 1;
    last = i;
    pos = i + 1;
  }
  const name = c.slice(c.lastIndexOf("/") + 1);
  const bonus = name.includes(q) ? -50 : c.includes(q) ? -20 : 0; // 文件名直接包含 query 的排前面
  return gaps + Math.floor(c.length / 10) + bonus;
}

export function rank(query: string, files: Iterable<string>, limit = 20): string[] {
  const scored: Array<[number, string]> = [];
  for (const f of files) {
    const s = fuzzyScore(query, f);
    if (s !== null) scored.push([s, f]);
  }
  // 和 Python 排序 (score, path) 元组一样：分数相同按路径字典序
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return scored.slice(0, limit).map(([, f]) => f);
}

export interface Completion {
  text: string; // 替换光标前那个词的内容
  display: string; // 列表里显示的内容
}

/**
 * 光标前的那个词以 @ 开头时，列出模糊匹配的项目文件。文件列表缓存 5 秒。
 * Python 版是 prompt_toolkit 的 Completer；这里只返回候选，由 cli.ts 接到 node:readline 的 completer 上。
 */
export class FileMentionCompleter {
  cwd: string;
  ttl: number;
  private cache: [number, string[]] = [-Infinity, []];

  constructor(cwd: string, ttl = 5.0) {
    this.cwd = cwd;
    this.ttl = ttl;
  }

  files(): string[] {
    let [ts, files] = this.cache;
    if (performance.now() / 1000 - ts > this.ttl) {
      files = listProjectFiles(this.cwd);
      this.cache = [performance.now() / 1000, files];
    }
    return files;
  }

  getCompletions(textBeforeCursor: string): Completion[] {
    const word = textBeforeCursor.split(" ").at(-1)!;
    if (!word.startsWith("@")) return [];
    return rank(word.slice(1), this.files()).map((f) => ({ text: `@${f.includes(" ") ? `"${f}"` : f}`, display: f }));
  }
}
