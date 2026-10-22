/**
 * 文件状态缓存：记住模型「读过哪些文件、读的时候文件长什么样」。（第 7 章）
 *
 * Write / Edit 靠它实现两条规矩：
 * 1. 先读后改：没读过的已存在文件不许改（防止模型凭记忆/幻觉盲改）。
 * 2. 读后未变：读过之后文件被别人（你、formatter、另一个进程）改了，必须重读（防止覆盖别人的修改）。
 * 第 9 章的「文件被外部修改」提醒也读这张表。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 和 Python 的 str.splitlines() 一样：认 \n、\r\n、\r 等行边界，末尾换行不产生空行。 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (/(\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])$/.test(text)) lines.pop();
  return lines;
}

export interface FileRecord {
  mtimeNs: bigint;
  sha: string;
  partial: boolean; // 只读了一部分（offset/limit）
  text: string | null; // 第 9 章：保存模型看到的版本，外部修改时据此算 diff（大文件不存）
}

export class FileStateCache {
  static MAX_KEEP = 200_000; // 超过这么多字符的文件不存原文，外部修改时只提示不给 diff
  private records = new Map<string, FileRecord>(); // key 是 ToolContext.resolve() 之后的绝对路径

  remember(path: string, text: string, partial = false): void {
    const keep = text.length <= FileStateCache.MAX_KEEP ? text : null;
    this.records.delete(path); // 重新插入 = 移到末尾：paths() 按「最近看到」排序
    this.records.set(path, { mtimeNs: statSync(path, { bigint: true }).mtimeNs, sha: digest(text), partial, text: keep });
  }

  get(path: string): FileRecord | undefined {
    return this.records.get(path);
  }

  forget(path: string): void {
    this.records.delete(path);
  }

  clear(): void {
    this.records.clear();
  }

  paths(): string[] {
    return [...this.records.keys()];
  }

  /** mtime 变了且内容也变了才算「被改过」（只是 touch 一下不算）。 */
  isStale(path: string): boolean {
    const rec = this.records.get(path);
    if (rec === undefined || !existsSync(path)) return rec !== undefined;
    if (statSync(path, { bigint: true }).mtimeNs === rec.mtimeNs) return false;
    return digest(readText(path)) !== rec.sha;
  }
}

export function readText(path: string): string {
  // Node 读文件不做换行转换，\r\n 原样保留（Python 版要显式 newline=""）
  return readFileSync(path, "utf8");
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export const NOT_READ = "File has not been read yet. Read it first before writing to it.";
export const STALE =
  "File has been modified since read, either by the user or by a linter. " +
  "Read it again before attempting to write it.";

/** 已存在文件的写入前检查。返回错误信息，null 表示可以写。 */
export function guardWrite(state: FileStateCache, path: string): string | null {
  if (!existsSync(path)) return null;
  if (state.get(path) === undefined) return NOT_READ;
  if (state.isStale(path)) return STALE;
  return null;
}
