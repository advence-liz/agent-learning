#!/usr/bin/env python3
"""用一个「前缀缓存模拟器」解释 Fork 为什么必须原样继承父会话。

Prompt Cache 的规则（Anthropic 文档）：
  - 请求按 tools → system → messages 的顺序渲染；
  - 缓存按「前缀」精确匹配：某处变了，它之后的全部要重算；
  - 改 tool 定义会让三层全部失效。

模拟器：把请求拆成 block 序列，每个 block 边界算一个累计 hash 存进 cache；
新请求从头比对，命中的最长前缀算 cache_read，剩下的算 uncached。
token 数用「字符数 / 4」粗估，只看相对大小。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

TOOLS = [
    {"name": "Bash", "description": "run shell", "input_schema": {"type": "object"}},
    {"name": "Read", "description": "read file", "input_schema": {"type": "object"}},
    {"name": "Edit", "description": "edit file", "input_schema": {"type": "object"}},
    {"name": "Agent", "description": "spawn subagent", "input_schema": {"type": "object"}},
]
SYSTEM = "You are Claude Code. " + "（系统提示词与工具说明占位文本）" * 400


def blocks_of(tools: list[dict], system: str, messages: list[dict]) -> list[str]:
    out = [json.dumps(tools, sort_keys=True, ensure_ascii=False), system]
    out += [json.dumps(m, sort_keys=True, ensure_ascii=False) for m in messages]
    return out


def tok(s: str) -> int:
    return max(1, len(s) // 4)


@dataclass
class PrefixCache:
    entries: set[str] = field(default_factory=set)

    def send(self, tools, system, messages) -> dict:
        bl = blocks_of(tools, system, messages)
        h = hashlib.sha256()
        read = 0
        matched = True
        total = 0
        for b in bl:
            h.update(b.encode())
            d = h.hexdigest()
            total += tok(b)
            if matched and d in self.entries:
                read = total
            else:
                matched = False
            self.entries.add(d)  # 写入（真实 API 只在 cache_control 断点写；这里每个边界都写，简化）
        return {"cache_read": read, "uncached": total - read, "total": total}


def main_history() -> list[dict]:
    msgs = []
    for i in range(30):
        msgs.append({"role": "user", "content": f"第 {i} 轮：讨论 webapp 卡片协议的细节 " + "…" * 300})
        msgs.append({"role": "assistant", "content": f"第 {i} 轮回答 " + "…" * 600})
    return msgs


def run() -> list[tuple[str, dict]]:
    cache = PrefixCache()
    hist = main_history()
    rows = []
    rows.append(("主会话第 N 轮（预热）", cache.send(TOOLS, SYSTEM, hist)))
    task = {"role": "user", "content": "<fork 指令> 基于上面的讨论，起草单测，完成后只回报结论"}
    rows.append(("Fork：同 tools/system/历史 + 追加任务", cache.send(TOOLS, SYSTEM, hist + [task])))
    no_bash = [t for t in TOOLS if t["name"] != "Bash"]
    rows.append(("Fork 但删掉 Bash 工具定义", cache.send(no_bash, SYSTEM, hist + [task])))
    rows.append(("Fork 但改了 system prompt", cache.send(TOOLS, SYSTEM + "\n只读模式。", hist + [task])))
    sub_sys = "You are an Explore subagent."
    rows.append(("全新 Sub Agent（自己的 system+tools，空历史）",
                 cache.send([TOOLS[1]], sub_sys, [{"role": "user", "content": "找出 exit 2 的处理位置"}])))
    btw = {"role": "user", "content": "<side question> 刚才那个配置文件叫什么？"}
    rows.append(("/btw：同前缀 + 追加问题（推测实现）", cache.send(TOOLS, SYSTEM, hist + [btw])))
    return rows


if __name__ == "__main__":
    print(f"{'场景':<42}{'cache_read':>11}{'uncached':>10}{'命中率':>8}")
    for name, r in run():
        rate = r["cache_read"] / r["total"]
        print(f"{name:<42}{r['cache_read']:>11}{r['uncached']:>10}{rate:>8.1%}")
