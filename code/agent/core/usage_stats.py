"""第 3 章：从 Claude Code 会话 jsonl 里只读地统计 token 与费用。

只读取每条 assistant 记录的 message.model / message.id / message.usage，**不读、不打印任何会话正文**。

用法：
    uv run python -m core.usage_stats                       # 默认：~/.claude/projects 下最大的那个会话
    uv run python -m core.usage_stats <a.jsonl> [b.jsonl…]  # 指定会话文件（可多个，例如连同 subagents/*.jsonl）
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

# 单位：美元 / 百万 token。来源：claude-api skill「Current Models」表（cached: 2026-10-06），第一方 API 标价。
# cache_read 一列：Opus 5.5 / Sonnet 5.5 的 $0.20 是 skill 里写明的；其余按 skill 的一般规则「≈0.1× 输入价」推算，标 *。
# 缓存写入：5 分钟 TTL = 1.25× 输入价，1 小时 TTL = 2× 输入价（skill: shared/prompt-caching.md）。
PRICES: dict[str, dict[str, float]] = {
    "claude-opus-5-5":   {"input": 4.00, "output": 20.00, "cache_read": 0.20},
    "claude-opus-5":     {"input": 5.00, "output": 25.00, "cache_read": 0.50},   # *
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20},
    "claude-haiku-5-5":  {"input": 0.10, "output": 0.50,  "cache_read": 0.01},   # * 且只适用于 ≤100K 的提示
}
PRICE_DATE = "2026-10-06"
WRITE_5M, WRITE_1H = 1.25, 2.0


@dataclass
class Totals:
    requests: int = 0
    input: int = 0            # 最后一个缓存断点之后、没走缓存的输入
    cache_read: int = 0       # 命中缓存的前缀
    write_5m: int = 0         # 本次新写入缓存（5 分钟 TTL）
    write_1h: int = 0         # 本次新写入缓存（1 小时 TTL）
    output: int = 0

    def add(self, u: dict) -> None:
        self.requests += 1
        self.input += u.get("input_tokens", 0) or 0
        self.cache_read += u.get("cache_read_input_tokens", 0) or 0
        self.output += u.get("output_tokens", 0) or 0
        created = u.get("cache_creation_input_tokens", 0) or 0
        split = u.get("cache_creation") or {}
        w1h = split.get("ephemeral_1h_input_tokens", 0) or 0
        w5m = split.get("ephemeral_5m_input_tokens", 0) or 0
        if w1h + w5m != created:  # 老记录没有拆分字段：按默认的 5 分钟 TTL 算
            w5m, w1h = created, 0
        self.write_5m += w5m
        self.write_1h += w1h

    @property
    def prompt(self) -> int:  # 模型这一轮真正「看到」的输入总量
        return self.input + self.cache_read + self.write_5m + self.write_1h

    @property
    def hit_rate(self) -> float:
        return self.cache_read / self.prompt if self.prompt else 0.0

    def cost(self, p: dict[str, float]) -> float:
        return (self.input * p["input"] + self.cache_read * p["cache_read"]
                + self.write_5m * p["input"] * WRITE_5M + self.write_1h * p["input"] * WRITE_1H
                + self.output * p["output"]) / 1e6

    def cost_without_cache(self, p: dict[str, float]) -> float:
        """反事实：同样的输入全部按普通输入价计。"""
        return (self.prompt * p["input"] + self.output * p["output"]) / 1e6


@dataclass
class Report:
    by_model: dict[str, Totals] = field(default_factory=lambda: defaultdict(Totals))
    skipped_lines: int = 0
    duplicate_lines: int = 0


def scan(paths: list[Path]) -> Report:
    rep = Report()
    seen: set[str] = set()
    for path in paths:
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    rep.skipped_lines += 1
                    continue
                msg = rec.get("message")
                if rec.get("type") != "assistant" or not isinstance(msg, dict) or "usage" not in msg:
                    continue
                model = msg.get("model") or "unknown"
                if model == "<synthetic>":  # Claude Code 本地合成的消息，没打 API
                    continue
                # 一次 API 响应会按 content block 拆成多行写进 jsonl，每行带同一份 usage → 按 message.id 去重
                mid = msg.get("id")
                if mid in seen:
                    rep.duplicate_lines += 1
                    continue
                if mid:
                    seen.add(mid)
                rep.by_model[model].add(msg["usage"])
    return rep


def default_session() -> Path:
    proj = Path.home() / ".claude/projects"
    files = sorted(proj.glob("*/*.jsonl"), key=lambda p: p.stat().st_size, reverse=True)
    if not files:
        raise SystemExit(f"在 {proj} 下没找到会话 jsonl，请显式传路径")
    return files[0]


def render(rep: Report) -> str:
    lines = [f"价格表：claude-api skill，第一方 API 标价，cached {PRICE_DATE}（Vertex 等合作方渠道另计价）"]
    hdr = f"{'model':18}{'请求':>7}{'未缓存输入':>12}{'缓存读':>14}{'写5m':>11}{'写1h':>12}{'输出':>11}{'命中率':>8}{'实际$':>10}{'无缓存$':>10}"
    lines.append(hdr)
    grand = [0.0, 0.0]
    for model, t in sorted(rep.by_model.items()):
        p = PRICES.get(model)
        cost = f"{t.cost(p):10.2f}" if p else f"{'无价目':>10}"
        nocache = f"{t.cost_without_cache(p):10.2f}" if p else f"{'-':>10}"
        if p:
            grand[0] += t.cost(p)
            grand[1] += t.cost_without_cache(p)
        lines.append(f"{model:18}{t.requests:7d}{t.input:12,d}{t.cache_read:14,d}{t.write_5m:11,d}"
                     f"{t.write_1h:12,d}{t.output:11,d}{t.hit_rate:8.1%}{cost}{nocache}")
    lines.append(f"合计（有价目的模型）：实际 ≈ ${grand[0]:.2f}，若无缓存 ≈ ${grand[1]:.2f}"
                 + (f"，缓存省了 {1 - grand[0] / grand[1]:.1%}" if grand[1] else ""))
    lines.append(f"去重掉的重复行：{rep.duplicate_lines}；解析失败行：{rep.skipped_lines}")
    return "\n".join(lines)


if __name__ == "__main__":
    paths = [Path(a) for a in sys.argv[1:]] or [default_session()]
    rep = scan(paths)
    print(f"扫描 {len(paths)} 个文件（只读 usage 字段）")
    print(render(rep))
