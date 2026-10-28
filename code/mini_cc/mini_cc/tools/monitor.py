"""Monitor 工具（第 18 章）：启动一个长期运行的命令，它的每一行 stdout 都作为事件推给模型。"""

from __future__ import annotations

from .base import Tool, ToolContext, ToolResult
from .bash import BashTool

MAX_TIMEOUT_MS = 1_800_000   # 30 分钟（和 Claude Code 的 Monitor 一样封顶）
DEFAULT_TIMEOUT_MS = 300_000


class MonitorTool(Tool):
    name = "Monitor"
    kind = "exec"
    description = (
        "Start a background monitor: run a long-lived command whose stdout lines are events. Each line (lines "
        "within 200ms are batched) arrives as a notification while you keep working.\n"
        "Use it for 'tell me EVERY time X happens' (tail -F log | grep --line-buffered ERROR, a poll loop that "
        "prints one line per change). For 'tell me when X is done' (one notification), use Bash with "
        "run_in_background instead.\n"
        "Rules: every pipe stage must flush per line (grep --line-buffered); filter to the lines you would act "
        "on, including failure signatures, not only good news; stderr is not an event. Monitors expire after "
        "timeout_ms (default 5 min, max 30 min) and are stopped automatically if they flood. Stop early with "
        "TaskStop. Events are not replies from the user."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Shell command; each stdout line is an event"},
            "description": {"type": "string", "description": "Specific, shown in every notification"},
            "timeout_ms": {"type": "integer", "description": "Default 300000, capped at 1800000"},
        },
        "required": ["command", "description"],
        "additionalProperties": False,
    }

    # 权限和 Bash 一样按命令判断：tail | grep 这种只读命令免审批，其余要问
    self_check = BashTool.self_check

    def rule_key(self, args) -> str:
        return f"Monitor({args.get('command', '')})"

    def summary(self, args) -> str:
        return f"Monitor({args.get('description') or args.get('command', '')})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        jobs = ctx.extras.get("jobs")
        if jobs is None:
            return ToolResult("Monitors are not available here.", True)
        ms = min(int(args.get("timeout_ms") or DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
        job = jobs.start_monitor(args["command"], ctx.cwd, args["description"], ms / 1000, ctx.tool_use_id)
        return ToolResult(
            f"Monitor started (task {job.id}, expires in {ms / 60000:g}m unless the source ends first; "
            "you get one notice at expiry, re-arm if you still need the watch). You will be notified on each event. "
            "Keep working, do not poll or sleep. Events may arrive while you are waiting for the user: "
            "an event is not their reply.")
