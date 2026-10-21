"""Edit：精确字符串替换。语义照 Claude Code 的 Edit 工具：

- old_string 必须在文件里**恰好出现一次**；出现多次要么给更多上下文，要么显式 replace_all=true
- old_string == new_string 拒绝（没有意义的编辑）
- 先读后改、读后未变（见 file_state.guard_write）
- old_string 为空 + 文件不存在 = 新建文件
失败时的报错要告诉模型「下一步该怎么做」，这比报错本身重要。
"""

from __future__ import annotations

import re

from .base import Tool, ToolContext, ToolResult
from .file_state import guard_write, read_text, write_text
from .read import number_lines

LINE_PREFIX = re.compile(r"^ *\d+\t", re.M)  # Read 输出的「行号+tab」前缀
CURLY = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})


def err(msg: str) -> ToolResult:
    return ToolResult(f"<tool_use_error>{msg}</tool_use_error>", True)


def _diagnose_not_found(text: str, old: str) -> str:
    """找不到 old_string 时，猜一猜模型是怎么抄错的，给出具体建议。"""
    hints = []
    if LINE_PREFIX.search(old) and LINE_PREFIX.sub("", old) in text:
        hints.append("old_string contains line-number prefixes copied from Read output (e.g. '    12\\t'). "
                     "Remove them; the line numbers are not part of the file.")
    elif old.translate(CURLY) in text.translate(CURLY):
        hints.append("The text matches only if curly quotes are replaced by straight quotes (or vice versa). "
                     "Copy the quotes exactly as they appear in the file.")
    elif old.strip() and old.strip() in text:
        hints.append("The text exists but leading/trailing whitespace or indentation differs. "
                     "Preserve the exact indentation (tabs vs spaces).")
    else:
        hints.append("Re-read the file and copy the exact surrounding text.")
    return f"String to replace not found in file.\nString: {old}\n(hint: {' '.join(hints)})"


def _snippet(text: str, pos: int, new: str, ctx_lines: int = 3) -> str:
    lines = text.splitlines()
    first = text.count("\n", 0, pos)
    last = first + new.count("\n")
    lo, hi = max(first - ctx_lines, 0), min(last + ctx_lines + 1, len(lines))
    return number_lines(lines[lo:hi], lo + 1)


class EditTool(Tool):
    name = "Edit"
    kind = "edit"
    path_arg = "file_path"
    description = (
        "Replace an exact string in a file. Rules: (1) Read the file first. (2) old_string must match the file "
        "exactly, including indentation, and must be unique; add surrounding lines to make it unique, or set "
        "replace_all=true to change every occurrence. (3) Never include the line-number prefix from Read output. "
        "(4) To create a new file, use an empty old_string."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "file_path": {"type": "string"},
            "old_string": {"type": "string", "description": "Exact text to replace"},
            "new_string": {"type": "string", "description": "Replacement text (must differ from old_string)"},
            "replace_all": {"type": "boolean", "description": "Replace every occurrence (default false)"},
        },
        "required": ["file_path", "old_string", "new_string"],
        "additionalProperties": False,
    }

    def summary(self, args) -> str:
        return f"Edit({args.get('file_path', '')})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        path = ctx.resolve(args["file_path"])
        old, new, replace_all = args["old_string"], args["new_string"], args.get("replace_all", False)
        if old == new:
            return err("No changes to make: old_string and new_string are exactly the same.")

        if not path.exists():
            if old == "":
                ctx.before_write(path)
                write_text(path, new)
                ctx.file_state.remember(path, new)
                return ToolResult(f"Created {ctx.rel(path)}")
            return err(f"File does not exist: {ctx.rel(path)}")
        if old == "":
            return err("old_string is empty but the file already exists. Use Write to overwrite, "
                       "or give the exact text to replace.")

        guard = guard_write(ctx.file_state, path)
        if guard:
            return err(guard)

        text = read_text(path)
        if old not in text and "\r\n" in text and "\r\n" not in old:
            # 文件是 CRLF、模型给的是 LF：按文件的换行风格对齐
            old, new = old.replace("\n", "\r\n"), new.replace("\n", "\r\n")
        count = text.count(old)
        if count == 0:
            return err(_diagnose_not_found(text, old))
        if count > 1 and not replace_all:
            return err(f"Found {count} matches of the string to replace, but replace_all is false. "
                       "To replace all occurrences, set replace_all to true. To replace only one occurrence, "
                       f"please provide more context to uniquely identify the instance.\nString: {old}")

        pos = text.index(old)
        updated = text.replace(old, new) if replace_all else text.replace(old, new, 1)
        ctx.before_write(path)
        write_text(path, updated)
        ctx.file_state.remember(path, updated)
        n = count if replace_all else 1
        return ToolResult(f"The file {ctx.rel(path)} has been updated ({n} replacement{'s' if n > 1 else ''}). "
                          f"Snippet:\n{_snippet(updated, pos, new)}")
