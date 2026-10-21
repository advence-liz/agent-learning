"""工具注册表：模型只认识 schema 列表，循环只认识 execute()。"""

from __future__ import annotations

from typing import Any

from .base import Tool, ToolContext, ToolResult
from .validate import validate


def tool_error(msg: str) -> ToolResult:
    # 和 Claude Code 一样用 <tool_use_error> 包起来，模型一眼能区分「工具报错」和「命令输出里恰好有 error 字样」
    return ToolResult(f"<tool_use_error>{msg}</tool_use_error>", is_error=True)


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None):
        self._tools: dict[str, Tool] = {}
        for t in tools or []:
            self.register(t)

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def unregister(self, name: str) -> None:
        self._tools.pop(name, None)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return list(self._tools)

    def schemas(self) -> list[dict[str, Any]]:
        # 顺序稳定（注册顺序）——工具列表在 prompt 最前面，顺序一变 prompt cache 就全废
        return [t.schema() for t in self._tools.values()]

    def check_input(self, name: str, args: Any) -> ToolResult | None:
        """防线 1：工具存在、参数合法。返回 None 表示通过。（权限判定要在这之后做，否则会拿着坏参数做判断）"""
        tool = self._tools.get(name)
        if tool is None:
            return tool_error(f"Error: No such tool available: {name}. Available: {', '.join(self._tools)}")
        if not isinstance(args, dict):
            return tool_error(f"InputValidationError: {name} input must be an object, got {type(args).__name__}")
        errors = validate(args, tool.input_schema)
        if errors:
            return tool_error(f"InputValidationError: {name} failed due to the following issues:\n" + "\n".join(errors))
        return None

    def execute(self, name: str, args: dict[str, Any], ctx: ToolContext, max_output: int = 30000) -> ToolResult:
        """两道防线：执行前校验参数；执行时任何异常都变成 is_error 的工具结果，绝不往外抛。"""
        bad = self.check_input(name, args)
        if bad is not None:
            return bad
        tool = self._tools[name]
        # 防线 2：执行期异常
        try:
            result = tool.run(args, ctx)
        except Exception as e:  # noqa: BLE001
            return tool_error(f"{type(e).__name__}: {e}")
        return truncate(result, max_output)


def truncate(result: ToolResult, limit: int) -> ToolResult:
    if isinstance(result.content, str) and len(result.content) > limit:
        head = result.content[:limit]
        dropped = len(result.content) - limit
        return ToolResult(f"{head}\n\n[output truncated: {dropped} more chars]", result.is_error)
    return result
