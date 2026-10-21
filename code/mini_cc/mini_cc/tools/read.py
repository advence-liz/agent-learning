from __future__ import annotations

from .base import Tool, ToolContext, ToolResult
from .file_state import read_text

MAX_LINES = 2000
MAX_LINE_CHARS = 2000


def number_lines(lines: list[str], start: int) -> str:
    """cat -n 风格：右对齐 6 位行号 + 制表符。模型据此定位，但编辑时绝不能把行号抄进 old_string。"""
    return "\n".join(f"{i:>6}\t{ln}" for i, ln in enumerate(lines, start))


class ReadTool(Tool):
    name = "Read"
    read_only = True
    kind = "read"
    description = (
        "Read a text file. Output is numbered like `cat -n` (line number, a tab, then the line). "
        f"Reads up to {MAX_LINES} lines; use offset/limit for large files. "
        "You must Read a file before you Edit or overwrite it."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "file_path": {"type": "string", "description": "Absolute or project-relative path"},
            "offset": {"type": "integer", "description": "1-based line to start from"},
            "limit": {"type": "integer", "description": "Number of lines to read"},
        },
        "required": ["file_path"],
        "additionalProperties": False,
    }

    def run(self, args, ctx: ToolContext) -> ToolResult:
        path = ctx.resolve(args["file_path"])
        if path.is_dir():
            return ToolResult(f"{ctx.rel(path)} is a directory. Use Bash `ls` to list it.", True)
        from ..images import ImageError, is_image_path, load_image, sniff

        raw = path.read_bytes()
        if is_image_path(path) or sniff(raw[:16]):
            # 第 19 章：图片作为 image 块放进 tool_result（content 是块列表）
            try:
                block, meta = load_image(path)
            except ImageError as e:
                return ToolResult(str(e), True)
            return ToolResult([{"type": "text", "text": f"Image: {ctx.rel(path)} ({meta.note()})"}, block])
        if b"\x00" in raw[:8000]:
            return ToolResult(f"{ctx.rel(path)} looks like a binary file; not reading it.", True)
        text = read_text(path)
        lines = text.splitlines()
        offset = max(args.get("offset", 1), 1)
        limit = args.get("limit", MAX_LINES)
        chunk = lines[offset - 1 : offset - 1 + limit]
        partial = offset > 1 or offset - 1 + limit < len(lines)
        ctx.file_state.remember(path, text, partial=partial)
        if not lines:
            return ToolResult("(file is empty)")
        body = number_lines([ln[:MAX_LINE_CHARS] for ln in chunk], offset)
        if partial:
            body += f"\n\n[showing lines {offset}-{offset + len(chunk) - 1} of {len(lines)}]"
        return ToolResult(body)
