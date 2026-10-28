"""补充章「Agent 构建指南」内核一：循环最难的是什么时候停。

在第 1 章的 run_agent 上加三件事：
  1. 撞迭代上限 → 不抛错，再调一次模型（tool_choice=none）让它收口总结；
  2. 软预算到点 → 只拦「再开一圈」，已经在跑的这圈照常做完；
  3. 被打断 → 没执行的工具调用补一条 is_error 的 tool_result，历史保持「每个 tool_use 都有回音」。
结束原因放进返回值，调用方据此决定界面怎么显示。

离线运行： uv run python -m loop_guard.guarded_loop
真实运行：把 FakeAnthropic(...) 换成 anthropic.Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。
"""

from __future__ import annotations

import json
import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

MODEL = "claude-opus-5-5"

ABORTED = "用户已打断，这个工具调用没有执行。"


def wrap_up_prompt(why: str) -> str:
    return f"（系统提示：{why}，本轮到此为止。不要再调用工具，用已经拿到的信息总结：做完了什么、还差什么、下一步建议。）"


@dataclass
class RunResult:
    answer: str
    stop: str  # end_turn | max_iterations | soft_budget | interrupted
    turns: int  # 本次调用里开了几圈带工具的请求（不含收口那一次）


def _text_of(resp) -> str:
    return "".join(b.text for b in resp.content if b.type == "text")


def _blocks(content) -> list[dict[str, Any]]:
    """历史里既有 SDK 的 pydantic block，也有我们自己拼的 dict，统一成 dict 再看。"""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b.model_dump() if hasattr(b, "model_dump") else b for b in content]


def add_user_text(messages: list[dict[str, Any]], s: str) -> None:
    """在历史末尾追加一段用户文字：最后一条已是 user（比如一组 tool_result）就并进去，不新开一条。"""
    if not messages or messages[-1]["role"] != "user":
        messages.append({"role": "user", "content": s})
        return
    last = messages[-1]
    if isinstance(last["content"], str):
        last["content"] = [{"type": "text", "text": last["content"]}]
    last["content"].append({"type": "text", "text": s})  # tool_result 在前、文字在后


def dangling_tool_uses(messages: list[dict[str, Any]]) -> list[str]:
    """模拟接口的校验：每个 tool_use 都要在紧随其后的 user 消息里有同 id 的 tool_result。返回缺回音的 id。"""
    missing = []
    for i, m in enumerate(messages):
        if m["role"] != "assistant":
            continue
        nxt = messages[i + 1] if i + 1 < len(messages) else None
        answered = {b["tool_use_id"] for b in _blocks(nxt["content"]) if b["type"] == "tool_result"} if nxt else set()
        missing += [b["id"] for b in _blocks(m["content"]) if b["type"] == "tool_use" and b["id"] not in answered]
    return missing


def run_guarded(client, messages: list[dict[str, Any]], tools: list[dict],
                handlers: dict[str, Callable[..., str]], *, max_turns: int = 10,
                soft_budget_s: float = math.inf, signal: threading.Event | None = None,
                now: Callable[[], float] = time.monotonic,
                log: Callable[[str], None] = print) -> RunResult:
    """messages 会被原地追加；调用方先放好这一轮的用户输入。"""
    start = now()

    def ask(**extra):
        return client.messages.create(model=MODEL, max_tokens=16000, tools=tools,
                                      messages=messages, **extra)

    def wrap_up(stop: str, why: str, turns: int) -> RunResult:
        add_user_text(messages, wrap_up_prompt(why))
        # 工具定义保留（历史里有 tool_use），用 tool_choice=none 禁止再调
        resp = ask(tool_choice={"type": "none"})
        messages.append({"role": "assistant", "content": resp.content})
        return RunResult(_text_of(resp), stop, turns)

    turn = 0
    while True:
        if turn >= max_turns:
            return wrap_up("max_iterations", f"已达到迭代上限 {max_turns} 圈", turn)
        if now() - start >= soft_budget_s:
            return wrap_up("soft_budget", "已用完本轮的时间预算", turn)

        resp = ask()
        messages.append({"role": "assistant", "content": resp.content})
        turn += 1
        if resp.stop_reason != "tool_use":
            return RunResult(_text_of(resp), "end_turn", turn)

        results = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            if signal is not None and signal.is_set():
                # 打断后不再执行，但仍要给这个 tool_use 一个回音，否则下一次请求会被接口拒绝
                log(f"⊘ {block.name} 未执行")
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": ABORTED, "is_error": True})
                continue
            log(f"⏺ {block.name}({json.dumps(block.input, ensure_ascii=False)})")
            try:
                out, err = handlers[block.name](**block.input), False
            except Exception as e:
                out, err = f"{type(e).__name__}: {e}", True
            log(f"✔ {out[:80]}")
            results.append({"type": "tool_result", "tool_use_id": block.id,
                            "content": out, "is_error": err})
        messages.append({"role": "user", "content": results})
        if signal is not None and signal.is_set():
            return RunResult("", "interrupted", turn)


# ---------- 离线演示 ----------

TOOLS = [
    {"name": "search_logs", "description": "按关键词搜索构建日志，返回命中的几行。",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "run_tests", "description": "运行测试并返回摘要。",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "deploy_preview", "description": "把当前分支部署到预览环境。",
     "input_schema": {"type": "object", "properties": {}}},
]


def demo_max_iterations():
    """场景一：模型一直想再搜一次，撞上 3 圈上限后收口。"""
    from fake_llm import FakeAnthropic, text, tool_use

    client = FakeAnthropic([
        tool_use("search_logs", {"query": "slow"}, say="先搜一下构建日志。"),
        tool_use("search_logs", {"query": "cache miss"}),
        tool_use("search_logs", {"query": "dependency install"}),
        text("已确认：依赖安装阶段缓存全部未命中，占了大部分耗时。还没查清缓存为什么失效，建议下一步对比两次构建的 lockfile。"),
    ])
    hits = {
        "slow": "build took 412s (baseline 95s)",
        "cache miss": "restore cache: 0/38 hits",
        "dependency install": "install deps: 301s",
    }
    task = "构建为什么突然变慢了？"
    print(f"❯ {task}")
    messages = [{"role": "user", "content": task}]
    r = run_guarded(client, messages, TOOLS, {"search_logs": lambda query: hits.get(query, "无命中")}, max_turns=3)
    print(f"⏺ {r.answer}")
    print(f"  [结束原因 {r.stop}，{r.turns} 圈]")
    return r, client


def demo_interrupt():
    """场景二：同一圈里两个工具，第一个跑到一半用户按了打断；之后用户补一句话继续。"""
    from fake_llm import FakeAnthropic, text

    client = FakeAnthropic([
        {
            "content": [
                {"type": "text", "text": "先跑测试，再部署预览。"},
                {"type": "tool_use", "id": "toolu_run", "name": "run_tests", "input": {}},
                {"type": "tool_use", "id": "toolu_deploy", "name": "deploy_preview", "input": {}},
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 50, "output_tokens": 40},
        },
        text("好的，不部署。测试结果：120 个通过，0 个失败。"),
    ])
    stop = threading.Event()

    def run_tests():
        stop.set()  # 模拟：测试跑着的时候用户按了打断
        return "120 passed, 0 failed"

    handlers = {"run_tests": run_tests, "deploy_preview": lambda: "deployed to preview"}
    task = "跑一下测试然后部署预览"
    print(f"❯ {task}")
    messages = [{"role": "user", "content": task}]
    first = run_guarded(client, messages, TOOLS, handlers, signal=stop)
    print(f"  [结束原因 {first.stop}；缺回音的 tool_use：{dangling_tool_uses(messages)}]")
    print(f"  [如果打断时直接退出、不写这条 tool_result 消息：{dangling_tool_uses(messages[:-1])}]")

    follow_up = "先别部署，告诉我测试结果就行"
    print(f"❯ {follow_up}")
    add_user_text(messages, follow_up)
    second = run_guarded(client, messages, TOOLS, handlers)
    print(f"⏺ {second.answer}")
    return first, second, messages, client


if __name__ == "__main__":
    print("—— 场景一：撞迭代上限 ——")
    _, c1 = demo_max_iterations()
    print(f"\n[离线 fake 模型] 收口那次请求的 tool_choice：{c1.calls[-1]['tool_choice']}")
    print("\n—— 场景二：打断后继续 ——")
    demo_interrupt()
