/**
 * Agent 循环对外产出的事件。UI、持久化、测试都只消费事件，不碰循环内部。（第 2、5、9、11 章）
 *
 * Python 版每种事件是一个 dataclass，用 isinstance 区分；这里是带 type 标签的普通对象（判别联合），
 * 用 ev.type === "ToolStart" 区分。type 的取值就是 Python 版的类名。
 */

import type { TextDelta, ThinkingDelta } from "./model.ts";
import type { ToolResult } from "./tools/base.ts";

export type { TextDelta, ThinkingDelta };

export interface ToolStart {
  type: "ToolStart";
  id: string;
  name: string;
  input: Record<string, any>;
  summary: string;
}

export interface ToolEnd {
  type: "ToolEnd";
  id: string;
  name: string;
  result: ToolResult;
}

/** 循环里发生的、值得告诉用户的事（重试、错误、注入了提醒……）。 */
export interface Notice {
  type: "Notice";
  text: string;
  level: "info" | "warn" | "error";
}

/** 一次权限判定的结论。只有「值得一提」的才 yield：被拒绝、用户批准、审查员自动放行。 */
export interface PermissionDecision {
  type: "PermissionDecision";
  toolId: string;
  summary: string;
  behavior: "allow" | "deny";
  reason: string;
  source: string;
}

/** 客户端往上下文里注入了一个附件（第 9 章）。UI 显示成「◇ system …」。 */
export interface ContextInjected {
  type: "ContextInjected";
  kind: string;
  title: string;
}

export interface TurnEnd {
  type: "TurnEnd";
  stopReason: string;
  text: string;
  extra: Record<string, any>;
}

/** 任务清单变了（第 11 章）。rendered 是清单的文本形式。 */
export interface TasksUpdated {
  type: "TasksUpdated";
  rendered: string;
}

export type Event =
  | TextDelta | ThinkingDelta | ToolStart | ToolEnd | Notice | PermissionDecision | ContextInjected | TasksUpdated | TurnEnd;

// 构造函数：和 Python 版 Notice("…", "warn") / TurnEnd("error", "") 的写法对应
export const notice = (text: string, level: Notice["level"] = "info"): Notice => ({ type: "Notice", text, level });
export const turnEnd = (stopReason: string, text = "", extra: Record<string, any> = {}): TurnEnd =>
  ({ type: "TurnEnd", stopReason, text, extra });
export const tasksUpdated = (rendered: string): TasksUpdated => ({ type: "TasksUpdated", rendered });
