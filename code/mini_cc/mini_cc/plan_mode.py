"""plan 模式（第 21 章）：先只读地探索、把方案写进计划文件，你批准了才动手。

plan 模式不是一个开关，而是四样东西配合：
1. 规则提醒（provider）：进入 plan 时注入完整规则，之后每隔几步注入精简版，退出时注入「已退出」。
   和其他 provider 一样不记标志位：扫描历史里最近一条 plan 提醒，和当前模式比对。
2. 权限关卡（PermissionManager.extra_checks，排在 bypass 之前）：只读的放行；计划文件可写；
   改动状态的命令要问你；其余编辑一律拒绝，拒绝理由里告诉模型该怎么做。
3. 交接工具：ExitPlanMode 读计划文件、弹出审批，批准后切到你选的模式；EnterPlanMode 让模型主动进入。
4. 只读的 sub agent：Plan / Explore；plan 模式下派出的任何 sub agent 都是只读的。
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .attachments import Attachment, is_reminder
from .permissions import ACCEPT_EDITS, DEFAULT, PLAN, Decision, PermissionManager
from .tools.base import Tool, ToolContext, ToolResult

if TYPE_CHECKING:  # pragma: no cover
    from .context import InjectState

FULL_HEADER = "# Plan mode is active"
SPARSE_HEADER = "# Plan mode still active"
EXIT_HEADER = "# Exited plan mode"
SPARSE_EVERY = 5   # 距离上一条 plan 提醒多少次模型请求后，再提醒一次精简版

FULL_TEXT = """{header}
The user wants a plan before any change is made. Until they approve it you MUST NOT edit files, run commands that
change state (installs, writes, git commits, migrations), or otherwise modify the system. This overrides other
instructions. The only file you may create or edit is the plan file: {plan}

Workflow:
1. Understand: read the relevant code with Read and read-only Bash (grep, find, git log). For wide searches, launch
   Explore agents (several in parallel if the areas are independent) so your context stays small.
2. Clarify: if a decision would change the approach (scope, API shape, trade-offs), ask with AskUserQuestion.
   Do not ask about things you can decide with a sensible default.
3. Design: for non-trivial work, a Plan agent can draft an approach; check it against the code yourself.
4. Write the plan file: the goal in one or two sentences, the approach, the files to change and how, what you
   deliberately leave out, and how you will verify it (tests to run, behaviour to check). Concise and concrete.
5. Call ExitPlanMode. It shows the plan file to the user and waits for approval. Do not ask "is this plan OK?"
   in plain text; ExitPlanMode is how you ask."""

SPARSE_TEXT = ("{header}: read-only except the plan file ({plan}). Follow the workflow given earlier and call "
               "ExitPlanMode when the plan is ready.")
EXIT_TEXT = ("{header}\nYou have exited plan mode. You can now make edits, run tools and take actions. "
             "The approved plan is in {plan}; refer back to it while implementing.")


# ---------------------------------------------------------------- 1. 规则提醒


def _plan_reminder_kind(text: str) -> str | None:
    for kind, header in (("full", FULL_HEADER), ("sparse", SPARSE_HEADER), ("exit", EXIT_HEADER)):
        if header in text:
            return kind
    return None


def plan_mode_provider(plan_file: Callable[[], Path]) -> Callable[["InjectState"], Attachment | None]:
    def provide(st: "InjectState") -> Attachment | None:
        mode = st.agent.permissions.mode
        last, gap = None, 0
        for m in reversed(st.messages):                  # 最近一条 plan 提醒，以及它之后有几次模型请求
            if m["role"] == "assistant":
                gap += 1
                continue
            blocks = m["content"] if isinstance(m["content"], list) else []
            kinds = [k for b in blocks if is_reminder(b) and (k := _plan_reminder_kind(b["text"]))]
            if kinds:
                last = kinds[-1]
                break
        plan = plan_file()
        if mode == PLAN:
            if last in (None, "exit"):
                return Attachment("plan_mode", "plan 模式规则（完整）",
                                  FULL_TEXT.format(header=FULL_HEADER, plan=plan))
            if gap >= SPARSE_EVERY:
                return Attachment("plan_mode", "plan 模式提醒", SPARSE_TEXT.format(header=SPARSE_HEADER, plan=plan))
            return None
        if last in ("full", "sparse"):
            return Attachment("plan_mode", "已退出 plan 模式", EXIT_TEXT.format(header=EXIT_HEADER, plan=plan))
        return None

    return provide


# ---------------------------------------------------------------- 2. 权限关卡


def plan_check(plan_file: Callable[[], Path]) -> Callable[[Tool, dict[str, Any], PermissionManager], Decision | None]:
    def check(tool: Tool, args: dict[str, Any], pm: PermissionManager) -> Decision | None:
        if pm.mode != PLAN:
            return None
        if tool.name in ("ExitPlanMode", "EnterPlanMode") or tool.read_only:
            return None                                  # 交给后面的判定链（只读的会被放行）
        plan = plan_file()
        if tool.kind == "edit" and tool.path_arg and args.get(tool.path_arg):
            target = Path(args[tool.path_arg]).expanduser()
            target = (target if target.is_absolute() else pm.cwd / target).resolve()
            if target == plan.resolve():
                return Decision("allow", "plan mode: writing the plan file", "check")
        if tool.self_check(args) == "allow":
            return None                                  # 只读命令、维护 agent 自己的状态（任务清单、记忆……）
        if tool.kind in ("exec", "mcp"):
            return Decision("ask", "plan mode: this is not read-only", "check")
        return Decision("deny", f"plan mode is active; only the plan file {plan} may be written. Finish the plan "
                                "and call ExitPlanMode to ask the user for approval", "check")

    return check


# ---------------------------------------------------------------- 3. 交接工具


class ExitPlanModeTool(Tool):
    name = "ExitPlanMode"
    kind = "plan"
    description = ("Present the plan in the plan file to the user for approval and leave plan mode if they approve. "
                   "Call it only in plan mode, after you have written the plan file. The user may approve (you then "
                   "implement the plan) or send you back to keep planning with feedback.")
    input_schema = {"type": "object", "properties": {}, "additionalProperties": False}

    def self_check(self, args) -> str | None:
        return "allow"  # 它自己就是一次审批，不用再套一层权限弹窗

    def summary(self, args) -> str:
        return "ExitPlanMode()"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        plan_ctl = ctx.extras.get("plan")
        if plan_ctl is None or plan_ctl.mode() != PLAN:
            return ToolResult("You are not in plan mode.", True)
        path: Path = plan_ctl.plan_file()
        plan = path.read_text(encoding="utf-8").strip() if path.is_file() else ""
        if not plan:
            return ToolResult(f"No plan found. Write your plan to {path} first, then call ExitPlanMode.", True)
        choice, feedback = plan_ctl.approve(plan)
        if choice in ("auto", "manual"):
            plan_ctl.set_mode(ACCEPT_EDITS if choice == "auto" else DEFAULT)
            # 措辞参考 Claude Code 的原文（二进制里的字符串）
            return ToolResult("User has approved your plan. You can now start coding. Start with updating your todo "
                              f"list if applicable. Your plan has been saved to: {path} You can refer back to it if "
                              f"needed during implementation.\n\n## Approved Plan:\n{plan}")
        return ToolResult("The user reviewed the plan and wants you to keep planning (still in plan mode). "
                          + (f"Their feedback:\n{feedback}" if feedback else "Ask what to change if it is unclear."))


class EnterPlanModeTool(Tool):
    name = "EnterPlanMode"
    kind = "plan"
    description = ("Switch to plan mode before a large or ambiguous change: explore read-only, write a plan, and get "
                   "the user's approval before editing. Use it when the task touches many files or the right "
                   "approach is unclear. Do not use it for small, clear changes.")
    input_schema = {"type": "object", "properties": {}, "additionalProperties": False}

    def self_check(self, args) -> str | None:
        return "allow"  # 进入 plan 只会让自己受更多限制

    def summary(self, args) -> str:
        return "EnterPlanMode()"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        plan_ctl = ctx.extras.get("plan")
        if plan_ctl is None:
            return ToolResult("Plan mode is not available here.", True)
        if plan_ctl.mode() == PLAN:
            return ToolResult("Already in plan mode.")
        plan_ctl.set_mode(PLAN)
        return ToolResult("Entered plan mode. Explore and design first; write your plan to the plan file and call "
                          "ExitPlanMode for approval before making any change.")


class PlanController:
    """App 提供给工具的那一小块能力：当前模式、切换模式、计划文件位置、审批界面。"""

    def __init__(self, pm: PermissionManager, plan_file: Callable[[], Path],
                 approve: Callable[[str], tuple[str, str]]):
        self._pm, self.plan_file, self.approve = pm, plan_file, approve

    def mode(self) -> str:
        return self._pm.mode

    def set_mode(self, mode: str) -> None:
        self._pm.set_mode(mode)
