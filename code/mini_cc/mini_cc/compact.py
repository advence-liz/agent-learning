"""上下文压缩（第 14 章）。

做法是 claude-api 文档推荐的「简单压缩」（simple compaction）：
1. 用**同一个** system、同一套工具、完整历史，再追加一条「请写摘要」的指令，请求模型一次（前缀能命中 prompt cache）；
2. 新历史只有一条 user 消息：摘要 + 程序重新挂回的东西（最近读过的文件、项目说明、任务清单……）；
3. 旧的 thinking 块、旧的轮次一律不带过去——它们绑定在旧对话上，带过去反而会让 API 拒绝（preserved thinking）。

手动 /compact 发生在两轮之间：之后用户的下一条消息会紧跟在摘要后面。API 要求 user/assistant 交替，
所以 Agent._request() 发请求前把相邻的 user 消息合并（merge_consecutive_users）。合并是历史的确定性函数，
每次请求得到的前缀逐字节相同，不破坏 prompt cache。
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any, Iterator

from .attachments import render
from .events import ContextInjected, Event, Notice
from .model import ModelError, complete

if TYPE_CHECKING:  # pragma: no cover
    from .loop import Agent

SUMMARY_HEADER = ("This session is being continued from a previous conversation that ran out of context. "
                  "The summary below covers the earlier portion of the conversation.")
CONTINUE = ("Continue from where you left off without asking the user further questions. "
            "Do not acknowledge or recap the summary; pick up the last task directly.")
SUMMARY_PROMPT = """Your context window is almost full. Write a summary of the conversation so far that lets a fresh
context window continue the work without redoing anything or asking the user again. Use these sections:

1. User requests: every request, constraint and preference the user stated, kept close to their own words.
2. Decisions: what was decided, ruled out or agreed, and why.
3. Files and code: files read or changed, with the key snippets or line references that matter.
4. Problems: errors hit and how they were fixed (or that they are still open).
5. Current state: exactly what has been done and what was in progress at the moment of this summary.
6. Next step: the immediate next action, if the task is not finished.

Keep exact names, paths, numbers and error messages. Condense your own explanations; never drop the user's words.
Put the whole summary inside <summary></summary> tags.
Do not call any tools while writing this summary; respond with text only."""

REATTACH_FILES = 5        # 压缩后重新挂回最近读过的几个文件（Claude Code 文档：最多 5 个）
REATTACH_LINES = 400      # 每个文件最多挂回多少行


def extract_summary(text: str) -> str:
    m = re.search(r"<summary>(.*?)</summary>", text, re.S)
    return (m.group(1) if m else text).strip()


def merge_consecutive_users(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """请求视图：相邻的 user 消息合并成一条（不修改传入的历史）。"""
    out: list[dict[str, Any]] = []
    for m in messages:
        if out and m["role"] == "user" and out[-1]["role"] == "user":
            prev = out[-1]
            out[-1] = {"role": "user", "content": _blocks(prev["content"]) + _blocks(m["content"])}
        else:
            out.append(m)
    return out


def _blocks(content: Any) -> list[dict[str, Any]]:
    return [{"type": "text", "text": content}] if isinstance(content, str) else list(content)


def estimate_tokens(obj: Any) -> int:
    """粗估（4 字符 ≈ 1 token）。只用于压缩后更新 last_input，避免下一次请求前又被判定为「快满了」。"""
    return len(json.dumps(obj, ensure_ascii=False)) // 4


def _reattach_files(agent: "Agent") -> list[dict[str, Any]]:
    """最近读过的文件重新放进上下文，文件状态表也只保留这几个：压缩后模型看不见的文件，就当没读过。"""
    from .mentions import _file_attachment

    fs = agent.ctx.file_state
    recent = [p for p in fs.paths() if p.is_file()][-REATTACH_FILES:]
    fs.clear()
    blocks = []
    for p in recent:
        att = _file_attachment(p, agent.ctx.rel(p), agent.ctx, REATTACH_LINES)
        if att:
            att.text = att.text.replace("The user mentioned", "Re-attached after compaction:", 1)
            blocks.append(render(att))
    return blocks


def compact(agent: "Agent", trigger: str = "manual", instructions: str = "") -> Iterator[Event]:
    """压缩当前历史。生成器：产出给 UI 的事件；失败时历史保持不变。"""
    pre = agent.usage.last_input or estimate_tokens(agent.messages)
    ask = SUMMARY_PROMPT + (f"\n\nAdditional instructions from the user for this summary:\n{instructions}"
                            if instructions else "")
    req = agent._request()
    history = merge_consecutive_users(agent.messages)
    if history and history[-1]["role"] == "user":
        # 自动压缩发生在工具结果之后：指令并进最后一条 user 消息，保持交替（只改请求副本）
        history = history[:-1] + [{"role": "user", "content": _blocks(history[-1]["content"]) + [
            {"type": "text", "text": ask}]}]
    else:
        history = history + [{"role": "user", "content": [{"type": "text", "text": ask}]}]
    req.messages = history
    yield Notice(f"{'自动' if trigger == 'auto' else ''}压缩上下文中（当前约 {pre} tokens）…")
    try:
        done = complete(agent.client, req)
    except ModelError as e:
        yield Notice(f"压缩失败：{e}；历史保持不变", "warn")
        return
    agent.usage.add(done.usage)
    summary = extract_summary("".join(b.get("text", "") for b in done.content if b["type"] == "text"))
    if not summary:
        yield Notice("压缩失败：模型没有给出摘要；历史保持不变", "warn")
        return

    text = f"{SUMMARY_HEADER}\n\n{summary}" + (f"\n\n{CONTINUE}" if trigger == "auto" else "")
    blocks = [{"type": "text", "text": text}] + _reattach_files(agent)
    agent.load_history([], agent.usage)
    # 用 "user" 触发 providers：历史空了，项目说明 / 日期 / 任务清单会自动重新注入
    merged, atts = agent.context.inject(blocks, "user")
    for a in atts:
        yield ContextInjected(a.kind, a.title)
    msg = {"role": "user", "content": merged}
    post = estimate_tokens(msg)
    agent._append(msg, compact={"trigger": trigger, "preTokens": pre, "postTokens": post})
    agent.usage.last_input = post
    yield Notice(f"已压缩：{pre} → 约 {post} tokens（摘要 {len(summary)} 字符，挂回 {len(blocks) - 1} 个文件）")


def auto_compact_hook(agent: "Agent") -> list[Event]:
    """挂在 Agent.before_request：上一次请求的输入已经逼近窗口，就先压缩再请求。"""
    s = agent.settings
    if not s.auto_compact or agent.usage.last_input < s.context_window - s.auto_compact_buffer:
        return []
    if not agent.messages or agent.messages[-1]["role"] != "user":
        return []  # 只在「即将请求」的位置压缩；悬空的 tool_use 不能拆开
    return list(compact(agent, "auto"))
