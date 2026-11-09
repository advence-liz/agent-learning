"""补充章「成本控制与模型路由」：按 usage 记账的 CostMeter + 预算。

一次响应的钱 = 四种 token 各乘各的单价：
    input_tokens                 × 输入价
    cache_creation_input_tokens  × 输入价 × 1.25（5 分钟 TTL）或 × 2（1 小时 TTL）
    cache_read_input_tokens      × 缓存读价（多数模型 0.1× 输入价，Opus 5.5 / Sonnet 5.5 是 0.05×）
    output_tokens                × 输出价（思考 token 也按输出计）
走 Batch API 时以上全部再打五折。

只做计算，不发请求：python -m cost_routing.ledger / cost_routing.router 里有演示。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# 价格表（美元 / 百万 token，第一方 API 标价）
# 来源：官方定价页 https://platform.claude.com/docs/en/about-claude/pricing（2026-11-09 查）。
#   合作方渠道（Bedrock / Vertex）另计价。
# cache_read：Opus 5.5、Sonnet 5.5 是输入价的 0.05×（$0.20、$0.10），Haiku 5.5 是 0.1×（$0.01）。
#   注意 claude-api skill 的模型表（cached: 2026-10-06）把 Sonnet 5.5 写成 $0.20，以定价页为准。
# Haiku 5.5 的 $0.10 / $0.50 / 读 $0.01 只适用于 ≤100K token 的提示，超过后是 $0.50 / $2.50 / 读 $0.05。
# ---------------------------------------------------------------------------
PRICES_AS_OF = "2026-11-09"


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    cache_read: float
    long_threshold: int | None = None  # 提示（三种输入之和）超过这个数就换成下面的长上下文价
    long_input: float = 0.0
    long_output: float = 0.0
    long_cache_read: float = 0.0


PRICES: dict[str, Price] = {
    "claude-opus-5-5": Price(input=4.00, output=20.00, cache_read=0.20),
    "claude-sonnet-5-5": Price(input=2.00, output=10.00, cache_read=0.10),
    "claude-haiku-5-5": Price(input=0.10, output=0.50, cache_read=0.01,
                              long_threshold=100_000, long_input=0.50, long_output=2.50, long_cache_read=0.05),
}
CACHE_WRITE_5M = 1.25  # 5 分钟 TTL 写入 = 1.25× 输入价
CACHE_WRITE_1H = 2.0   # 1 小时 TTL 写入 = 2× 输入价
BATCH_DISCOUNT = 0.5   # Batch API：所有 token（含缓存读写）五折


@dataclass(frozen=True)
class Tokens:
    input: int = 0
    write_5m: int = 0
    write_1h: int = 0
    cache_read: int = 0
    output: int = 0

    @property
    def prompt(self) -> int:
        """模型实际读到的输入总量：三项相加（input_tokens 只是最后一个断点之后的尾巴）。"""
        return self.input + self.write_5m + self.write_1h + self.cache_read


def _get(u: Any, key: str) -> Any:
    return u.get(key) if isinstance(u, dict) else getattr(u, key, None)


def normalize_usage(u: Any) -> Tokens:
    """吃 SDK 的 Usage 对象或 dict。没有 TTL 拆分（cache_creation）时，写入一律按 5 分钟算。"""
    created = _get(u, "cache_creation_input_tokens") or 0
    split = _get(u, "cache_creation")
    w5 = (_get(split, "ephemeral_5m_input_tokens") or 0) if split else created
    w1 = (_get(split, "ephemeral_1h_input_tokens") or 0) if split else 0
    return Tokens(
        input=_get(u, "input_tokens") or 0,
        write_5m=w5,
        write_1h=w1,
        cache_read=_get(u, "cache_read_input_tokens") or 0,
        output=_get(u, "output_tokens") or 0,
    )


def cost_usd(model: str, usage: Any, *, batch: bool = False) -> float:
    if model not in PRICES:
        raise KeyError(f"价格表里没有 {model}：宁可报错，也别按 0 元记账")
    p = PRICES[model]
    t = usage if isinstance(usage, Tokens) else normalize_usage(usage)
    long = p.long_threshold is not None and t.prompt > p.long_threshold
    inp, out, read = (p.long_input, p.long_output, p.long_cache_read) if long else (p.input, p.output, p.cache_read)
    usd = (
        t.input * inp
        + t.write_5m * inp * CACHE_WRITE_5M
        + t.write_1h * inp * CACHE_WRITE_1H
        + t.cache_read * read
        + t.output * out
    ) / 1_000_000
    return usd * BATCH_DISCOUNT if batch else usd


@dataclass
class Record:
    model: str
    tenant: str
    tokens: Tokens
    usd: float


@dataclass
class CostMeter:
    """每次响应调一次 add()。按模型、按租户（用户 / 团队）汇总。"""

    records: list[Record] = field(default_factory=list)

    def add(self, model: str, usage: Any, *, tenant: str = "default", batch: bool = False) -> float:
        tokens = normalize_usage(usage) if not isinstance(usage, Tokens) else usage
        usd = cost_usd(model, tokens, batch=batch)
        self.records.append(Record(model, tenant, tokens, usd))
        return usd

    def spent(self, tenant: str | None = None) -> float:
        return sum(r.usd for r in self.records if tenant is None or r.tenant == tenant)

    def by(self, key: str) -> dict[str, float]:
        out: dict[str, float] = {}
        for r in self.records:
            k = getattr(r, key)
            out[k] = out.get(k, 0.0) + r.usd
        return out


@dataclass(frozen=True)
class Budget:
    """软上限：到了就不再开新一圈，收口总结；硬上限：连收口都可能超，就直接停。"""

    soft_usd: float
    hard_usd: float

    def check(self, spent: float, next_worst_usd: float) -> str:
        if spent + next_worst_usd > self.hard_usd:
            return "hard"
        if spent >= self.soft_usd:
            return "soft"
        return "ok"


def worst_case_next_usd(model: str, last: Tokens | None, max_tokens: int, extra_input: int = 0) -> float:
    """下一次请求最坏花多少：上一次的输入总量 + 新增内容全按未缓存输入价，输出顶满 max_tokens。"""
    prompt = (last.prompt + last.output if last else 0) + extra_input
    return cost_usd(model, Tokens(input=prompt, output=max_tokens))


def _width(s: str) -> int:
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in s)


def ljust(s: str, width: int) -> str:
    """按终端显示宽度左对齐（中文占两格），只给演示打印表格用。"""
    return s + " " * max(0, width - _width(s))


def rjust(s: str, width: int) -> str:
    return " " * max(0, width - _width(s)) + s
