"""补充章「成本控制与模型路由」：同一段 10 圈的 agent 对话，换几种做法各花多少钱。

usage 是按下面的形状构造的（不是真实请求）：
  - 固定前缀（system + 工具定义）8,000 token，任务描述 300 token；
  - 前 9 圈每圈：模型输出 400 token（一次工具调用），工具结果 6,000 token（截断后 1,200）；
  - 第 10 圈：模型输出 800 token 的最终回答。
每圈的输入 = 前缀 + 任务 + 之前所有圈的输出和工具结果，所以输入逐圈线性变长，累计输入按圈数平方增长。

缓存按「顶层自动缓存」的理想情况构造：每圈读到上一圈的全部输入，只写这一圈新增的部分。

离线运行： uv run python -m cost_routing.ledger
"""

from __future__ import annotations

from dataclasses import dataclass

from cost_routing.meter import CostMeter, Tokens, ljust

MODEL = "claude-opus-5-5"
PREFIX, TASK = 8_000, 300
OUT, FINAL_OUT = 400, 800
TOOL_RESULT, TRUNCATED = 6_000, 1_200
TURNS = 10


@dataclass(frozen=True)
class Scenario:
    name: str
    cache: bool
    truncate: bool
    prefix_breaks: bool = False  # 前缀每圈都变（比如 system 里带了当前时间）


SCENARIOS = [
    Scenario("不缓存 · 不截断", cache=False, truncate=False),
    Scenario("不缓存 · 截断工具结果", cache=False, truncate=True),
    Scenario("缓存 · 不截断", cache=True, truncate=False),
    Scenario("缓存 · 截断工具结果", cache=True, truncate=True),
    Scenario("缓存，但前缀每圈都变", cache=True, truncate=False, prefix_breaks=True),
]


def prompts(truncate: bool) -> list[int]:
    """每圈请求的输入总量。"""
    res = TRUNCATED if truncate else TOOL_RESULT
    return [PREFIX + TASK + i * (OUT + res) for i in range(TURNS)]


def usages(s: Scenario) -> list[Tokens]:
    ps = prompts(s.truncate)
    out: list[Tokens] = []
    for i, p in enumerate(ps):
        o = FINAL_OUT if i == TURNS - 1 else OUT
        if not s.cache:
            out.append(Tokens(input=p, output=o))
        elif s.prefix_breaks or i == 0:
            out.append(Tokens(write_5m=p, output=o))  # 什么都读不到，整段重写
        else:
            out.append(Tokens(cache_read=ps[i - 1], write_5m=p - ps[i - 1], output=o))
    return out


def run(s: Scenario) -> CostMeter:
    meter = CostMeter()
    for u in usages(s):
        meter.add(MODEL, u)
    return meter


def main() -> None:
    print(f"[离线 fake 用量] 模型 {MODEL}，10 圈 agent 对话，usage 按固定形状构造\n")
    base, cached = run(SCENARIOS[0]), run(SCENARIOS[2])
    print("圈    本圈输入   无缓存 本圈$   有缓存 本圈$")
    for i, (a, b) in enumerate(zip(base.records, cached.records), 1):
        print(f"{i:>2} {a.tokens.prompt:>11,} {a.usd:>13.4f} {b.usd:>14.4f}")
    ps = prompts(False)
    print(f"\n第 10 圈的输入是第 1 圈的 {ps[-1] / ps[0]:.1f} 倍；10 圈累计输入 {sum(ps):,} token"
          f"（如果每圈都只有第 1 圈那么长，是 {ps[0] * TURNS:,}）\n")

    print(f"{ljust('做法', 26)}  总成本$  相对基线")
    b0 = base.spent()
    for s in SCENARIOS:
        usd = run(s).spent()
        print(f"{ljust(s.name, 26)}{usd:>9.4f}  {usd / b0:>7.0%}")


if __name__ == "__main__":
    main()
