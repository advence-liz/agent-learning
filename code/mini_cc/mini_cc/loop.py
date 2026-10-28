"""Agent 循环：请求模型 → 有 tool_use 就执行 → 把结果塞回去 → 再请求，直到模型不再调工具。

第 2 章起，循环是一个生成器：每发生一件事就 yield 一个事件，调用方（UI）边收边画。
"""

from __future__ import annotations

import queue
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .config import Settings
from .events import ContextInjected, Event, Notice, PermissionDecision, TasksUpdated, ToolEnd, ToolStart, TurnEnd
from .model import MessageDone, ModelClient, ModelError, ModelRequest, TextDelta, ThinkingDelta
from .permissions import PermissionManager, PermissionReply, PermissionRequest, denied_message
from .retry import RetryPolicy
from .tools import ToolContext, ToolRegistry, ToolResult

SYSTEM_PROMPT = (
    "You are mini-cc, a coding agent running in the user's terminal. "
    "Use the tools to inspect and change the project. Be concise."
)


@dataclass
class Usage:
    """累计 token 用量；last_input 是最近一次请求的输入规模 ≈ 当前上下文大小。"""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    last_input: int = 0
    requests: int = 0

    def add(self, u: dict[str, int]) -> None:
        self.requests += 1
        for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            setattr(self, k, getattr(self, k) + int(u.get(k) or 0))
        self.last_input = sum(
            int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
        )


@dataclass
class TurnResult:
    text: str
    events: list[Event] = field(default_factory=list)

    @property
    def steps(self) -> list[str]:
        return [e.summary for e in self.events if isinstance(e, ToolStart)]


class Agent:
    def __init__(self, client: ModelClient, tools: ToolRegistry, settings: Settings):
        self.client = client
        self.tools = tools
        self.settings = settings
        self.messages: list[dict[str, Any]] = []
        self.usage = Usage()
        self.ctx = ToolContext(cwd=settings.cwd)
        self.retry = RetryPolicy(settings.max_retries, settings.retry_base_delay, settings.retry_max_delay)
        self.sleep: Callable[[float], None] = time.sleep  # 测试里换成记录器，不真睡
        # 每往历史里追加一条消息就通知一遍（第 4 章：落盘；第 13 章 rewind 也会订阅）
        self.listeners: list[Callable[[dict[str, Any], dict[str, Any]], None]] = []
        # 第 5 章：权限。approver 由 UI 提供（弹窗问用户）；没有 approver（比如 -p 模式）时一律拒绝
        self.permissions = PermissionManager(settings.cwd)
        self.approver: Callable[[PermissionRequest], PermissionReply] | None = None
        # 第 9 章：上下文组装与注入；notifications 是线程安全的「待送达消息」队列（第 16–18 章往里放）
        from .context import ContextBuilder

        self.context = ContextBuilder.default(self, settings.home)
        self.notifications: queue.Queue[str] = queue.Queue()
        # 给后续章节的生命周期钩子（返回要转发给 UI 的事件列表，或 None）：
        #   before_request：每次请求模型之前（第 14 章自动压缩：上下文快满时先压缩再请求）
        #   turn_end：一轮结束时（第 12 章记忆提取、第 13 章 rewind 打检查点）
        self.before_request: list[Callable[["Agent"], list[Event] | None]] = []
        self.turn_end: list[Callable[["Agent", TurnEnd], list[Event] | None]] = []

    def notify(self, text: str) -> None:
        """任何线程都可以调用：消息会在下一次 user 消息（用户发话或工具结果）里送达模型。"""
        self.notifications.put(text)

    def drain_notifications(self) -> list[str]:
        items = []
        while True:
            try:
                items.append(self.notifications.get_nowait())
            except queue.Empty:
                return items

    def _append_user(self, content: Any, trigger: str) -> Iterator[Event]:
        """追加一条 user 消息，顺带把本轮该注入的上下文并进去。"""
        merged, atts = self.context.inject(content, trigger)
        for a in atts:
            yield ContextInjected(a.kind, a.title)
        self._append({"role": "user", "content": merged})

    def _append(self, msg: dict[str, Any], **meta: Any) -> None:
        """历史的唯一写入口。只追加、不修改——这条规矩让持久化、prompt cache、thinking 校验都简单。"""
        self.messages.append(msg)
        for fn in self.listeners:
            fn(msg, meta)

    def load_history(self, messages: list[dict[str, Any]], usage: "Usage | None" = None) -> None:
        """恢复会话：直接换掉历史（不触发 listeners，因为这些消息已经在磁盘上了）。"""
        self.messages = list(messages)
        self.usage = usage or Usage()
        self.repair_history()

    def reset(self) -> None:
        self.messages = []
        self.usage = Usage()

    def _request(self) -> ModelRequest:
        from .compact import merge_consecutive_users

        return ModelRequest(
            system=self.context.system_blocks(),
            # 第 14 章：压缩后「摘要 + 下一条提示词」是两条相邻的 user 消息，请求时合并（不改历史）
            messages=merge_consecutive_users(self.messages),
            tools=self.tools.schemas(),
            max_tokens=self.settings.max_tokens,
            output_config={"effort": self.settings.effort},
            thinking={"type": "adaptive", "display": "summarized"},
            cache=True,
        )

    # ------------------------------------------------------------ 一次模型调用

    def _call_model(self) -> Iterator[Event | MessageDone]:
        """流式调用模型，带重试。增量原样往外转发，最后交出 MessageDone。

        重试是安全的，因为历史只在 MessageDone 之后才写入：失败那次流出去的半截文字只上了屏幕，
        没有进 self.messages。
        """
        attempt = 0
        while True:
            streamed = False
            try:
                for ev in self.client.stream(self._request()):
                    if not isinstance(ev, MessageDone):
                        streamed = True
                    yield ev
                return
            except ModelError as err:
                attempt += 1
                if not self.retry.should_retry(attempt, err):
                    raise
                delay = self.retry.delay(attempt, err)
                cut = "（上面的输出不完整，已丢弃）" if streamed else ""
                yield Notice(f"{cut}模型请求失败：{err}；{delay:.1f}s 后第 {attempt}/{self.retry.max_retries} 次重试", "warn")
                self.sleep(delay)

    # ------------------------------------------------------------ 执行工具

    def _authorize(self, tu: dict[str, Any]) -> Iterator[Event]:
        """权限关卡。生成器的返回值是 (是否放行, 拒绝时给模型的结果, 是否结束本轮)。"""
        tool = self.tools.get(tu["name"])
        d = self.permissions.decide(tool, tu["input"])
        summary = tool.summary(tu["input"])
        if d.behavior == "allow":
            if d.source == "classifier":
                yield PermissionDecision(tu["id"], summary, "allow", d.reason, d.source)
            return True, None, False
        if d.behavior == "deny":
            yield PermissionDecision(tu["id"], summary, "deny", d.reason, d.source)
            return False, ToolResult(f"Permission denied: {d.reason}. This call was NOT executed.", True), False
        # ask：停下来问用户（生成器在这里同步等待 approver 返回）
        req = PermissionRequest(tool, tu["input"], summary, tool.rule_key(tu["input"]), d.reason)
        reply = self.approver(req) if self.approver else PermissionReply("deny", "")
        if reply.choice in ("once", "always"):
            if reply.choice == "always":
                self.permissions.remember(req)
            yield PermissionDecision(tu["id"], summary, "allow", f"user approved ({reply.choice})", "user")
            return True, None, False
        yield PermissionDecision(tu["id"], summary, "deny", "user rejected", "user")
        # 没给理由的拒绝 = 「先停下，等我说」；给了理由就让模型带着理由继续
        return False, ToolResult(denied_message(reply.feedback), True), not reply.feedback

    def _run_tools(self, tool_uses: list[dict[str, Any]]) -> Iterator[Event]:
        """执行一批工具调用。生成器返回 True 表示本轮应当结束（用户拒绝且没给理由）。"""
        results = []
        stop = False
        last_tasks: TasksUpdated | None = None
        for tu in tool_uses:
            tool = self.tools.get(tu["name"])
            yield ToolStart(tu["id"], tu["name"], tu["input"], tool.summary(tu["input"]) if tool else tu["name"])
            bad = self.tools.check_input(tu["name"], tu["input"])
            if bad is not None:
                r = bad
            elif stop:
                r = ToolResult("Skipped: an earlier tool call in this batch was rejected by the user.", True)
            else:
                ok, r, stop_now = yield from self._authorize(tu)
                stop = stop or stop_now
                if ok:
                    self.ctx.tool_use_id = tu["id"]
                    r = self.tools.execute(tu["name"], tu["input"], self.ctx, self.settings.max_tool_output)
            yield ToolEnd(tu["id"], tu["name"], r)
            while self.ctx.pending_events:  # 工具执行期间攒下的事件
                ev = self.ctx.pending_events.pop(0)
                if isinstance(ev, TasksUpdated):
                    last_tasks = ev  # 一批里多次改清单，只在批末显示最终状态
                else:
                    yield ev
            results.append({"type": "tool_result", "tool_use_id": tu["id"], "content": r.content, "is_error": r.is_error})
        if last_tasks is not None:
            yield last_tasks
        # 第 20 章：tool_result 必须排在 user 消息最前面，工具追加的文本（skill 正文）放在全部结果之后
        results += self.ctx.followup_blocks
        self.ctx.followup_blocks = []
        # 同一条 assistant 里的多个 tool_use，结果必须放进同一条 user 消息（注入的提醒排在 tool_result 之后）
        yield from self._append_user(results, "tool_result")
        return stop

    # ------------------------------------------------------------ 一轮对话

    def run_turn(self, prompt: str | list[dict[str, Any]]) -> Iterator[Event]:
        """主循环 + 最后一道安全网：无论里面出什么事，这个生成器都不会抛异常，历史也保持合法。"""
        try:
            yield from self._append_user(prompt, "user")
            yield from self._loop()
        except ModelError as err:
            yield Notice(f"模型请求失败（{err.kind}）：{err}", "error")
            yield TurnEnd("error", "")
        except Exception as err:  # noqa: BLE001 —— 安全网：未知异常也不能让 REPL 退出
            yield Notice(f"内部错误：{type(err).__name__}: {err}", "error")
            yield TurnEnd("error", "")
        finally:
            # 包括 Ctrl+C 导致的 GeneratorExit / KeyboardInterrupt：补齐悬空的 tool_use
            self.repair_history()

    def _hooks(self, hooks: list[Callable[..., list[Event] | None]], *args: Any) -> Iterator[Event]:
        for fn in hooks:
            yield from fn(self, *args) or []

    def _loop(self) -> Iterator[Event]:
        for end in self._steps():
            if isinstance(end, TurnEnd):
                yield from self._hooks(self.turn_end, end)
            yield end

    def _steps(self) -> Iterator[Event]:
        for _ in range(self.settings.max_iterations):
            yield from self._hooks(self.before_request)
            done: MessageDone | None = None
            for ev in self._call_model():
                if isinstance(ev, MessageDone):
                    done = ev
                else:
                    yield ev
            assert done is not None
            self.usage.add(done.usage)
            # 整个 content 原样存回历史（thinking 块要原样回传，不能只留文本）
            self._append({"role": "assistant", "content": done.content}, usage=done.usage)
            tool_uses = [b for b in done.content if b["type"] == "tool_use"]
            text = "".join(b["text"] for b in done.content if b["type"] == "text")

            if done.stop_reason == "refusal":
                yield Notice("模型拒绝了这个请求（stop_reason=refusal）", "error")
                yield TurnEnd("refusal", text)
                return
            if done.stop_reason == "max_tokens" and tool_uses:
                # 参数被截断的工具调用绝不能执行；告诉模型原因，让它分小块重来
                yield Notice("输出触到 max_tokens，工具参数可能被截断，已跳过执行", "warn")
                self._append_error_results(tool_uses, "Output hit max_tokens; this tool input may be truncated "
                                                      "and was NOT executed. Retry with smaller pieces.")
                continue
            if done.stop_reason == "pause_turn":
                continue  # 服务端工具（web search 等）跑太久时会暂停，原样续上即可
            if done.stop_reason != "tool_use" or not tool_uses:
                yield TurnEnd(done.stop_reason, text)
                return
            if (yield from self._run_tools(tool_uses)):
                yield TurnEnd("denied", "")
                return
        yield Notice(f"达到单轮上限 {self.settings.max_iterations} 次模型调用，已停止", "warn")
        yield TurnEnd("max_iterations", "")

    # ------------------------------------------------------------ 历史一致性

    def _append_error_results(self, tool_uses: list[dict[str, Any]], msg: str) -> None:
        self._append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tu["id"], "content": msg, "is_error": True} for tu in tool_uses
        ]})

    def repair_history(self) -> None:
        """API 要求每个 tool_use 后面紧跟对应的 tool_result。被打断时补上，否则下一次请求必然 400。"""
        if not self.messages:
            return
        last = self.messages[-1]
        if last["role"] != "assistant" or not isinstance(last["content"], list):
            return
        pending = [b for b in last["content"] if b.get("type") == "tool_use"]
        if pending:
            self._append_error_results(pending, "Interrupted by user before this tool finished.")

    def run(self, prompt: str) -> TurnResult:
        """不需要实时输出时的便捷封装：把事件攒起来一次返回。"""
        events = list(self.run_turn(prompt))
        end = events[-1]
        return TurnResult(end.text if isinstance(end, TurnEnd) else "", events)


__all__ = ["Agent", "TurnResult", "Usage", "SYSTEM_PROMPT", "TextDelta", "ThinkingDelta"]
