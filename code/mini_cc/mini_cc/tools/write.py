from __future__ import annotations

from .base import Tool, ToolContext, ToolResult
from .file_state import guard_write, write_text


class WriteTool(Tool):
    name = "Write"
    kind = "edit"
    path_arg = "file_path"
    description = (
        "Create a new file or completely overwrite an existing one. "
        "If the file exists you must Read it first. Prefer Edit for changing part of a file."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "file_path": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["file_path", "content"],
        "additionalProperties": False,
    }

    def run(self, args, ctx: ToolContext) -> ToolResult:
        path = ctx.resolve(args["file_path"])
        err = guard_write(ctx.file_state, path)
        if err:
            return ToolResult(f"<tool_use_error>{err}</tool_use_error>", True)
        ctx.before_write(path)
        existed = path.exists()
        write_text(path, args["content"])
        ctx.file_state.remember(path, args["content"])  # 自己写的内容 = 已知最新状态，接着 Edit 不用重读
        verb = "Overwrote" if existed else "Created"
        return ToolResult(f"{verb} {ctx.rel(path)} ({len(args['content'].splitlines())} lines)")
