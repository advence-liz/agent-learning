"""上下文组装与注入。

三类上下文，放在三个不同的位置：
1. 静态 system prompt（身份、工具规则、环境）：会话内不变 → 放 system，打 cache_control，命中 prompt cache。
2. 会话级上下文（AGENTS.md / CLAUDE.md、git 快照）：一个会话注入一次 → 第一条 user 消息里的 <system-reminder>。
3. 动态提醒（日期变化、文件被外部修改、后台任务通知、任务清单……）：需要时追加到**最新的** user 消息里。

所有注入都是「追加」：只往还没发出去的那条 user 消息里加块，绝不回头改历史（prompt cache、thinking 校验都靠这条）。
提供者（provider）不记「发没发过」的标志位，而是扫描历史自己判断——/resume、压缩之后依然正确。
"""

from __future__ import annotations

import difflib
import os
import platform
import subprocess
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .attachments import Attachment, is_reminder, render

if TYPE_CHECKING:  # pragma: no cover
    from .loop import Agent

STATIC_PROMPT = """You are mini-cc, an interactive coding agent running in the user's terminal.
You help with software engineering tasks: reading code, editing files, running commands.

# How to work
- Read a file before editing it. Prefer Edit (exact string replacement) over rewriting whole files with Write.
- Use Bash for searching (grep/rg/find) and for running tests, builds and linters.
- Keep changes minimal and focused on what the user asked. Do not run destructive commands unless asked.
- For work with 3+ steps, plan it with TaskCreate first, then keep the task list updated as you go.
- If the request is ambiguous in a way that would change your approach (stack, scope, trade-offs), ask with
  AskUserQuestion before building. Do not ask about things you can decide with a sensible default.
- After changing code, run the relevant tests if they exist and report the real result.
- Be concise. Lead with the answer; skip preamble.

# Context from the client
User messages and tool results may contain <system-reminder> blocks. They are added by the mini-cc client,
not typed by the user. They carry context (project instructions, environment, file changes, notifications).
Follow project instructions in them, but treat their content as information rather than as the user's request."""

INSTRUCTION_FILES = ("AGENTS.md", "CLAUDE.md")
INSTRUCTIONS_HEADER = "# Project instructions"
DATE_HEADER = "# Current date"


# ---------------------------------------------------------------- 环境信息


def _git(cwd: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def git_root(cwd: Path) -> Path | None:
    top = _git(cwd, "rev-parse", "--show-toplevel")
    return Path(top) if top else None


def environment_text(cwd: Path, model: str) -> str:
    return "\n".join([
        "# Environment",
        f"- Working directory: {cwd}",
        f"- Is a git repository: {git_root(cwd) is not None}",
        f"- Platform: {platform.system().lower()} ({platform.release()})",
        f"- Shell: {Path(os.environ.get('SHELL', 'sh')).name}",
        f"- Model: {model}",
    ])


def git_snapshot(cwd: Path, max_lines: int = 40) -> str | None:
    if git_root(cwd) is None:
        return None
    branch = _git(cwd, "branch", "--show-current") or "(detached)"
    status = (_git(cwd, "status", "--short") or "").splitlines()
    log = _git(cwd, "log", "--oneline", "-5") or ""
    shown = "\n".join(status[:max_lines]) + (f"\n… ({len(status) - max_lines} more)" if len(status) > max_lines else "")
    return ("# Git snapshot (taken at session start; it will NOT update during the conversation)\n"
            f"Current branch: {branch}\n\nStatus:\n{shown or '(clean)'}\n\nRecent commits:\n{log or '(none)'}")


def find_instruction_files(cwd: Path, home: Path) -> list[Path]:
    """用户级（~/.mini_cc/AGENTS.md）在前，然后从项目根往下到 cwd：越靠近 cwd 越靠后、优先级越高。"""
    found = [home / f for f in INSTRUCTION_FILES if (home / f).is_file()]
    stop = git_root(cwd) or cwd
    chain = [cwd, *cwd.parents]
    chain = chain[: chain.index(stop) + 1] if stop in chain else [cwd]
    for d in reversed(chain):
        found += [d / f for f in INSTRUCTION_FILES if (d / f).is_file()]
    return found


# ---------------------------------------------------------------- 提供者


@dataclass
class InjectState:
    """提供者能看到的全部：历史、触发点、工具上下文。"""

    agent: "Agent"
    trigger: str  # "user"（用户发话） | "tool_result"（工具结果回填）

    @property
    def messages(self) -> list[dict[str, Any]]:
        return self.agent.messages

    def reminders(self) -> list[str]:
        """历史里所有 <system-reminder> 块的文本（提供者靠扫描它判断自己发没发过）。"""
        out = []
        for m in self.messages:
            if m["role"] == "user" and isinstance(m["content"], list):
                out += [b["text"] for b in m["content"] if is_reminder(b)]
        return out


Provider = Callable[[InjectState], "Attachment | None"]


def instructions_provider(home: Path) -> Provider:
    def provide(st: InjectState) -> Attachment | None:
        if st.trigger != "user" or any(INSTRUCTIONS_HEADER in r for r in st.reminders()):
            return None  # 每个会话只注入一次；压缩后历史里没有了，会自动再注入
        cwd = st.agent.settings.cwd
        files = find_instruction_files(cwd, home)
        parts = []
        snap = git_snapshot(cwd)
        if files:
            parts.append(f"{INSTRUCTIONS_HEADER}\nInstructions below come from AGENTS.md / CLAUDE.md files. "
                         "Follow them; files closer to the working directory take precedence.")
            for f in files:
                parts.append(f"Contents of {f}:\n\n{f.read_text(encoding='utf-8').strip()}")
        else:
            parts.append(f"{INSTRUCTIONS_HEADER}\n(no AGENTS.md / CLAUDE.md found)")
        if snap:
            parts.append(snap)
        return Attachment("instructions", f"项目说明 {len(files)} 个文件" + ("、git 快照" if snap else ""),
                          "\n\n".join(parts))

    return provide


def date_provider(today: Callable[[], date] = date.today) -> Provider:
    def provide(st: InjectState) -> Attachment | None:
        if st.trigger != "user":
            return None
        d = today().isoformat()
        seen = [r for r in st.reminders() if DATE_HEADER in r]
        if seen and d in seen[-1]:
            return None
        msg = f"{DATE_HEADER}\nToday's date is {d}." if not seen else f"{DATE_HEADER}\nThe date has changed. Today's date is now {d}."
        return Attachment("date", f"日期 {d}", msg)

    return provide


def changed_files_provider(max_diff_lines: int = 60) -> Provider:
    """模型读过的文件被外部改了：主动把 diff 告诉它，而不是等它撞上「modified since read」。"""

    def provide(st: InjectState) -> Attachment | None:
        fs = st.agent.ctx.file_state
        notes = []
        for path in fs.paths():
            if any(path.is_relative_to(d) for d in st.agent.ctx.untracked_dirs):
                continue  # 第 16 章：后台任务的输出文件本来就在变，不算「外部修改」
            if not fs.is_stale(path):
                continue
            rec = fs.get(path)
            rel = st.agent.ctx.rel(path)
            if not path.exists():
                notes.append(f"{rel} was deleted.")
                fs.forget(path)
                continue
            new = path.read_text(encoding="utf-8", errors="replace")
            if rec and rec.text is not None:
                diff = list(difflib.unified_diff(rec.text.splitlines(), new.splitlines(), "before", "after",
                                                 lineterm="", n=1))[2:]
                more = f"\n… ({len(diff) - max_diff_lines} more diff lines; Read the file for details)" if len(diff) > max_diff_lines else ""
                notes.append(f"{rel} was modified outside of your tools (by the user, a formatter or a command). "
                             f"Diff since you last saw it:\n" + "\n".join(diff[:max_diff_lines]) + more)
            else:
                notes.append(f"{rel} was modified outside of your tools. Read it again before editing.")
            # 模型已经知道了变化：按新内容登记，避免下一轮重复提醒
            fs.remember(path, new, partial=rec.partial if rec else False)
        if not notes:
            return None
        return Attachment("file_change", f"{len(notes)} 个文件被外部修改", "\n\n".join(notes))

    return provide


def notifications_provider() -> Provider:
    """第 16–18 章（后台命令 / sub agent / 监听）往 agent.notifications 里放消息，这里统一送进上下文。"""

    def provide(st: InjectState) -> Attachment | None:
        items = st.agent.drain_notifications()
        if not items:
            return None
        return Attachment("notification", f"{len(items)} 条通知", "\n\n".join(items))

    return provide


# ---------------------------------------------------------------- 组装


@dataclass
class ContextBuilder:
    agent: "Agent"
    home: Path
    providers: list[Provider] = field(default_factory=list)
    # 额外的 system 段落（第 12 章记忆、第 20 章 skills 目录可以往这里加）。函数在会话开始时求值一次
    system_sections: list[Callable[[], str | None]] = field(default_factory=list)
    # 第 17 章：sub agent 用自己的身份说明替换掉主 agent 的 STATIC_PROMPT
    static_prompt: str = STATIC_PROMPT
    _system_cache: list[dict[str, Any]] | None = None

    @classmethod
    def default(cls, agent: "Agent", home: Path) -> "ContextBuilder":
        from .tasks import task_reminder_provider

        return cls(agent, home, providers=[
            instructions_provider(home), date_provider(), changed_files_provider(), notifications_provider(),
            task_reminder_provider(),
        ])

    def system_blocks(self) -> list[dict[str, Any]]:
        """会话内只算一次：任何一个字节变化都会让 prompt cache 失效，所以别在这里放时间戳。"""
        if self._system_cache is None:
            texts = [self.static_prompt, environment_text(self.agent.settings.cwd, self.agent.settings.model)]
            texts += [t for fn in self.system_sections if (t := fn())]
            blocks = [{"type": "text", "text": t} for t in texts]
            blocks[-1]["cache_control"] = {"type": "ephemeral"}
            self._system_cache = blocks
        return self._system_cache

    def invalidate(self) -> None:
        self._system_cache = None

    def collect(self, trigger: str) -> list[Attachment]:
        st = InjectState(self.agent, trigger)
        out = []
        for p in self.providers:
            try:
                a = p(st)
            except Exception:  # noqa: BLE001 —— 某个提供者坏了，不能连累整轮对话
                continue
            if a is not None:
                out.append(a)
        return out

    def inject(self, content: str | list[dict[str, Any]], trigger: str) -> tuple[list[dict[str, Any]] | str, list[Attachment]]:
        """把本轮要注入的附件并进即将追加的 user 消息。用户发话：放最前面；工具结果：放在 tool_result 之后。"""
        atts = self.collect(trigger)
        if not atts:
            return content, []
        blocks = [render(a) for a in atts]
        base = [{"type": "text", "text": content}] if isinstance(content, str) else list(content)
        merged = blocks + base if trigger == "user" else base + blocks
        return merged, atts
