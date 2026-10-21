"""TaskStop：停掉一个后台任务（第 16 章：bash；第 17 章：sub agent；第 18 章：monitor）。"""

from __future__ import annotations

from .base import Tool, ToolContext, ToolResult


class TaskStopTool(Tool):
    name = "TaskStop"
    kind = "tasks"
    description = "Stop a running background task (background command, sub agent or monitor) by its task id."
    input_schema = {
        "type": "object",
        "properties": {"task_id": {"type": "string", "description": "e.g. b1"}},
        "required": ["task_id"],
        "additionalProperties": False,
    }

    def self_check(self, args) -> str | None:
        return "allow"  # 只停 agent 自己启动的任务

    def summary(self, args) -> str:
        return f"TaskStop({args.get('task_id')})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        jobs = ctx.extras.get("jobs")
        job = jobs.get(args["task_id"]) if jobs else None
        if job is None:
            return ToolResult(f"No task {args['task_id']}. Running: "
                              f"{', '.join(j.id for j in jobs.running()) if jobs else 'none'}", True)
        if job.status != "running":
            return ToolResult(f"Task {job.id} is not running (status: {job.status}).", True)
        jobs.stop(job.id)
        return ToolResult(f"Stopped task {job.id} ({job.description}).")
