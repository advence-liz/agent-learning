"""模型层：把「调 LLM」收敛成一个很窄的接口，让 agent 循环不认识 anthropic SDK。

- ModelRequest：循环发给模型的全部数据，content 一律是纯 dict（能直接 json.dumps 落盘，也能原样回传 API）。
- ModelClient.stream()：产出 TextDelta / ThinkingDelta，最后一定产出一个 MessageDone。
- complete()：不关心中间过程时（auto 模式的审查员、第 14 章的压缩）用它一次拿到结果。
- AnthropicClient 走真实 API；FakeClient 按脚本回放，测试和 --fake 演示都用它。
"""

from __future__ import annotations

import copy
import itertools
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Protocol

Block = dict[str, Any]


@dataclass
class ModelRequest:
    system: list[Block]
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] = field(default_factory=list)
    max_tokens: int = 64000
    # 透传给 API 的 output_config（effort / 结构化输出 format）
    output_config: dict[str, Any] | None = None
    # None = 不传；默认 adaptive + summarized，让终端能看到思考摘要
    thinking: dict[str, Any] | None = None
    # 第 9 章：顶层自动缓存——缓存到最后一个可缓存块（agent 循环里历史只增不改，前缀几乎总能命中）
    cache: bool = False


# ---------------------------------------------------------------- 流式事件


@dataclass
class TextDelta:
    text: str


@dataclass
class ThinkingDelta:
    text: str


@dataclass
class MessageDone:
    content: list[Block]
    stop_reason: str
    usage: dict[str, int] = field(default_factory=dict)


ModelEvent = TextDelta | ThinkingDelta | MessageDone
# 兼容第 1 章的名字
ModelResponse = MessageDone


class ModelError(Exception):
    """模型调用失败。retryable 决定循环要不要重试；kind 给人看，也给测试断言。"""

    def __init__(self, message: str, *, retryable: bool, kind: str = "api", status: int | None = None,
                 retry_after: float | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.kind = kind
        self.status = status
        self.retry_after = retry_after


def to_model_error(e: Exception) -> ModelError:
    """把 SDK 异常翻译成 ModelError。顺序从具体到宽泛：先判状态码，再判网络错误。"""
    import anthropic

    if isinstance(e, ModelError):
        return e
    if isinstance(e, anthropic.APIStatusError):
        status = e.status_code
        ra = e.response.headers.get("retry-after") if e.response is not None else None
        retry_after = float(ra) if ra and ra.replace(".", "", 1).isdigit() else None
        # 408 超时 / 409 冲突 / 429 限流 / 5xx（含 529 overloaded）可以重试；其余 4xx 重试也没用
        retryable = status in (408, 409, 429) or status >= 500
        kind = {401: "auth", 403: "permission", 404: "not_found", 413: "too_large", 429: "rate_limit",
                529: "overloaded"}.get(status, "server" if status >= 500 else "bad_request")
        return ModelError(f"{status} {e.message}", retryable=retryable, kind=kind, status=status, retry_after=retry_after)
    if isinstance(e, (anthropic.APITimeoutError, anthropic.APIConnectionError)):
        return ModelError(f"network: {e}", retryable=True, kind="network")
    if isinstance(e, ValueError):
        # eager_input_streaming 下 SDK 解析不了工具参数 JSON 时，从流迭代器里抛 ValueError：重发这一轮
        return ModelError(f"invalid tool input json: {e}", retryable=True, kind="invalid_json")
    return ModelError(f"{type(e).__name__}: {e}", retryable=False, kind="unknown")


class ModelClient(Protocol):
    model: str

    def stream(self, req: ModelRequest) -> Iterator[ModelEvent]: ...


def complete(client: ModelClient, req: ModelRequest) -> MessageDone:
    """把流消费完，只要最终消息。"""
    done: MessageDone | None = None
    for ev in client.stream(req):
        if isinstance(ev, MessageDone):
            done = ev
    if done is None:
        raise RuntimeError("model stream ended without a final message")
    return done


# ---------------------------------------------------------------- 真实客户端


class AnthropicClient:
    """直接用 anthropic SDK。ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 由 SDK 自己读环境变量。"""

    FALLBACK_BETA = "server-side-fallback-2026-07-01"

    def __init__(self, model: str, sdk_client: Any | None = None, fallbacks: bool = True):
        import anthropic

        self.model = model
        # max_retries=0：重试由 agent 循环自己做（第 3 章），这样每次重试 UI 都看得见
        self._sdk = sdk_client or anthropic.Anthropic(max_retries=0)
        # 服务端 fallback：模型因安全分类器拒答（stop_reason=refusal）时，API 在同一次调用里换模型重跑。
        # 走中转站不支持这个 beta 时，设 MINI_CC_FALLBACKS=0 关掉
        self.fallbacks = fallbacks

    def _kwargs(self, req: ModelRequest) -> dict[str, Any]:
        kwargs: dict[str, Any] = dict(
            model=self.model, max_tokens=req.max_tokens, system=req.system, messages=req.messages
        )
        if req.tools:
            # eager_input_streaming：工具参数（比如 Write 的整份文件内容）边生成边流过来，
            # 代价是服务端不再校验参数 → 第 3 章在执行前自己校验
            kwargs["tools"] = [{**t, "eager_input_streaming": True} for t in req.tools]
        if req.output_config:
            kwargs["output_config"] = req.output_config
        if req.thinking:
            kwargs["thinking"] = req.thinking
        if req.cache:
            kwargs["cache_control"] = {"type": "ephemeral"}
        return kwargs

    def stream(self, req: ModelRequest) -> Iterator[ModelEvent]:
        kwargs = self._kwargs(req)
        if self.fallbacks:
            opener = lambda: self._sdk.beta.messages.stream(  # noqa: E731
                **kwargs, betas=[self.FALLBACK_BETA], fallbacks="default")
        else:
            opener = lambda: self._sdk.messages.stream(**kwargs)  # noqa: E731
        try:
            with opener() as s:
                for ev in s:
                    if ev.type == "text":
                        yield TextDelta(ev.text)
                    elif ev.type == "thinking":
                        yield ThinkingDelta(ev.thinking)
                final = s.get_final_message()
        except Exception as e:  # noqa: BLE001 —— 统一翻译，由循环决定重试与否
            raise to_model_error(e) from e
        yield MessageDone(
            content=[b.to_dict() for b in final.content],
            stop_reason=final.stop_reason,
            usage=final.usage.to_dict(),
        )


# ---------------------------------------------------------------- 测试替身

_ids = itertools.count(1)


def text_block(text: str) -> Block:
    return {"type": "text", "text": text}


def tool_block(name: str, input: dict[str, Any], id: str | None = None) -> Block:
    return {"type": "tool_use", "id": id or f"toolu_fake_{next(_ids):03d}", "name": name, "input": input}


@dataclass
class FakeTurn:
    """FakeClient 的一步脚本：模型这一次「会」回什么。"""

    content: list[Block]
    stop_reason: str | None = None  # None → 有 tool_use 就是 tool_use，否则 end_turn
    usage: dict[str, int] = field(default_factory=lambda: {"input_tokens": 100, "output_tokens": 20})
    # 流到第几个字符时抛出 fail_with（模拟网络中途断开），None 表示不出错
    fail_after: int | None = None
    fail_with: Exception | None = None

    def resolved_stop_reason(self) -> str:
        if self.stop_reason:
            return self.stop_reason
        return "tool_use" if any(b["type"] == "tool_use" for b in self.content) else "end_turn"


def say(text: str, thinking: str | None = None) -> FakeTurn:
    blocks = [{"type": "thinking", "thinking": thinking, "signature": "fake-sig"}] if thinking else []
    return FakeTurn(blocks + [text_block(text)])


def call(name: str, input: dict[str, Any], text: str | None = None, id: str | None = None) -> FakeTurn:
    blocks = [text_block(text)] if text else []
    return FakeTurn(blocks + [tool_block(name, input, id)])


def calls(*pairs: tuple[str, dict[str, Any]], text: str | None = None) -> FakeTurn:
    """一次回复里并行调多个工具。"""
    blocks = [text_block(text)] if text else []
    return FakeTurn(blocks + [tool_block(n, i) for n, i in pairs])


Script = FakeTurn | Exception | Callable[[ModelRequest], "FakeTurn"]


class FakeClient:
    """按脚本回放的模型。每次 stream() 弹出一步；同时把收到的请求存进 self.requests 供断言。"""

    CHUNK = 4  # 每个文本增量的字符数，模拟 token 一点点流出来

    def __init__(self, script: list[Script] | None = None, model: str = "fake-model",
                 responder: Callable[[ModelRequest], FakeTurn] | None = None):
        self.script: list[Script] = list(script or [])
        # 剧本放完之后，如果有 responder 就一直用它回答（比如 auto 模式的假审查员）
        self.responder = responder
        self.requests: list[ModelRequest] = []
        self.model = model

    def push(self, *turns: Script) -> None:
        self.script.extend(turns)

    @classmethod
    def from_json(cls, path: str) -> "FakeClient":
        """离线演示用：从 JSON 读脚本。每项是 {"say": 文本, "thinking": 可选} 或 {"call": 工具名, "input": {...}, "text": 可选}。"""
        import json

        data = json.loads(open(path, encoding="utf-8").read())
        if isinstance(data, dict):
            # 第 17 章：{"main": [...], "agents": {"<description>": [...]}}：sub agent 各用各的剧本
            client = cls._from_items(data["main"])
            client.agent_clients = {k: cls._from_items(v) for k, v in data.get("agents", {}).items()}
            return client
        return cls._from_items(data)

    @classmethod
    def _from_items(cls, items: list[dict[str, Any]]) -> "FakeClient":
        turns: list[Script] = []
        for item in items:
            if "error" in item:  # {"error": "overloaded"} / {"error": "auth"}：模拟 API 失败
                k = item["error"]
                turns.append(ModelError(item.get("message", k), retryable=k in ("overloaded", "rate_limit", "network"), kind=k))
            elif "calls" in item:
                turns.append(calls(*[(c["call"], c.get("input", {})) for c in item["calls"]], text=item.get("text")))
            elif "call" in item:
                turns.append(call(item["call"], item.get("input", {}), item.get("text")))
            else:
                turns.append(say(item["say"], item.get("thinking")))
            if "usage" in item and isinstance(turns[-1], FakeTurn):
                turns[-1].usage = {"output_tokens": 20, **item["usage"]}  # 第 14 章：演示「上下文快满了」
        return cls(turns)

    def _next(self, req: ModelRequest) -> FakeTurn:
        self.requests.append(copy.deepcopy(req))
        if not self.script:
            if self.responder:
                return self.responder(req)
            raise AssertionError("FakeClient: 脚本已经放完了，但循环还在请求模型")
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        if callable(step) and not isinstance(step, FakeTurn):
            step = step(req)
        return step

    def stream(self, req: ModelRequest) -> Iterator[ModelEvent]:
        turn = self._next(req)
        sent = 0
        for b in turn.content:
            key, cls = {"text": ("text", TextDelta), "thinking": ("thinking", ThinkingDelta)}.get(b["type"], (None, None))
            if key is None:
                continue
            s = b[key]
            for i in range(0, len(s), self.CHUNK):
                if turn.fail_after is not None and sent >= turn.fail_after:
                    raise turn.fail_with or RuntimeError("fake stream failure")
                piece = s[i : i + self.CHUNK]
                sent += len(piece)
                yield cls(piece)
        if turn.fail_after is not None and sent >= turn.fail_after:
            raise turn.fail_with or RuntimeError("fake stream failure")
        yield MessageDone(copy.deepcopy(turn.content), turn.resolved_stop_reason(), dict(turn.usage))
