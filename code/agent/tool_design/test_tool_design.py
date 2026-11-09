import pytest

from fake_llm import FakeAnthropic
from tool_design.budget import dumps, estimate_tokens, measure_tools, truncate_result
from tool_design.compare import TASK, bad_script, good_script, run_agent
from tool_design.toolsets import (BAD_HANDLERS, BAD_TOOLS, GOOD_HANDLERS, GOOD_TOOLS, ORDERS, REFUND_SCHEMA,
                                  ToolError, find_orders, format_tool_error, reset_backend, validate)

quiet = {"log": lambda _: None}


@pytest.fixture(autouse=True)
def _clean():
    reset_backend()
    yield
    reset_backend()


# ---------- budget ----------

def test_estimate_tokens_ascii_and_cjk():
    assert estimate_tokens("abcdefgh") == 2
    assert estimate_tokens("退款") == 2
    assert estimate_tokens("ab退款") == 3  # 2/4 向上取整 + 2


def test_measure_tools_counts_whole_definition():
    m = measure_tools(GOOD_TOOLS)
    assert m["chars"] > sum(len(t["description"]) for t in GOOD_TOOLS)  # 描述 + 名字 + schema 都算
    assert m["tokens"] == estimate_tokens(dumps(GOOD_TOOLS))


def test_truncate_short_text_untouched():
    assert truncate_result("abc", 10, "翻页") == "abc"


def test_truncate_cuts_on_line_boundary_and_tells_how_to_continue():
    text = "\n".join(f"line {i:02d}" for i in range(10))  # 每行 7 字符，共 79 字符
    out = truncate_result(text, 20, "传 offset=2 继续。")
    head, notice = out.split("\n…")
    assert head == "line 00\nline 01"  # 第三行放不下就整行不要
    assert "只显示了前 15 / 79 字符" in notice
    assert "还剩 64 字符" in notice
    assert notice.endswith("传 offset=2 继续。]")


def test_truncate_hard_cuts_single_long_line():
    out = truncate_result("x" * 50, 10, "缩小范围。")
    assert out.startswith("x" * 10 + "\n…")
    assert "前 10 / 50 字符" in out


# ---------- 错误信息 ----------

def test_format_tool_error_shape():
    msg = format_tool_error("参数有误", ["a 不对", "b 缺了"], "改好再调。")
    assert msg == "参数有误：\n- a 不对\n- b 缺了\n改好再调。"


def test_validate_rejects_bad_args_with_actionable_messages():
    problems = validate(REFUND_SCHEMA, {"order_number": "1042", "reason": "耳机有问题", "amount": 899})
    assert problems == [
        "不认识的参数 amount（只接受：order_number、reason、amount_yuan）",
        "order_number=\"1042\" 格式不对。订单号，形如 ORD-1042，从 webapp_find_orders 的结果里原样复制，不要自己编",
        "reason=\"耳机有问题\" 不在可选值里，可选：damaged / not_as_described / no_longer_needed / other",
    ]
    assert validate(REFUND_SCHEMA, {"reason": "damaged"}) == [
        "缺少必填参数 order_number：订单号，形如 ORD-1042，从 webapp_find_orders 的结果里原样复制，不要自己编"]
    assert validate(REFUND_SCHEMA, {"order_number": "ORD-1042", "reason": "damaged", "amount_yuan": "99"}) == [
        "amount_yuan 应为 number，收到 \"99\""]
    assert validate(REFUND_SCHEMA, {"order_number": "ORD-1042", "reason": "damaged", "amount_yuan": 0}) == [
        "amount_yuan=0 超出范围 [0.01, 100000]"]
    assert validate(REFUND_SCHEMA, {"order_number": "ORD-1042", "reason": "damaged"}) == []


def test_good_tool_refuses_invalid_args_without_side_effects():
    with pytest.raises(ToolError) as e:
        GOOD_HANDLERS["webapp_refund_order"](order_number="1042", reason="damaged")
    msg = str(e.value)
    assert msg.startswith("参数有误，这次没有执行：")
    assert "ORD-1042" in msg and "webapp_find_orders" in msg  # 告诉它正确格式和下一步该调什么
    assert all(not o["refunds"] for o in ORDERS)  # 校验在前，没有碰后端


def test_good_tool_translates_backend_error_into_next_step():
    with pytest.raises(ToolError) as e:
        GOOD_HANDLERS["webapp_refund_order"](order_number="ORD-0987", reason="damaged")
    msg = str(e.value)
    assert "已过退款期（截至 2026-08-26）" in msg
    assert "不要换参数重试" in msg
    assert "trace" not in msg and "/srv/" not in msg  # 堆栈留给日志，不给模型


def test_bad_tool_leaks_raw_stack_trace():
    with pytest.raises(Exception) as e:
        BAD_HANDLERS["api_post_refunds"](order_id=ORDERS[0]["id"], amount=899, reason="耳机有问题")
    assert "E_REFUND_4003" in str(e.value) and "/srv/payments/refund.js" in str(e.value)


def test_find_orders_concise_detailed_and_pagination():
    concise = find_orders("张伟", query="耳机")
    assert concise.split("\n")[1] == "ORD-1042 · 2026-10-30 · 降噪耳机 Pro ×1 · ¥899.00 · 可退款"
    assert "ord_" not in concise  # 默认不给不透明 ID
    detailed = find_orders("张伟", query="耳机", response_format="detailed")
    assert "内部 ID ord_" in detailed and len(detailed) > len(concise)
    page = find_orders("张伟", limit=2)
    assert page.endswith("还有 4 笔没列出：传 offset=2 看下一页，或加 query 缩小范围。")


# ---------- 两条轨迹 ----------

def test_bad_run_trajectory_and_silent_wrong_amount():
    st = run_agent(FakeAnthropic(bad_script()), TASK, BAD_TOOLS, BAD_HANDLERS, **quiet)
    assert (st.model_calls, st.tool_calls, st.tool_errors) == (6, 5, 2)
    order = next(o for o in ORDERS if o["number"] == "ORD-1042")
    assert order["refunds"][0]["amount_cents"] == 899  # 想退 ¥899，实际退了 ¥8.99，没有任何报错


def test_good_run_is_cheaper_in_context():
    bad = run_agent(FakeAnthropic(bad_script()), TASK, BAD_TOOLS, BAD_HANDLERS, **quiet)
    reset_backend()
    good = run_agent(FakeAnthropic(good_script()), TASK, GOOD_TOOLS, GOOD_HANDLERS, **quiet)
    assert (good.model_calls, good.tool_calls, good.tool_errors) == (4, 3, 1)
    assert good.defs_chars > bad.defs_chars  # 描述写得细，定义更长……
    assert good.result_chars * 10 < bad.result_chars  # ……但结果省下的远多于此
    assert good.context_chars < bad.context_chars
    assert good.results[1]["is_error"] is True
    order = next(o for o in ORDERS if o["number"] == "ORD-1042")
    assert order["refunds"][0]["amount_cents"] == 89900
