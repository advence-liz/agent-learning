#!/usr/bin/env python3
"""Sub Agent 的最小实现：父子是两个独立的 messages 数组，子 agent 只把最后一段文字交回去。

结构：
  run_agent(client, system, messages, tools)  —— 标准的 tool-use 循环（和 Messages API 同形）
  Agent 工具                                   —— 在父循环里被调用时，新建一个**空的** messages，
                                                 只放一条 user=任务描述，跑完取最后的 text 当 tool_result

离线运行：用 ScriptedClient 按剧本返回 tool_use / text，读的是本仓库真实文件。
真实运行：把 client 换成 anthropic.Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL），本 demo 不发请求。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent  # code/agent


# ---------------- 工具 ----------------

def tool_read_file(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def tool_grep(pattern: str) -> str:
    hits = []
    for p in sorted(ROOT.glob("*_demo/*.py")):
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if pattern in line:
                hits.append(f"{p.relative_to(ROOT)}:{i}: {line.strip()}")
    return "\n".join(hits) or "(no match)"


CHILD_TOOLS: dict[str, Callable[..., str]] = {"read_file": tool_read_file, "grep": tool_grep}


# ---------------- 通用 agent 循环 ----------------

@dataclass
class RunStats:
    requests: int = 0
    tool_calls: int = 0


def run_agent(client, system: str, messages: list[dict], tools: dict[str, Callable[..., str]], stats: RunStats) -> str:
    while True:
        resp = client.messages.create(model="claude-sonnet-5-5", max_tokens=4096, system=system,
                                      tools=[{"name": n} for n in tools], messages=messages)
        stats.requests += 1
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason != "tool_use":
            return "".join(b.text for b in resp.content if b.type == "text")
        results = []
        for b in resp.content:
            if b.type == "tool_use":
                stats.tool_calls += 1
                out = tools[b.name](**b.input)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
        messages.append({"role": "user", "content": results})


def make_agent_tool(client, child_stats: RunStats, child_transcripts: list[list[dict]]):
    """父 agent 看到的 Agent 工具。关键就三行：新数组、只放任务、只回结论。"""

    def agent(description: str, prompt: str) -> str:
        child_messages = [{"role": "user", "content": prompt}]  # ← 全新的 messages，看不到父历史
        child_system = "你是代码探索子 agent。只读不写，最后用 5 行以内给出结论和文件:行号。"
        result = run_agent(client, child_system, child_messages, CHILD_TOOLS, child_stats)
        child_transcripts.append(child_messages)  # 子历史落盘（Claude Code 存到 subagents/agent-*.jsonl）
        return result  # ← 父亲只拿到这一段

    return agent


# ---------------- 离线剧本 client ----------------

def tu(id_: str, name: str, **inp) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=inp)


def tx(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=text)


class ScriptedClient:
    """按 system prompt 区分父/子，各自按顺序吐剧本里的响应。"""

    def __init__(self, scripts: dict[str, list[list]]):
        self.scripts = {k: iter(v) for k, v in scripts.items()}
        self.requests: list[dict] = []
        self.messages = self

    def create(self, **kw):
        self.requests.append({"who": "child" if "子 agent" in kw["system"] else "parent",
                              "n_messages": len(kw["messages"]), "chars": size(kw["messages"])})
        who = "child" if "子 agent" in kw["system"] else "parent"
        blocks = next(self.scripts[who])
        stop = "tool_use" if any(b.type == "tool_use" for b in blocks) else "end_turn"
        return SimpleNamespace(content=blocks, stop_reason=stop)


def size(messages: list[dict]) -> int:
    return len(json.dumps(messages, ensure_ascii=False, default=lambda o: o.__dict__))


FILES = ["hooks_demo/guard_bash.py", "hooks_demo/hook_runner.py", "hooks_demo/stop_gate.py"]
CONCLUSION = ("exit 2 的处理在 hooks_demo/hook_runner.py 的 dispatch()：code == 2 时对阻断类事件置 blocked，"
              "stderr 作理由；guard_bash.py 对 rm -rf / 返回 2。")


def scenario_inline(client_factory=ScriptedClient) -> tuple[int, RunStats]:
    """不用子 agent：父亲自己 grep + 读 3 个文件。"""
    c = client_factory({"parent": [
        [tu("p1", "grep", pattern="exit")],
        [tu("p2", "read_file", path=FILES[0]), tu("p3", "read_file", path=FILES[1]), tu("p4", "read_file", path=FILES[2])],
        [tx(CONCLUSION)],
    ]})
    msgs = [{"role": "user", "content": "hook 的 exit 2 在 demo 里是在哪处理的？"}]
    st = RunStats()
    run_agent(c, "你是主 agent。", msgs, CHILD_TOOLS, st)
    return size(msgs), st


def scenario_subagent() -> tuple[int, int, RunStats, RunStats]:
    c = ScriptedClient({
        "parent": [
            [tu("p1", "agent", description="找 exit 2 处理", prompt="在 *_demo 里找 hook exit 2 的处理位置，给文件:行号")],
            [tx(CONCLUSION)],
        ],
        "child": [
            [tu("c1", "grep", pattern="exit")],
            [tu("c2", "read_file", path=FILES[0]), tu("c3", "read_file", path=FILES[1]), tu("c4", "read_file", path=FILES[2])],
            [tx(CONCLUSION)],
        ],
    })
    child_stats, transcripts = RunStats(), []
    parent_tools = {"agent": make_agent_tool(c, child_stats, transcripts)}
    msgs = [{"role": "user", "content": "hook 的 exit 2 在 demo 里是在哪处理的？"}]
    st = RunStats()
    run_agent(c, "你是主 agent。", msgs, parent_tools, st)
    return size(msgs), size(transcripts[0]), st, child_stats


if __name__ == "__main__":
    inline_chars, s1 = scenario_inline()
    parent_chars, child_chars, s2, cs = scenario_subagent()
    print(f"[inline]   父 messages = {inline_chars:>6} 字符  (父请求 {s1.requests} 次, 工具 {s1.tool_calls} 次)")
    print(f"[subagent] 父 messages = {parent_chars:>6} 字符  (父请求 {s2.requests} 次, 工具 {s2.tool_calls} 次)")
    print(f"           子 messages = {child_chars:>6} 字符  (子请求 {cs.requests} 次, 工具 {cs.tool_calls} 次，用完即弃)")
    print(f"父上下文缩小到 inline 的 {parent_chars / inline_chars:.1%}")
