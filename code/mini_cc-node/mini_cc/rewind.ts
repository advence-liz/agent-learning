/**
 * /rewind（第 13 章）：每条用户提示词一个检查点，Write/Edit 写文件前先备份「这一轮开始前」的版本。
 *
 * 布局（模仿 Claude Code 的 ~/.claude/file-history/<session>/<hash>@v<n>）：
 *     <home>/file-history/<session_id>/index.json      检查点列表
 *     <home>/file-history/<session_id>/<hash>@v<n>     某个文件的一份备份
 *
 * 只跟踪经过 ToolContext.beforeWrite 的写入（Write / Edit）。Bash 改的文件、你在编辑器里改的文件都不在里面。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isReminder } from "./attachments.ts";
import type { Message } from "./model.ts";

export interface Checkpoint {
  uuid: string; // 这条用户消息在会话文件里的 uuid
  prompt: string; // 用户原话（列表里给人看，回退后放回输入框）
  // 路径 → 备份文件名；null 表示这一轮第一次写它之前，文件还不存在（回退 = 删除）
  files: Record<string, string | null>;
}

export type Change = [path: string, action: "restored" | "deleted"];

export class FileHistory {
  dir: string;
  checkpoints: Checkpoint[] = [];

  constructor(dir: string) {
    this.dir = dir;
  }

  static load(dir: string): FileHistory {
    const h = new FileHistory(dir);
    const index = join(dir, "index.json");
    if (existsSync(index)) h.checkpoints = JSON.parse(readFileSync(index, "utf8"));
    return h;
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, "index.tmp");
    writeFileSync(tmp, JSON.stringify(this.checkpoints, null, 1), "utf8");
    renameSync(tmp, join(this.dir, "index.json"));
  }

  // ------------------------------------------------------------ 记录

  begin(uuid: string, prompt: string): void {
    this.checkpoints.push({ uuid, prompt, files: {} });
    this.save();
  }

  /** ToolContext.writeHooks 回调。每个检查点里每个文件只备份一次：要的是「这一轮开始前」的版本。 */
  beforeWrite(path: string): void {
    if (!this.checkpoints.length) return;
    const cp = this.checkpoints.at(-1)!;
    if (path in cp.files) return;
    if (existsSync(path)) {
      const version = 1 + this.checkpoints.slice(0, -1).filter((c) => path in c.files).length;
      const name = `${createHash("sha256").update(path).digest("hex").slice(0, 16)}@v${version}`;
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, name), readFileSync(path));
      cp.files[path] = name;
    } else {
      cp.files[path] = null;
    }
    this.save();
  }

  // ------------------------------------------------------------ 回退

  indexOf(uuid: string): number {
    const i = this.checkpoints.findIndex((c) => c.uuid === uuid);
    if (i < 0) throw new Error(`no checkpoint ${uuid}`);
    return i;
  }

  changedSince(uuid: string): string[] {
    const seen = new Set<string>();
    for (const c of this.checkpoints.slice(this.indexOf(uuid))) for (const k of Object.keys(c.files)) seen.add(k);
    return [...seen];
  }

  /**
   * 把这个检查点之后改过的文件恢复到检查点开始时的样子。
   *
   * 对每个文件，取「检查点之后第一次写它之前」的那份备份：从检查点开始到那次写入之间没有被跟踪的写入，
   * 所以它就是检查点开始时的内容（Bash / 外部修改除外）。
   */
  restore(uuid: string): Change[] {
    const changes: Change[] = [];
    const after = this.checkpoints.slice(this.indexOf(uuid));
    for (const key of this.changedSince(uuid)) {
      const backup = after.find((c) => key in c.files)!.files[key];
      if (backup === null) {
        if (existsSync(key)) {
          rmSync(key);
          changes.push([key, "deleted"]);
        }
      } else {
        const data = readFileSync(join(this.dir, backup));
        if (!existsSync(key) || !readFileSync(key).equals(data)) {
          mkdirSync(dirname(key), { recursive: true });
          writeFileSync(key, data);
          changes.push([key, "restored"]);
        }
      }
    }
    return changes;
  }

  /** 对话回退到这个检查点之前：它和它之后的检查点都属于被丢弃的分支。备份文件留在磁盘上，不删。 */
  truncate(uuid: string): void {
    this.checkpoints = this.checkpoints.slice(0, this.indexOf(uuid));
    this.save();
  }
}

// ---------------------------------------------------------------- 哪些 user 消息算「提示词」

/** 用户亲手发的消息才是检查点：工具结果、纯提醒（后台通知唤醒）不算。 */
export function isPrompt(msg: Message): boolean {
  if (msg.role !== "user") return false;
  const c = msg.content;
  if (typeof c === "string") return true;
  if (c.some((b) => b.type === "tool_result")) return false;
  return c.some((b) => b.type === "text" && !isReminder(b));
}

export function promptText(msg: Message): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  const texts = c.filter((b) => b.type === "text" && !isReminder(b)).map((b) => b.text as string);
  return texts.at(-1) ?? "";
}
