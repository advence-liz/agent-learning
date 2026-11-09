"""补充章「工具设计」：量一量工具定义和工具结果占了多少上下文，以及带续取提示的截断。

estimate_tokens 只是粗估（ASCII 约 4 字符 1 token，中文等非 ASCII 约 1 字符 1 token），
用来比较两套工具集的量级。要精确数字，用 client.messages.count_tokens(...) 让接口自己数。
"""

from __future__ import annotations

import json
import math
from typing import Any


def estimate_tokens(text: str) -> int:
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    return math.ceil(ascii_chars / 4 + (len(text) - ascii_chars))


def dumps(obj: Any) -> str:
    """紧凑 JSON，和 Node 版 JSON.stringify 的输出逐字一致，字符数才能对得上。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def measure_tools(tools: list[dict[str, Any]]) -> dict[str, int]:
    """工具定义每次请求都会原样发给模型：名字、描述、schema 全算。"""
    s = dumps(tools)
    return {"chars": len(s), "tokens": estimate_tokens(s)}


def truncate_result(text: str, max_chars: int, how_to_continue: str) -> str:
    """把过长的工具结果截到 max_chars 以内（尽量按整行切），末尾告诉模型还剩多少、怎么拿剩下的。

    只截不提示，模型会以为自己看到的就是全部；提示里要给出能直接照做的下一步。
    """
    if len(text) <= max_chars:
        return text
    kept: list[str] = []
    used = 0
    for line in text.split("\n"):
        cost = len(line) + (1 if kept else 0)
        if used + cost > max_chars:
            break
        kept.append(line)
        used += cost
    shown = "\n".join(kept) if kept else text[:max_chars]  # 第一行就超长时只能硬切
    return (f"{shown}\n…[结果已截断：只显示了前 {len(shown)} / {len(text)} 字符，"
            f"还剩 {len(text) - len(shown)} 字符没给你看。{how_to_continue}]")
