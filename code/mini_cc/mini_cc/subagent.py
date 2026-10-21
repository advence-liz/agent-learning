"""Sub Agent（第 17 章）：在一次工具调用的内部，用一个全新的 messages 数组再跑一遍 agent 循环。

- 隔离：子 agent 只看到「委派 prompt」，看不到父历史；父 agent 只拿回最终结论（外加一行统计）。
- 能力：每种 agent 类型 = system 说明 + 工具子集 + 权限约束。内置 Explore（只读）和 general-purpose，
  也可以在 <项目>/.mini_cc/agents/*.md 或 <home>/agents/*.md 里自定义（frontmatter: name / description / tools）。
- 前台：同步跑完，结论作为 tool_result 返回；进度通过 progress 回调实时给人看（不进任何上下文）。
- 后台：交给第 16 章的 JobManager 起线程，结束时 <task-notification> 里带上 <result>。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .events import ToolStart, TurnEnd
from .permissions import Decision, PermissionManager
from .tools.base import Tool, ToolContext, ToolResult

# 子 agent 不能用的工具：再派 agent（防止无限递归）、问用户（它没有用户）、父会话自己的状态
NEVER_FOR_CHILDREN = {"Agent", "AskUserQuestion", "TaskCreate", "TaskUpdate", "TaskList", "Memory", "TaskStop", "Monitor"}

BASE_PROMPT = """You are a sub agent of mini-cc, started by the main agent to do one self-contained task.
You cannot see the main conversation: everything you know about the task is in the first user message.
Work autonomously with your tools; do not ask questions (nobody will answer). When you are done, reply with
a concise final report for the main agent: findings first, with file paths and line numbers where relevant.
Your final message is the ONLY thing the main agent will see, so include everything it needs and nothing it
does not (no raw file dumps)."""

EXPLORE_PROMPT = """You are an Explore agent: a fast, read-only code search specialist.
You MUST NOT change anything: no writing or editing files, no commands that modify state. Use Read and
read-only Bash commands (grep, find, ls, git log/show/diff, cat). Search broadly first, then read only what you need."""

GENERAL_PROMPT = """You are a general-purpose agent: research complex questions, search code and carry out multi-step
tasks, including editing files and running commands when the task asks for it."""


@dataclass
class AgentType:
    name: str
    description: str
    prompt: str
    tools: list[str] | None = None        # None = 父 agent 的全部工具（减去 NEVER_FOR_CHILDREN）
    read_only: bool = False
    load_instructions: bool = True        # 要不要注入 AGENTS.md / CLAUDE.md（Claude Code 的 Explore 不注入）
    effort: str = "medium"


BUILTIN = [
    AgentType("general-purpose", "Research, search code and execute multi-step tasks; can edit files.", GENERAL_PROMPT),
    AgentType("Explore", "Read-only, fast codebase search: find files, symbols and answer questions about the code.",
              EXPLORE_PROMPT, ["Read", "Bash"], read_only=True, load_instructions=False, effort="low"),
]


def _frontmatter(text: str) -> tuple[dict[str, str], str]:
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        if v:
            meta[k.strip()] = v.strip()
    return meta, m.group(2)


def load_agent_types(cwd: Path, home: Path) -> dict[str, AgentType]:
    """内置 → 用户级 <home>/agents → 项目级 <cwd>/.mini_cc/agents，后面的同名覆盖前面的。"""
    types = {t.name: t for t in BUILTIN}
    for d in (home / "agents", cwd / ".mini_cc" / "agents"):
        for f in sorted(d.glob("*.md")) if d.is_dir() else []:
            meta, body = _frontmatter(f.read_text(encoding="utf-8"))
            name = meta.get("name") or f.stem
            tools = [t.strip() for t in meta["tools"].split(",") if t.strip()] if meta.get("tools") else None
            types[name] = AgentType(name, meta.get("description", ""), body.strip(), tools)
    return types


def _read_only_check(tool: Tool, args: dict[str, Any], pm: PermissionManager) -> Decision | None:
    """只读 agent 的硬约束：排在 bypass 之前（extra_checks），父亲是什么模式都不能写。"""
    if tool.read_only or tool.self_check(args) == "allow":
        return None
    return Decision("deny", "this agent is read-only; it must not modify files or run state-changing commands",
                    "check")


# ---------------------------------------------------------------- 跑一个子 agent


@dataclass
class SubagentRun:
    text: str
    tool_uses: int
    requests: int
    partial: bool
    messages: list[dict[str, Any]] = field(default_factory=list)


def run_subagent(parent: Any, kind: AgentType, prompt: str, client: Any, *, agent_id: str,
                 approver: Callable | None, progress: Callable[[str], None] | None,
                 transcript: Path | None, max_turns: int) -> SubagentRun:
    """parent 是父 Agent：只借用它的 settings、工具注册表和权限模式，不碰它的 messages。"""
    from .context import ContextBuilder, date_provider, instructions_provider
    from .loop import Agent
    from .tools import ToolRegistry

    allowed = [t for t in (parent.tools.get(n) for n in parent.tools.names()) if t is not None]
    allowed = [t for t in allowed if t.name not in NEVER_FOR_CHILDREN
               and (kind.tools is None or t.name in kind.tools)]
    settings = replace(parent.settings, max_iterations=max_turns, effort=kind.effort, auto_compact=False)
    child = Agent(client, ToolRegistry(allowed), settings)
    providers = [date_provider()] + ([instructions_provider(parent.context.home)] if kind.load_instructions else [])
    child.context = ContextBuilder(child, parent.context.home, providers=providers,
                                   static_prompt=f"{BASE_PROMPT}\n\n{kind.prompt}")
    # 自己的 ToolContext：自己的文件状态表（子 agent 读过的文件，父亲仍然要自己 Read 才能改）、没有 write_hooks
    child.ctx = ToolContext(cwd=parent.ctx.cwd)
    child.permissions = PermissionManager(parent.ctx.cwd, mode=parent.permissions.mode,
                                          allow_rules=set(parent.permissions.allow_rules))
    if kind.read_only:
        child.permissions.extra_checks.append(_read_only_check)
    child.approver = approver  # 后台 agent 没有 approver：需要审批的调用一律拒绝
    if transcript is not None:
        transcript.parent.mkdir(parents=True, exist_ok=True)

        def record(msg: dict[str, Any], meta: dict[str, Any]) -> None:
            rec = {"type": msg["role"], "isSidechain": True, "agentId": agent_id, "agentType": kind.name,
                   "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "message": msg}
            with transcript.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

        child.listeners.append(record)

    tool_uses, end = 0, None
    for ev in child.run_turn(prompt):
        if isinstance(ev, ToolStart):
            tool_uses += 1
            if progress:
                progress(f"{kind.name}: {ev.summary}")
        elif isinstance(ev, TurnEnd):
            end = ev
    text = end.text if end and end.text else ""
    partial = end is None or end.stop_reason not in ("end_turn", "stop_sequence")
    if partial:
        last = next((b["text"] for m in reversed(child.messages) if m["role"] == "assistant"
                     for b in m["content"] if b.get("type") == "text"), "")
        text = f"[partial] The sub agent stopped early ({end.stop_reason if end else 'unknown'}). " \
               f"Last thing it said:\n{text or last or '(nothing)'}"
    return SubagentRun(text, tool_uses, child.usage.requests, partial, child.messages)


# ---------------------------------------------------------------- Agent 工具


class AgentTool(Tool):
    name = "Agent"
    kind = "agent"

    def __init__(self, types: Callable[[], dict[str, AgentType]]):
        self._types = types

    @property
    def description(self) -> str:  # type: ignore[override]
        listing = "\n".join(f"- {t.name}: {t.description}" + (f" (tools: {', '.join(t.tools)})" if t.tools else "")
                            for t in self._types().values())
        return ("Launch a sub agent to handle a self-contained task in its own context window. It cannot see this "
                "conversation, so the prompt must contain everything it needs (paths, constraints, what to return). "
                "Use it when exploring would pull lots of material into your context but you only need the "
                "conclusion. Do not use it for a quick single lookup you can do yourself.\n"
                "Set run_in_background=true to keep working while it runs; you will get a <task-notification> "
                "with its result.\n\nAvailable agent types:\n" + listing)

    input_schema = {
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "3-5 words, shown to the user"},
            "prompt": {"type": "string", "description": "The full, self-contained task"},
            "subagent_type": {"type": "string", "description": "One of the available agent types"},
            "run_in_background": {"type": "boolean"},
        },
        "required": ["description", "prompt", "subagent_type"],
        "additionalProperties": False,
    }

    def self_check(self, args) -> str | None:
        return "allow"  # 派 agent 本身不碰任何东西；子 agent 的每个工具调用各自过权限

    def summary(self, args) -> str:
        return f"Agent({args.get('subagent_type')}: {args.get('description', '')})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        rt = ctx.extras.get("subagents")
        types = self._types()
        kind = types.get(args["subagent_type"])
        if rt is None:
            return ToolResult("Sub agents are not available here.", True)
        if kind is None:
            return ToolResult(f"Unknown subagent_type {args['subagent_type']!r}. Available: {', '.join(types)}", True)
        return rt.launch(kind, args, ctx)


class SubagentRuntime:
    """App 提供的运行时：拿哪个 client、往哪写 transcript、前台进度给谁看、后台交给谁。"""

    def __init__(self, app: Any):
        self.app = app
        self.count = 0

    def launch(self, kind: AgentType, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        app = self.app
        self.count += 1
        agent_id = f"a{self.count}"
        desc = args["description"]
        transcript = app.session.path.parent / app.session.id / "subagents" / f"agent-{agent_id}.jsonl"
        common = dict(agent_id=agent_id, transcript=transcript, max_turns=app.subagent_max_turns)
        if args.get("run_in_background"):
            def work(job):
                r = run_subagent(app.agent, kind, args["prompt"], app.subagent_client(desc),
                                 approver=None, progress=None, **common)
                status = "failed" if r.partial else "completed"
                return status, f'Agent "{desc}" {status} ({r.tool_uses} tool uses)', r.text

            job = app.jobs.start_thread("agent", "a", desc, work, ctx.tool_use_id, job_id=agent_id)
            return ToolResult(f"Async agent launched successfully.\nagentId: {job.id}\nThe agent is working in the "
                              "background. You will be notified automatically when it completes. Continue with "
                              "other work; do not wait or poll for it.")
        r = run_subagent(app.agent, kind, args["prompt"], app.subagent_client(desc), approver=app.agent.approver,
                         progress=lambda s: app.ui.info(f"  ⎿ {s}"), **common)
        uses = f"{r.tool_uses} tool use{'s' if r.tool_uses != 1 else ''}"
        return ToolResult(f"{r.text}\n\n(agent {agent_id} · {kind.name} · {uses} · {r.requests} requests)")
