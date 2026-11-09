"""补充章「成本控制与模型路由」：给 agent 循环加金额预算，按租户记账。

每开一圈之前问两件事：
  1. 已花的 + 下一圈最坏情况 > 硬上限？→ 一次都不再调，直接返回已有结果（stop=budget_hard）；
  2. 已花的 ≥ 软上限？→ 再调最后一次、禁用工具（tool_choice=none），让模型收口总结（stop=budget_soft）。
这和「Agent 构建指南」内核一的软预算是同一个思路，只是把「时间」换成了「钱」。

离线运行： uv run python -m cost_routing.budget
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from cost_routing.meter import Budget, CostMeter, normalize_usage, worst_case_next_usd
from fake_llm import FakeAnthropic, text, tool_use

MODEL = "claude-opus-5-5"
MAX_TOKENS = 4096
TOOLS = [{
    "name": "search_logs",
    "description": "在构建日志里搜索关键词，返回匹配的行",
    "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
}]


def wrap_up_prompt(why: str) -> str:
    return f"（系统提示：{why}，本轮到此为止。不要再调用工具，用已经拿到的信息总结：做完了什么、还差什么。）"


@dataclass
class RunResult:
    answer: str
    stop: str  # end_turn | budget_soft | budget_hard
    turns: int
    usd: float


def _text_of(resp) -> str:
    return "".join(b.text for b in resp.content if b.type == "text")


def run_budgeted(client, task: str, run_tool: Callable[[str, dict[str, Any]], str], *,
                 meter: CostMeter, budget: Budget, tenant: str,
                 model: str = MODEL, log: Callable[[str], None] = print) -> RunResult:
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    last = None  # 上一次响应的 Tokens，用来估下一圈最坏花多少
    last_answer = ""
    pending_input = 0  # 上一圈追加的工具结果（粗估：按字符数算 token，宁可高估）

    def ask(**extra):
        nonlocal last
        resp = client.messages.create(model=model, max_tokens=MAX_TOKENS, tools=TOOLS,
                                      messages=messages, **extra)
        usd = meter.add(model, resp.usage, tenant=tenant)
        last = normalize_usage(resp.usage)
        log(f"  [计费] {tenant} 本次 ${usd:.4f}，累计 ${meter.spent(tenant):.4f}")
        return resp

    turn = 0
    while True:
        spent = meter.spent(tenant)
        verdict = budget.check(spent, worst_case_next_usd(model, last, MAX_TOKENS, pending_input))
        if verdict == "hard":
            log(f"⊘ 下一圈最坏情况会超过硬上限 ${budget.hard_usd}，不再调用模型")
            return RunResult(last_answer or "（预算用尽，任务未完成）", "budget_hard", turn, spent)
        if verdict == "soft":
            log(f"⊘ 已花 ${spent:.4f}，到了软上限 ${budget.soft_usd}：禁用工具，再调最后一次收口")
            note = {"type": "text", "text": wrap_up_prompt(f"已花费 ${spent:.4f}，到了软上限")}
            last_msg = messages[-1]  # 这里一定是 user：任务本身，或最后一组 tool_result
            if isinstance(last_msg["content"], str):
                last_msg["content"] = [{"type": "text", "text": last_msg["content"]}]
            last_msg["content"].append(note)  # 并进同一条 user 消息，不出现两条连续的 user
            resp = ask(tool_choice={"type": "none"})
            return RunResult(_text_of(resp), "budget_soft", turn, meter.spent(tenant))

        resp = ask()
        turn += 1
        messages.append({"role": "assistant", "content": resp.content})
        last_answer = _text_of(resp) or last_answer
        if resp.stop_reason != "tool_use":
            return RunResult(_text_of(resp), "end_turn", turn, meter.spent(tenant))
        results = []
        for b in resp.content:
            if b.type == "tool_use":
                log(f"⏺ {b.name}({json.dumps(b.input, ensure_ascii=False)})")
                out = run_tool(b.name, b.input)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
        pending_input = sum(len(r["content"]) for r in results)
        messages.append({"role": "user", "content": results})


SUMMARY = "已确认：依赖安装阶段缓存全部未命中，占了大部分耗时。还没查清缓存为什么失效，建议对比两次构建的 lockfile。"


def demo_script(n_tools: int, prompt_tokens: int = 20_000, growth: int = 8_000) -> list[Any]:
    """一个想搜 n_tools 次的模型：每圈输入涨 growth 个 token（usage 是构造的，没有缓存）。
    收到 tool_choice=none 的收口请求时，不管轮到第几步都直接写总结。"""

    def step(i: int):
        def respond(params: dict[str, Any]) -> dict[str, Any]:
            tokens = prompt_tokens + i * growth
            if params.get("tool_choice") == {"type": "none"} or i == n_tools:
                return text(SUMMARY, input_tokens=tokens, output_tokens=150)
            return tool_use("search_logs", {"query": f"q{i}"}, input_tokens=tokens, output_tokens=200)
        return respond

    return [step(i) for i in range(n_tools + 1)]


def main() -> None:
    meter = CostMeter()
    tool = lambda name, args: "install deps: 301s (cache 0/38 hits)"  # noqa: E731
    budget = Budget(soft_usd=0.30, hard_usd=0.80)
    print(f"[离线 fake 模型] 软上限 ${budget.soft_usd}，硬上限 ${budget.hard_usd}（单个租户、单次任务）\n")
    print("—— 租户 team-a：模型一直想再搜一次 ——")
    r = run_budgeted(FakeAnthropic(demo_script(20)), "构建为什么突然变慢了？", tool,
                     meter=meter, budget=budget, tenant="team-a")
    print(f"  结束原因 {r.stop}，{r.turns} 圈，花费 ${r.usd:.4f}\n  回答：{r.answer}\n")

    print("—— 租户 team-b：两圈就答完 ——")
    r = run_budgeted(FakeAnthropic(demo_script(1)), "构建为什么突然变慢了？", tool,
                     meter=meter, budget=budget, tenant="team-b")
    print(f"  结束原因 {r.stop}，{r.turns} 圈，花费 ${r.usd:.4f}\n")

    print("按租户汇总：", {k: round(v, 4) for k, v in meter.by("tenant").items()})


if __name__ == "__main__":
    main()
