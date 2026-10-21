"""终端渲染：把 agent 事件流画出来。

ConsoleUI 用 rich 实时打印；BufferUI 把同样的内容记成纯文本行，供测试和管道演示使用。
输出格式：❯ 用户输入 / ● 模型文本 / ✻ 思考 / ⏺ 工具调用 / ✔ 工具返回（✘ 表示出错）。
"""

from __future__ import annotations

import sys

from rich.console import Console

from .events import ContextInjected, Event, Notice, TasksUpdated, PermissionDecision, TextDelta, ThinkingDelta, ToolEnd, ToolStart, TurnEnd
from .permissions import PermissionReply, PermissionRequest
from .tools.ask_user import Answer, Question, parse_answer, render_question


def preview(content, max_lines: int = 3, width: int = 100) -> str:
    if isinstance(content, list):  # content block 列表（MCP 结果、图片）：文本拼起来，其余显示占位
        content = "\n".join(b["text"] if b.get("type") == "text" else f"[{b.get('type')}]" for b in content)
    text = content if isinstance(content, str) else "[non-text content]"
    lines = text.splitlines() or [""]
    head = [ln[:width] for ln in lines[:max_lines]]
    more = f"  …(+{len(lines) - max_lines} lines)" if len(lines) > max_lines else ""
    return "\n  ".join(head) + more


class BufferUI:
    def __init__(self, answers: list[str] | None = None) -> None:
        self.lines: list[str] = []
        self._stream_kind: str | None = None  # 正在流式输出的块：text / thinking
        # 交互问题的预置答案（测试用）。用完之后默认回答 "1"
        self.answers: list[str] = list(answers or [])

    # ---- 交互输入：BufferUI 从 answers 里取，ConsoleUI 读键盘
    def ask(self, prompt: str) -> str:
        ans = self.answers.pop(0) if self.answers else "1"
        self._emit(f"{prompt}{ans}")
        return ans

    def ask_permission(self, req: PermissionRequest) -> PermissionReply:
        self.info(f"是否允许 {req.summary}？（{req.reason}）")
        self._emit("  1. 允许")
        self._emit(f"  2. 允许，且本会话不再询问 {req.rule_key}")
        self._emit("  3. 拒绝（可以附一句话告诉模型该怎么做）")
        ans = self.ask("选择 [1/2/3]: ").strip()
        if ans.startswith("2"):
            return PermissionReply("always")
        if ans.startswith("3"):
            feedback = ans[1:].lstrip(":： ").strip() or self.ask("说明（可留空，回车跳过）: ").strip()
            return PermissionReply("deny", feedback)
        return PermissionReply("once")

    # ---- 基础输出
    def _emit(self, line: str) -> None:
        self.lines.append(line)

    def info(self, msg: str) -> None:
        self._end_stream()
        self._emit(msg)

    def error(self, msg: str) -> None:
        self._end_stream()
        self._emit(f"✗ {msg}")

    def assistant(self, text: str) -> None:
        self._end_stream()
        self._emit(f"● {text}")

    def table(self, rows: list[tuple[str, str]]) -> None:
        self._end_stream()
        w = max(len(k) for k, _ in rows)
        for k, v in rows:
            self._emit(f"{k.ljust(w)}  {v}")

    def ask_questions(self, questions: list[Question]) -> list[Answer]:
        """AskUserQuestion 的界面：逐题显示选项，读答案；输入无效就重问一次，再无效当作跳过。"""
        answers = []
        for n, q in enumerate(questions, 1):
            for line in render_question(q, n, len(questions)):
                self.info(line)
            ans = parse_answer(self.ask("› "), q)
            if ans is None:
                self.info("  输入无效，请输入选项序号或你自己的答案")
                ans = parse_answer(self.ask("› "), q) or Answer(q.question, skipped=True)
            answers.append(ans)
        return answers

    # ---- 流式片段
    def _start_stream(self, kind: str, prefix: str) -> None:
        if self._stream_kind != kind:
            self._end_stream()
            self._stream_kind = kind
            self.lines.append(prefix)

    def _write(self, piece: str) -> None:
        self.lines[-1] += piece

    def _end_stream(self) -> None:
        self._stream_kind = None

    # ---- 事件分发
    def render(self, ev: Event) -> None:
        if isinstance(ev, TextDelta):
            self._start_stream("text", "● ")
            self._write(ev.text)
        elif isinstance(ev, ThinkingDelta):
            self._start_stream("thinking", "✻ ")
            self._write(ev.text)
        elif isinstance(ev, ToolStart):
            self.info(f"⏺ {ev.summary}")
        elif isinstance(ev, ToolEnd):
            if ev.name in ("TaskCreate", "TaskUpdate") and not ev.result.is_error:
                return  # 清单本身会由 TasksUpdated 画出来，结果行就不重复了
            mark = "✘" if ev.result.is_error else "✔"
            self.info(f"{mark} {ev.name} -> {preview(ev.result.content)}")
        elif isinstance(ev, TasksUpdated):
            for line in ev.rendered.splitlines():
                self.info(f"  {line}")
        elif isinstance(ev, ContextInjected):
            self.info(f"◇ system  {ev.title}")
        elif isinstance(ev, PermissionDecision):
            if ev.source == "classifier":
                verb = "放行" if ev.behavior == "allow" else "拦截"
                self.info(f"  ⎿ auto 审查员{verb}：{ev.reason.removeprefix('auto reviewer blocked: ')}")
            elif ev.behavior == "deny" and ev.source != "user":
                self.info(f"  ⎿ 权限拒绝：{ev.reason}")
        elif isinstance(ev, Notice):
            (self.error if ev.level == "error" else self.info)(ev.text)
        elif isinstance(ev, TurnEnd):
            self._end_stream()

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


class ConsoleUI(BufferUI):
    """同样的状态机，只是把每次 _emit/_write 立刻打到终端；交互问题从键盘读。"""

    def __init__(self, console: Console | None = None) -> None:
        super().__init__()
        self.console = console or Console(highlight=False)

    def ask(self, prompt: str) -> str:
        self._end_stream()
        try:
            ans = input(prompt)
        except EOFError:
            ans = ""
        self.lines.append(f"{prompt}{ans}")
        if not sys.stdin.isatty():  # 管道演示：把读到的答案回显出来，记录才看得懂
            self.console.print(ans, markup=False)
        return ans

    def _emit(self, line: str) -> None:
        super()._emit(line)
        style = {"⏺": "green", "✔": "dim", "✘": "red", "✗": "bold red"}.get(line[:1], "")
        self.console.print(line, style=style, markup=False, soft_wrap=True)

    def _start_stream(self, kind: str, prefix: str) -> None:
        if self._stream_kind != kind:
            super()._start_stream(kind, prefix)
            self.console.print(prefix, end="", style="dim italic" if kind == "thinking" else "", markup=False)

    def _write(self, piece: str) -> None:
        super()._write(piece)
        style = "dim italic" if self._stream_kind == "thinking" else ""
        self.console.print(piece, end="", style=style, markup=False, soft_wrap=True)

    def _end_stream(self) -> None:
        if self._stream_kind is not None:
            self.console.print()
        super()._end_stream()
