"""离线 fake 模型：按脚本返回预设响应，形状与 anthropic SDK 的真实 Message 完全一致。

用法：
    client = FakeAnthropic([text("你好"), tool_use("read_file", {"path": "a.py"})])
    client.messages.create(model=..., messages=[...])   # 依次弹出脚本里的响应

每次调用的入参都记在 client.calls 里，测试可以断言「模型这一轮到底看到了什么」。
真实环境下把 FakeAnthropic 换成 anthropic.Anthropic() 即可，业务代码一行不改。
"""

from __future__ import annotations

import copy
import itertools
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from anthropic.types import Message

_ids = itertools.count(1)


def _usage(input_tokens: int, output_tokens: int) -> dict[str, int]:
    return {"input_tokens": input_tokens, "output_tokens": output_tokens}


def text(s: str, *, input_tokens: int = 50, output_tokens: int = 20) -> dict[str, Any]:
    """一条纯文本回复（stop_reason=end_turn）。"""
    return {
        "content": [{"type": "text", "text": s}],
        "stop_reason": "end_turn",
        "usage": _usage(input_tokens, output_tokens),
    }


def tool_use(
    name: str,
    args: dict[str, Any],
    *,
    say: str | None = None,
    input_tokens: int = 50,
    output_tokens: int = 30,
) -> dict[str, Any]:
    """一条工具调用回复（stop_reason=tool_use），可选先说一句话。"""
    blocks: list[dict[str, Any]] = []
    if say:
        blocks.append({"type": "text", "text": say})
    blocks.append({"type": "tool_use", "id": f"toolu_{next(_ids):04d}", "name": name, "input": args})
    return {"content": blocks, "stop_reason": "tool_use", "usage": _usage(input_tokens, output_tokens)}


Script = list[dict[str, Any] | Callable[[dict[str, Any]], dict[str, Any]]]


@dataclass
class _Messages:
    owner: "FakeAnthropic"

    def create(self, **kwargs: Any) -> Message:
        o = self.owner
        # 深拷贝：调用方之后再 append messages，不影响我们记录的「当时那一刻」
        o.calls.append(copy.deepcopy(_jsonable(kwargs)))
        if not o.script:
            raise RuntimeError("FakeAnthropic: 脚本已用完，agent 多调用了一次模型")
        step = o.script.pop(0)
        if o.latency:
            time.sleep(o.latency)  # 模拟网络+推理耗时，给可观测性章节用
        if callable(step):  # 允许根据请求动态决定响应
            step = step(kwargs)
        return Message.model_validate(
            {
                "id": f"msg_fake_{len(o.calls):03d}",
                "type": "message",
                "role": "assistant",
                "model": kwargs.get("model", "claude-opus-5-5"),
                "stop_sequence": None,
                **step,
            }
        )


@dataclass
class FakeAnthropic:
    script: Script
    calls: list[dict[str, Any]] = field(default_factory=list)
    latency: float = 0.0

    def __post_init__(self) -> None:
        self.script = list(self.script)
        self.messages = _Messages(self)


def _jsonable(obj: Any) -> Any:
    """把 SDK 的 pydantic block 转成 dict，便于记录与断言。"""
    if hasattr(obj, "model_dump"):
        return obj.model_dump(exclude_none=True)
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    return obj


def make_client(script: Script | None = None):
    """有 script 就返回 fake；否则返回真实 client（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。"""
    if script is not None:
        return FakeAnthropic(script)
    import anthropic

    return anthropic.Anthropic()  # base_url 默认读 ANTHROPIC_BASE_URL 环境变量
