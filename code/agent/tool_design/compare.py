"""补充章「工具设计」：同一个任务，坏工具集 vs 好工具集，对比 agent 循环的轨迹和上下文开销。

注意：两条轨迹都是 FakeAnthropic 的剧本，模型「怎么反应」是我们写死的，用来演示机制：
坏工具集下模型要猜单位、猜枚举值；好工具集下错误信息直接告诉它怎么改。
真实模型在两套工具下的差异有多大，要用评测集跑出来，不能拿这个剧本当结论。
工具定义和工具结果的字符数则是真实算出来的，与剧本无关。

离线运行： uv run python -m tool_design.compare
真实运行：把 FakeAnthropic(...) 换成 anthropic.Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from tool_design.budget import dumps, estimate_tokens, measure_tools, truncate_result
from tool_design.toolsets import (BAD_HANDLERS, BAD_TOOLS, GOOD_HANDLERS, GOOD_TOOLS, ORDERS, USERS,
                                  reset_backend, yuan)

MODEL = "claude-opus-5-5"
TASK = "张伟说上个月底买的耳机有问题，帮他退款。"


@dataclass
class Stats:
    answer: str = ""
    model_calls: int = 0
    tool_calls: int = 0
    tool_errors: int = 0
    defs_chars: int = 0  # 工具定义，每次请求都带
    result_chars: int = 0  # 本次任务所有工具结果加起来
    context_chars: int = 0  # 每次请求里「工具定义 + 历史中全部工具结果」的累加：大结果每轮都会被重新发送
    defs_tokens: int = 0
    result_tokens: int = 0
    context_tokens: int = 0
    results: list[dict[str, Any]] = field(default_factory=list)


def run_agent(client, task: str, tools: list[dict], handlers: dict[str, Callable[..., str]], *,
              max_turns: int = 8, log: Callable[[str], None] = print) -> Stats:
    m = measure_tools(tools)
    st = Stats(defs_chars=m["chars"], defs_tokens=m["tokens"])
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    for _ in range(max_turns):
        st.model_calls += 1
        st.context_chars += st.defs_chars + st.result_chars
        st.context_tokens += st.defs_tokens + st.result_tokens
        resp = client.messages.create(model=MODEL, max_tokens=16000, tools=tools, messages=messages)
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason != "tool_use":
            st.answer = "".join(b.text for b in resp.content if b.type == "text")
            return st
        results = []
        for b in resp.content:
            if b.type != "tool_use":
                continue
            st.tool_calls += 1
            log(f"⏺ {b.name}({dumps(b.input)})")
            try:
                out, err = handlers[b.name](**b.input), False
            except Exception as e:
                # 好工具集抛的 ToolError，消息本身就是写给模型的改法；坏工具集的后端异常则是原文透传
                out, err = str(e), True
            st.tool_errors += err
            st.result_chars += len(out)
            st.result_tokens += estimate_tokens(out)
            first = out.split("\n")[0]
            log(f"{'✘' if err else '✔'} {first[:60]}{'…' if len(first) > 60 else ''}  （{len(out)} 字符）")
            r = {"type": "tool_result", "tool_use_id": b.id, "content": out, "is_error": err}
            results.append(r)
            st.results.append(r)
        messages.append({"role": "user", "content": results})
    raise RuntimeError(f"超过 {max_turns} 轮仍未结束")


# ---------- 两份剧本（离线 fake 模型）----------

def bad_script():
    from fake_llm import text, tool_use

    zw = next(u for u in USERS if u["name"] == "张伟")
    order = next(o for o in ORDERS if o["number"] == "ORD-1042")
    refund = {"order_id": order["id"], "amount": 899}  # 剧本：模型以为单位是元，其实接口要的是分
    return [
        tool_use("api_get_users", {}, say="先找到张伟的用户 ID。"),
        tool_use("api_get_orders", {"user_id": zw["id"]}),
        tool_use("api_post_refunds", {**refund, "reason": "耳机有问题"}),
        tool_use("api_post_refunds", {**refund, "reason": "defective"}, say="原因可能要用英文代码，换一个试试。"),
        tool_use("api_post_refunds", {**refund, "reason": "damaged"}, say="再换一个。"),
        text("已为张伟的耳机订单提交退款，金额 899。"),
    ]


def good_script():
    from fake_llm import text, tool_use

    return [
        tool_use("webapp_find_orders", {"customer": "张伟", "query": "耳机"}),
        tool_use("webapp_refund_order", {"order_number": "1042", "reason": "damaged"}),
        tool_use("webapp_refund_order", {"order_number": "ORD-1042", "reason": "damaged"}, say="订单号要带 ORD- 前缀。"),
        text("已为张伟的降噪耳机 Pro（ORD-1042）提交全额退款 ¥899.00，3–5 个工作日原路退回。"),
    ]


def run(name: str, tools, handlers, script) -> Stats:
    from fake_llm import FakeAnthropic

    reset_backend()
    print(f"—— {name} ——")
    print(f"❯ {TASK}")
    st = run_agent(FakeAnthropic(script), TASK, tools, handlers)
    print(f"⏺ {st.answer}")
    return st


def report(bad: Stats, good: Stats) -> list[str]:
    def size(chars: int, tokens: int) -> str:
        return f"{chars} 字符 ≈{tokens} tok"

    return [
        "指标 | 坏工具集 | 好工具集",
        f"模型调用 | {bad.model_calls} | {good.model_calls}",
        f"工具调用（其中报错） | {bad.tool_calls}（{bad.tool_errors}） | {good.tool_calls}（{good.tool_errors}）",
        f"工具定义，每次请求都带 | {size(bad.defs_chars, bad.defs_tokens)} | {size(good.defs_chars, good.defs_tokens)}",
        f"工具结果合计 | {size(bad.result_chars, bad.result_tokens)} | {size(good.result_chars, good.result_tokens)}",
        f"各次请求累计发送 | {size(bad.context_chars, bad.context_tokens)} | {size(good.context_chars, good.context_tokens)}",
    ]


if __name__ == "__main__":
    bad = run("坏工具集：后端接口一比一包装", BAD_TOOLS, BAD_HANDLERS, bad_script())
    o = next(o for o in ORDERS if o["number"] == "ORD-1042")
    print(f"[后端记录] ORD-1042 实付 {yuan(o['payment']['captured_cents'])}，实际退了 {yuan(o['refunds'][0]['amount_cents'])}\n")
    good = run("好工具集：按任务设计", GOOD_TOOLS, GOOD_HANDLERS, good_script())
    print("\n—— 对比（离线 fake 模型；轨迹是剧本，字符数是实算）——")
    print("\n".join(report(bad, good)))
    print("\n—— 坏工具集第 3 次调用，模型看到的错误 ——")
    print(bad.results[2]["content"])
    print("\n—— 好工具集第 2 次调用，模型看到的错误 ——")
    print(good.results[1]["content"])
    print("\n—— 兜底截断：api_get_users 的结果截到 300 字符 ——")
    print(truncate_result(BAD_HANDLERS["api_get_users"](), 300, "需要的信息如果不在上面，换更具体的查询条件再调一次。"))
