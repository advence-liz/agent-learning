from cost_routing.budget import SUMMARY, demo_script, run_budgeted
from cost_routing.meter import Budget, CostMeter
from fake_llm import FakeAnthropic

quiet = {"log": lambda _: None}
tool = lambda name, args: "hit"  # noqa: E731


def test_finishes_normally_under_budget():
    meter = CostMeter()
    r = run_budgeted(FakeAnthropic(demo_script(1)), "x", tool, meter=meter,
                     budget=Budget(soft_usd=10, hard_usd=20), tenant="a", **quiet)
    assert (r.stop, r.turns, r.answer) == ("end_turn", 2, SUMMARY)


def test_soft_budget_wraps_up_with_tools_disabled():
    client, meter = FakeAnthropic(demo_script(20)), CostMeter()
    r = run_budgeted(client, "x", tool, meter=meter, budget=Budget(soft_usd=0.30, hard_usd=0.80), tenant="a", **quiet)
    assert r.stop == "budget_soft" and r.answer == SUMMARY
    last = client.calls[-1]
    assert last["tool_choice"] == {"type": "none"}
    tail = last["messages"][-1]["content"]
    assert [b["type"] for b in tail] == ["tool_result", "text"]  # 收口提示并进最后一组 tool_result
    # 软上限只拦「再开一圈」：最终花费会超过软上限，但不超过硬上限
    assert 0.30 < r.usd <= 0.80


def test_hard_budget_stops_without_calling_again():
    client, meter = FakeAnthropic(demo_script(20)), CostMeter()
    r = run_budgeted(client, "x", tool, meter=meter, budget=Budget(soft_usd=0.30, hard_usd=0.50), tenant="a", **quiet)
    assert r.stop == "budget_hard"
    assert all("tool_choice" not in c for c in client.calls)  # 连收口都没调
    assert r.usd <= 0.50


def test_budget_is_per_tenant():
    meter = CostMeter()
    budget = Budget(soft_usd=0.15, hard_usd=10)
    a = run_budgeted(FakeAnthropic(demo_script(20)), "x", tool, meter=meter, budget=budget, tenant="a", **quiet)
    assert a.stop == "budget_soft" and meter.spent("a") > 0.15
    # 同一个 meter，但 b 只看自己花了多少：a 超支不影响 b 跑完
    b = run_budgeted(FakeAnthropic(demo_script(1)), "x", tool, meter=meter, budget=budget, tenant="b", **quiet)
    assert (b.stop, b.turns) == ("end_turn", 2)
    assert meter.spent() == meter.spent("a") + meter.spent("b")
