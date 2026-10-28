"""工具的公共骨架：一个工具 = 名字 + 描述 + JSON Schema + run()。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .file_state import FileStateCache


@dataclass
class ToolResult:
    # str 或 content block 列表（第 19 章的图片会用到列表形式）
    content: str | list[dict[str, Any]]
    is_error: bool = False


@dataclass
class ToolContext:
    """工具运行时能拿到的「外部世界」。新能力往这里加字段，而不是让工具 import 全局变量。"""

    cwd: Path
    extras: dict[str, Any] = field(default_factory=dict)
    # 第 7 章：读过哪些文件、读时的版本
    file_state: FileStateCache = field(default_factory=FileStateCache)
    # 写文件前的钩子（第 13 章 /rewind 在这里给文件拍快照）
    write_hooks: list[Callable[[Path], None]] = field(default_factory=list)

    # 第 16 章：当前正在执行的 tool_use id（后台任务的通知里要带上它）；这些目录下的文件变化不提醒模型
    tool_use_id: str = ""
    # 第 20 章：工具想在 tool_result 之后追加的普通文本块（skill 正文），循环在这一批结果之后统一放进去
    followup_blocks: list[dict[str, Any]] = field(default_factory=list)
    untracked_dirs: list[Path] = field(default_factory=list)

    # 第 11 章：工具想告诉 UI 的事件（比如任务清单变了）先放这里，循环在 ToolEnd 之后统一转发
    pending_events: list[Any] = field(default_factory=list)

    def emit(self, event: Any) -> None:
        self.pending_events.append(event)

    def before_write(self, path: Path) -> None:
        for fn in self.write_hooks:
            fn(path)

    def rel(self, path: Path) -> str:
        """给人和模型看的路径：项目内用相对路径，项目外用绝对路径。"""
        try:
            return str(path.relative_to(self.cwd.resolve()))
        except ValueError:
            return str(path)

    def resolve(self, path: str) -> Path:
        p = Path(path).expanduser()
        return (p if p.is_absolute() else self.cwd / p).resolve()


class Tool:
    name: str = ""
    description: str = ""
    input_schema: dict[str, Any] = {"type": "object", "properties": {}}
    # 第 5 章：权限相关的元信息
    read_only: bool = False          # 只读工具默认放行
    kind: str = "other"              # read | edit | exec | other；acceptEdits 模式放行 edit
    path_arg: str | None = None      # edit 类工具的路径参数名，用来判断是否在项目目录内

    def self_check(self, args: dict[str, Any]) -> str | None:
        """工具对这次调用的自我评估：'allow'（确定安全）/ 'ask'（高危，任何非 bypass 模式都要问）/ None（交给模式决定）。"""
        return None

    def rule_key(self, args: dict[str, Any]) -> str:
        """「本会话不再询问」记住的规则。默认整个工具；Bash 按具体命令。"""
        return self.name

    def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:  # pragma: no cover
        raise NotImplementedError

    def schema(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}

    def summary(self, args: dict[str, Any]) -> str:
        """给人看的一行摘要，例如 Bash(npm test)。"""
        first = next(iter(args.values()), "") if args else ""
        return f"{self.name}({str(first)[:60]})"
