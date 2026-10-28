/**
 * 任务清单：把「计划」从对话历史里拿出来，变成一份独立、持久、看得见的状态。（第 11 章）
 *
 * - 存储：每个会话一个 JSON 文件（<session>.tasks.json），和对话历史分开——压缩历史不会丢计划。
 * - 工具：TaskCreate / TaskUpdate / TaskList（tools/task_tools.ts），模型自己维护清单。
 * - 提醒：模型很久没碰清单、而清单还没做完时，注入一条提醒（context 的 provider 机制）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Attachment, isReminder } from "./attachments.ts";
import type { InjectState, Provider } from "./context.ts";

export const STATUSES = ["pending", "in_progress", "completed"] as const;
export type Status = (typeof STATUSES)[number];
export const MARK: Record<Status, string> = { pending: "☐", in_progress: "◼", completed: "☒" };

// 落盘的字段名和 Python 版一样是 snake_case（active_form），两个版本可以读同一份文件
export interface Task {
  id: string;
  subject: string;
  description: string;
  active_form: string; // 进行时的说法，UI 显示「正在…」
  status: Status;
}

export type TaskChanges = Partial<Pick<Task, "subject" | "description" | "active_form" | "status">>;

export class TaskStore {
  path: string | null;
  tasks: Task[] = [];

  constructor(path: string | null = null) {
    this.path = path;
  }

  static load(path: string | null): TaskStore {
    const store = new TaskStore(path);
    if (path && existsSync(path)) store.tasks = JSON.parse(readFileSync(path, "utf8"));
    return store;
  }

  save(): void {
    if (this.path === null) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path.replace(/\.json$/, ".tmp");
    writeFileSync(tmp, JSON.stringify(this.tasks, null, 1), "utf8");
    renameSync(tmp, this.path); // 先写临时文件再改名：崩溃时不会留下半个 JSON
  }

  create(subject: string, description = "", activeForm = ""): Task {
    const t: Task = { id: String(this.tasks.length + 1), subject, description, active_form: activeForm, status: "pending" };
    this.tasks.push(t);
    this.save();
    return t;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.find((t) => t.id === String(taskId));
  }

  /** 找不到就返回 undefined（Python 版抛 KeyError）。值为 undefined 的字段不改。 */
  update(taskId: string, changes: TaskChanges): Task | undefined {
    const t = this.get(taskId);
    if (t === undefined) return undefined;
    for (const [k, v] of Object.entries(changes)) {
      if (v !== undefined) (t as any)[k] = v;
    }
    this.save();
    return t;
  }

  unfinished(): Task[] {
    return this.tasks.filter((t) => t.status !== "completed");
  }

  render(): string {
    if (!this.tasks.length) return "(no tasks)";
    const lines = this.tasks.map((t) => {
      const extra = t.status === "in_progress" && t.active_form ? `  ← ${t.active_form}` : "";
      return `${MARK[t.status]} #${t.id} ${t.subject}${extra}`;
    });
    const done = this.tasks.filter((t) => t.status === "completed").length;
    return lines.join("\n") + `\n(${done}/${this.tasks.length} completed)`;
  }
}

export const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);
export const REMINDER_HEADER = "# Task list reminder";

/**
 * 清单没做完，而模型已经 `every` 次请求没碰过清单（或者历史里根本看不到清单，比如压缩之后）→ 提醒。
 *
 * 和其他 provider 一样不记标志位：从历史里数「最近一次碰清单/最近一次提醒」之后过了几条 assistant 消息。
 */
export function taskReminderProvider(every = 6): Provider {
  return (st: InjectState) => {
    const store: TaskStore | undefined = st.agent.ctx.extras.tasks;
    if (store === undefined || !store.unfinished().length) return null;
    let gap = 0, seen = false;
    for (const m of [...st.messages].reverse()) {
      const content = Array.isArray(m.content) ? m.content : [];
      if (m.role === "assistant") {
        if (content.some((b) => b.type === "tool_use" && TASK_TOOLS.has(b.name))) {
          seen = true;
          break;
        }
        gap++;
      } else if (content.some((b) => isReminder(b) && b.text.includes(REMINDER_HEADER))) {
        seen = true;
        break;
      }
    }
    if (seen && gap < every) return null;
    const why = seen
      ? `You have not updated the task list in the last ${gap} steps.`
      : "This is the current task list for this session (it may not be visible earlier in the conversation).";
    return new Attachment("tasks", `任务提醒（${store.unfinished().length} 项未完成）`,
      `${REMINDER_HEADER}\n${why} Keep it accurate: mark the task you are working on in_progress ` +
      "and mark finished tasks completed right away. Do not stop while tasks remain unless you " +
      `are blocked.\n\n${store.render()}`);
  };
}
