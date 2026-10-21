"""工具调用的权限判定。

判定顺序（先命中先返回）：
    1. deny 规则                       → deny
    2. extra_checks（扩展钩子）         → 第一个非 None 的结论（第 21 章 plan 模式挂在这里）
    3. bypassPermissions 模式           → allow
    4. 工具自检 'ask'（高危命令）        → ask（acceptEdits / auto 也得问）
    5. 只读工具 / 自检 'allow'          → allow
    6. 会话 allow 规则（「不再询问」）    → allow
    7. acceptEdits 且是项目内的编辑      → allow
    8. auto 模式                        → 交给审查员（第 6 章）
    9. 其余                             → ask（问用户）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .tools.base import Tool

DEFAULT = "default"
ACCEPT_EDITS = "acceptEdits"
AUTO = "auto"
PLAN = "plan"
BYPASS = "bypassPermissions"
MODES = [DEFAULT, ACCEPT_EDITS, AUTO, PLAN, BYPASS]


@dataclass
class Decision:
    behavior: str  # allow | ask | deny
    reason: str
    source: str = "mode"  # rule | check | mode | tool | user | classifier


@dataclass
class PermissionRequest:
    tool: Tool
    args: dict[str, Any]
    summary: str
    rule_key: str
    reason: str


@dataclass
class PermissionReply:
    choice: str  # once | always | deny
    feedback: str = ""


Check = Callable[[Tool, dict[str, Any], "PermissionManager"], Decision | None]


@dataclass
class PermissionManager:
    cwd: Path
    mode: str = DEFAULT
    allow_rules: set[str] = field(default_factory=set)
    deny_rules: set[str] = field(default_factory=set)
    # Shift+Tab 循环的顺序（第 21 章加入 plan）
    cycle: list[str] = field(default_factory=lambda: [DEFAULT, ACCEPT_EDITS, AUTO])
    extra_checks: list[Check] = field(default_factory=list)
    # 第 6 章：auto 模式下由它判定，签名 (tool, args) -> Decision
    classifier: Callable[[Tool, dict[str, Any]], Decision] | None = None
    # 模式变化时通知（落盘、UI 刷新）
    on_mode_change: list[Callable[[str, str], None]] = field(default_factory=list)

    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}, choose from {MODES}")
        old, self.mode = self.mode, mode
        if old != mode:
            for fn in self.on_mode_change:
                fn(old, mode)

    def next_mode(self) -> str:
        i = self.cycle.index(self.mode) if self.mode in self.cycle else -1
        self.set_mode(self.cycle[(i + 1) % len(self.cycle)])
        return self.mode

    # ------------------------------------------------------------ 判定

    def _inside_project(self, tool: Tool, args: dict[str, Any]) -> bool:
        if not tool.path_arg or tool.path_arg not in args:
            return False
        p = Path(args[tool.path_arg]).expanduser()
        p = (p if p.is_absolute() else self.cwd / p).resolve()
        return p.is_relative_to(self.cwd.resolve())

    def decide(self, tool: Tool, args: dict[str, Any]) -> Decision:
        key = tool.rule_key(args)
        if key in self.deny_rules or tool.name in self.deny_rules:
            return Decision("deny", f"matches deny rule {key}", "rule")
        for check in self.extra_checks:
            d = check(tool, args, self)
            if d is not None:
                return d
        if self.mode == BYPASS:
            return Decision("allow", "bypassPermissions mode", "mode")
        verdict = tool.self_check(args)
        if verdict == "ask":
            return Decision("ask", "high-risk operation", "tool")
        if tool.read_only or verdict == "allow":
            return Decision("allow", "read-only", "tool")
        if key in self.allow_rules or tool.name in self.allow_rules:
            return Decision("allow", f"session rule {key}", "rule")
        # auto 模式包含 acceptEdits 的快速通道：项目内编辑不必劳烦审查员
        if self.mode in (ACCEPT_EDITS, AUTO) and tool.kind == "edit" and self._inside_project(tool, args):
            return Decision("allow", "acceptEdits: edit inside project", "mode")
        if self.mode == AUTO and self.classifier is not None:
            return self.classifier(tool, args)
        return Decision("ask", "needs approval", "mode")

    def remember(self, req: PermissionRequest) -> None:
        self.allow_rules.add(req.rule_key)


def denied_message(feedback: str = "") -> str:
    # 措辞参考 Claude Code：明确告诉模型「没执行」，以及接下来该怎么做
    base = "The user doesn't want to proceed with this tool use. The tool use was rejected (it was NOT executed)."
    if feedback:
        return f"{base} To tell you how to proceed, the user said:\n{feedback}"
    return f"{base} STOP what you are doing and wait for the user to tell you how to proceed."
