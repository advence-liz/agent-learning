/**
 * TaskCreate / TaskUpdate / TaskList：模型维护自己的任务清单。（第 11 章）
 */

import { tasksUpdated } from "../events.ts";
import { STATUSES, TaskStore } from "../tasks.ts";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";

const GUIDE = `Use the task list to plan and track multi-step work (3+ distinct steps, or when the user gives several
things to do). Create all tasks up front, then: mark a task in_progress BEFORE starting it, and completed
IMMEDIATELY after finishing it. Keep exactly one task in_progress at a time. Do not mark a task completed
if tests fail or the work is partial. Skip the task list for trivial single-step requests.`;

function store(ctx: ToolContext): TaskStore {
  ctx.extras.tasks ??= new TaskStore();
  return ctx.extras.tasks;
}

class TaskTool extends Tool {
  override readOnly = true; // 只改 agent 自己的清单，不碰项目文件：免审批
  override kind = "tasks";

  after(ctx: ToolContext): void {
    ctx.emit(tasksUpdated(store(ctx).render()));
  }
}

export class TaskCreateTool extends TaskTool {
  override name = "TaskCreate";
  override description = "Create a task in the session task list.\n\n" + GUIDE;
  override inputSchema = {
    type: "object",
    properties: {
      subject: { type: "string", description: "Imperative title, e.g. 'Add pagination to GET /posts'" },
      description: { type: "string", description: "What done looks like" },
      activeForm: { type: "string", description: "Present continuous, e.g. 'Adding pagination'" },
    },
    required: ["subject"],
    additionalProperties: false,
  };

  override summary(args: Args): string {
    return `TaskCreate(${args.subject ?? ""})`;
  }

  override run(args: Args, ctx: ToolContext): ToolResult {
    const t = store(ctx).create(args.subject, args.description ?? "", args.activeForm ?? "");
    this.after(ctx);
    return new ToolResult(`Task #${t.id} created: ${t.subject}`);
  }
}

export class TaskUpdateTool extends TaskTool {
  override name = "TaskUpdate";
  override description = "Update a task's status (pending / in_progress / completed) or its text.";
  override inputSchema = {
    type: "object",
    properties: {
      taskId: { type: "string" },
      status: { type: "string", enum: [...STATUSES] },
      subject: { type: "string" },
      description: { type: "string" },
      activeForm: { type: "string" },
    },
    required: ["taskId"],
    additionalProperties: false,
  };

  override summary(args: Args): string {
    return `TaskUpdate(#${args.taskId} → ${args.status ?? "edit"})`;
  }

  override run(args: Args, ctx: ToolContext): ToolResult {
    const s = store(ctx);
    const t = s.update(args.taskId, {
      status: args.status, subject: args.subject, description: args.description, active_form: args.activeForm,
    });
    if (t === undefined) return new ToolResult(`Task #${args.taskId} not found. Use TaskList to see task ids.`, true);
    const notes = [`Updated task #${t.id} (${t.subject}): status=${t.status}`];
    const others = s.tasks.filter((o) => o.status === "in_progress" && o.id !== t.id);
    if (t.status === "in_progress" && others.length) {
      notes.push(`Note: #${others.map((o) => o.id).join(", #")} also in_progress; keep only one in progress.`);
    }
    const left = s.unfinished();
    notes.push(!left.length ? "All tasks completed." : `${left.length} task(s) remaining.`);
    this.after(ctx);
    return new ToolResult(notes.join("\n"));
  }
}

export class TaskListTool extends TaskTool {
  override name = "TaskList";
  override description = "Show the current task list with ids and statuses.";
  override inputSchema = { type: "object", properties: {}, additionalProperties: false };

  override summary(_args: Args): string {
    return "TaskList()";
  }

  override run(_args: Args, ctx: ToolContext): ToolResult {
    return new ToolResult(store(ctx).render());
  }
}
