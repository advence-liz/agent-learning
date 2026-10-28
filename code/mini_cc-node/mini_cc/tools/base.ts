/**
 * 工具的公共骨架：一个工具 = 名字 + 描述 + JSON Schema + run()。（第 1、5、7、11 章）
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Event } from "../events.ts";
import { FileStateCache } from "./file_state.ts";

export type Args = Record<string, any>;

export class ToolResult {
  // 字符串或 content block 列表（第 19 章的图片会用到列表形式）
  content: string | Array<Record<string, any>>;
  isError: boolean;

  constructor(content: string | Array<Record<string, any>>, isError = false) {
    this.content = content;
    this.isError = isError;
  }
}

/** 相当于 Python 的 Path(p).resolve()：解析 ..、符号链接（macOS 的 /var → /private/var）；路径不存在也能用。 */
export function realResolve(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** Python 的 Path.is_relative_to：child 在 parent 里面（或就是它）。 */
export function isRelativeTo(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

export function expandUser(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** 工具运行时能拿到的「外部世界」。新能力往这里加字段，而不是让工具 import 全局变量。 */
export class ToolContext {
  cwd: string;
  extras: Record<string, any> = {};
  // 第 7 章：读过哪些文件、读时的版本
  fileState = new FileStateCache();
  // 写文件前的钩子（第 13 章 /rewind 在这里给文件拍快照）
  writeHooks: Array<(path: string) => void> = [];
  // Node 版多出的一项：当前这一轮的取消信号（Ctrl+C）。Bash 收到后杀掉子进程组
  signal: AbortSignal | undefined = undefined;
  // 第 11 章：工具想告诉 UI 的事件（比如任务清单变了）先放这里，循环在 ToolEnd 之后统一转发
  pendingEvents: Event[] = [];
  // 第 16 章：当前正在执行的 tool_use id（后台任务的通知里要带上它）；这些目录下的文件变化不提醒模型
  toolUseId = "";
  // 第 20 章：工具想在 tool_result 之后追加的普通文本块（skill 正文），循环在这一批结果之后统一放进去
  followupBlocks: Array<Record<string, any>> = [];
  untrackedDirs: string[] = [];

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  emit(event: Event): void {
    this.pendingEvents.push(event);
  }

  beforeWrite(path: string): void {
    for (const fn of this.writeHooks) fn(path);
  }

  /** 给人和模型看的路径：项目内用相对路径，项目外用绝对路径。 */
  rel(path: string): string {
    const root = realResolve(this.cwd);
    if (!isRelativeTo(path, root)) return path;
    return relative(root, path) || ".";
  }

  resolve(path: string): string {
    const p = expandUser(path);
    return realResolve(isAbsolute(p) ? p : join(this.cwd, p));
  }
}

export class Tool {
  name = "";
  description = "";
  inputSchema: Record<string, any> = { type: "object", properties: {} };
  // 第 5 章：权限相关的元信息
  readOnly = false; // 只读工具默认放行
  kind = "other"; // read | edit | exec | other；acceptEdits 模式放行 edit
  pathArg: string | null = null; // edit 类工具的路径参数名，用来判断是否在项目目录内

  /** 工具对这次调用的自我评估：'allow'（确定安全）/ 'ask'（高危，任何非 bypass 模式都要问）/ null（交给模式决定）。 */
  selfCheck(_args: Args): "allow" | "ask" | null {
    return null;
  }

  /** 「本会话不再询问」记住的规则。默认整个工具；Bash 按具体命令。 */
  ruleKey(_args: Args): string {
    return this.name;
  }

  run(_args: Args, _ctx: ToolContext): ToolResult | Promise<ToolResult> {
    throw new Error("not implemented");
  }

  schema(): Record<string, any> {
    return { name: this.name, description: this.description, input_schema: this.inputSchema };
  }

  /** 给人看的一行摘要，例如 Bash(npm test)。 */
  summary(args: Args): string {
    const first = args ? Object.values(args)[0] ?? "" : "";
    const s = typeof first === "string" ? first : JSON.stringify(first);
    return `${this.name}(${s.slice(0, 60)})`;
  }
}
