from .base import Tool, ToolContext, ToolResult
from .bash import BashTool
from .edit import EditTool
from .read import ReadTool
from .registry import ToolRegistry
from .write import WriteTool


def default_tools() -> list[Tool]:
    return [ReadTool(), WriteTool(), EditTool(), BashTool()]


__all__ = ["Tool", "ToolContext", "ToolResult", "ToolRegistry", "default_tools"]
