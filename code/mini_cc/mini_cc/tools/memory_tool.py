"""Memory 工具：模型保存 / 更新 / 删除一条长期记忆（第 12 章）。"""

from __future__ import annotations

from ..memory import TYPES, MemoryStore, slugify
from .base import Tool, ToolContext, ToolResult


class MemoryTool(Tool):
    name = "Memory"
    kind = "memory"
    description = (
        "Save, update or delete a persistent memory for this project (see the # Memory section of the system "
        "prompt for what is worth remembering). action=save writes a topic file and its one-line entry in "
        "MEMORY.md; saving with an existing slug updates that memory. action=delete removes it."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["save", "delete"]},
            "type": {"type": "string", "enum": list(TYPES)},
            "name": {"type": "string", "description": "Short title, e.g. 'Commit message prefixes'"},
            "description": {"type": "string", "description": "One line for the index: when is this relevant?"},
            "body": {"type": "string", "description": "The memory itself. For feedback, add **Why:** and **How to apply:**"},
            "slug": {"type": "string", "description": "Existing slug to update or delete (file name without .md)"},
        },
        "required": ["action"],
        "additionalProperties": False,
    }

    def self_check(self, args) -> str | None:
        # 不是只读，但只写 agent 自己的记忆目录、不碰项目文件：和任务清单一样免审批
        return "allow"

    def summary(self, args) -> str:
        return f"Memory({args.get('action')} {args.get('slug') or args.get('name', '')})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        store: MemoryStore | None = ctx.extras.get("memory")
        if store is None:
            return ToolResult("Memory is not available in this session.", True)
        if args["action"] == "delete":
            slug = args.get("slug") or slugify(args.get("name", ""))
            if not store.delete(slug):
                return ToolResult(f"No memory with slug {slug!r}. Check the MEMORY.md index for slugs.", True)
            return ToolResult(f"Deleted memory {slug}.")
        missing = [k for k in ("type", "name", "description", "body") if not args.get(k)]
        if missing:
            return ToolResult(f"action=save needs: {', '.join(missing)}", True)
        path, note = store.save(args["type"], args["name"], args["description"], args["body"], args.get("slug"))
        return ToolResult(f"Saved memory {path.stem} to {path}. Its index line is in MEMORY.md and will be loaded "
                          f"into future sessions (you already know it in this one).{note}")
