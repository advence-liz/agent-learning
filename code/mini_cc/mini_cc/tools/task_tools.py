"""TaskCreate / TaskUpdate / TaskList：模型维护自己的任务清单。"""

from __future__ import annotations

from ..tasks import STATUSES, TaskStore
from .base import Tool, ToolContext, ToolResult

GUIDE = """Use the task list to plan and track multi-step work (3+ distinct steps, or when the user gives several
things to do). Create all tasks up front, then: mark a task in_progress BEFORE starting it, and completed
IMMEDIATELY after finishing it. Keep exactly one task in_progress at a time. Do not mark a task completed
if tests fail or the work is partial. Skip the task list for trivial single-step requests."""


def _store(ctx: ToolContext) -> TaskStore:
    store = ctx.extras.get("tasks")
    if store is None:
        store = ctx.extras["tasks"] = TaskStore()
    return store


class _TaskTool(Tool):
    read_only = True  # 只改 agent 自己的清单，不碰项目文件：免审批
    kind = "tasks"

    def after(self, ctx: ToolContext) -> None:
        from ..events import TasksUpdated

        ctx.emit(TasksUpdated(_store(ctx).render()))


class TaskCreateTool(_TaskTool):
    name = "TaskCreate"
    description = "Create a task in the session task list.\n\n" + GUIDE
    input_schema = {
        "type": "object",
        "properties": {
            "subject": {"type": "string", "description": "Imperative title, e.g. 'Add pagination to GET /posts'"},
            "description": {"type": "string", "description": "What done looks like"},
            "activeForm": {"type": "string", "description": "Present continuous, e.g. 'Adding pagination'"},
        },
        "required": ["subject"],
        "additionalProperties": False,
    }

    def summary(self, args) -> str:
        return f"TaskCreate({args.get('subject', '')})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        t = _store(ctx).create(args["subject"], args.get("description", ""), args.get("activeForm", ""))
        self.after(ctx)
        return ToolResult(f"Task #{t.id} created: {t.subject}")


class TaskUpdateTool(_TaskTool):
    name = "TaskUpdate"
    description = "Update a task's status (pending / in_progress / completed) or its text."
    input_schema = {
        "type": "object",
        "properties": {
            "taskId": {"type": "string"},
            "status": {"type": "string", "enum": list(STATUSES)},
            "subject": {"type": "string"},
            "description": {"type": "string"},
            "activeForm": {"type": "string"},
        },
        "required": ["taskId"],
        "additionalProperties": False,
    }

    def summary(self, args) -> str:
        return f"TaskUpdate(#{args.get('taskId')} → {args.get('status', 'edit')})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        store = _store(ctx)
        try:
            t = store.update(args["taskId"], status=args.get("status"), subject=args.get("subject"),
                             description=args.get("description"), active_form=args.get("activeForm"))
        except KeyError:
            return ToolResult(f"Task #{args['taskId']} not found. Use TaskList to see task ids.", True)
        notes = [f"Updated task #{t.id} ({t.subject}): status={t.status}"]
        others = [o for o in store.tasks if o.status == "in_progress" and o.id != t.id]
        if t.status == "in_progress" and others:
            notes.append(f"Note: #{', #'.join(o.id for o in others)} also in_progress; keep only one in progress.")
        left = store.unfinished()
        notes.append("All tasks completed." if not left else f"{len(left)} task(s) remaining.")
        self.after(ctx)
        return ToolResult("\n".join(notes))


class TaskListTool(_TaskTool):
    name = "TaskList"
    description = "Show the current task list with ids and statuses."
    input_schema = {"type": "object", "properties": {}, "additionalProperties": False}

    def summary(self, args) -> str:
        return "TaskList()"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        return ToolResult(_store(ctx).render())
