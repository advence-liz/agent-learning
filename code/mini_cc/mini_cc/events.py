"""Agent 循环对外产出的事件。UI、持久化、测试都只消费事件，不碰循环内部。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .model import TextDelta, ThinkingDelta
from .tools.base import ToolResult


@dataclass
class ToolStart:
    id: str
    name: str
    input: dict[str, Any]
    summary: str


@dataclass
class ToolEnd:
    id: str
    name: str
    result: ToolResult


@dataclass
class Notice:
    """循环里发生的、值得告诉用户的事（重试、错误、注入了提醒……）。"""

    text: str
    level: str = "info"  # info | warn | error


@dataclass
class PermissionDecision:
    """一次权限判定的结论。只有「值得一提」的才 yield：被拒绝、用户批准、审查员自动放行。"""

    tool_id: str
    summary: str
    behavior: str  # allow | deny
    reason: str
    source: str


@dataclass
class ContextInjected:
    """客户端往上下文里注入了一个附件（第 9 章）。UI 显示成「◇ system …」。"""

    kind: str
    title: str


@dataclass
class TasksUpdated:
    """任务清单变了（第 11 章）。rendered 是清单的文本形式。"""

    rendered: str


@dataclass
class TurnEnd:
    stop_reason: str
    text: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


Event = TextDelta | ThinkingDelta | ToolStart | ToolEnd | Notice | PermissionDecision | ContextInjected | TasksUpdated | TurnEnd

__all__ = ["Event", "TextDelta", "ThinkingDelta", "ToolStart", "ToolEnd", "Notice", "PermissionDecision", "ContextInjected", "TasksUpdated", "TurnEnd"]
