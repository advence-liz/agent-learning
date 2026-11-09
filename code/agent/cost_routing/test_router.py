from cost_routing.meter import CostMeter
from cost_routing.router import (HAIKU, OPUS, SONNET, TASKS, check_label, check_location, check_plan, compare,
                                 route_rule, run_cascade, run_fixed, scripted_client)

by_id = {t.id: t for t in TASKS}


def test_rule_routing_table():
    assert route_rule(by_id["t1"]) == HAIKU  # 分类
    assert route_rule(by_id["t4"]) == HAIKU  # 检索词改写
    assert route_rule(by_id["t6"]) == SONNET  # 编码
    assert route_rule(by_id["t7"]) == OPUS  # 规划


def test_validators_are_plain_code():
    assert check_label("bug") and not check_label("这看起来像是一个 bug")
    assert check_location('{"file": "a.ts", "line": 3}') and not check_location('{"file": "a.ts", "line": "3"}')
    assert not check_plan('[{"step": "x"}]')


def test_cascade_stops_at_first_pass():
    client = scripted_client()
    [o] = run_cascade(client, [by_id["t1"]], CostMeter())
    assert o.attempts == [HAIKU] and o.passed
    assert [c["model"] for c in client.calls] == [HAIKU]


def test_cascade_escalates_until_check_passes_and_bills_failed_attempts():
    client, meter = scripted_client(), CostMeter()
    [o] = run_cascade(client, [by_id["t8"]], meter)
    assert o.attempts == [HAIKU, SONNET, OPUS] and o.passed
    assert [c["model"] for c in client.calls] == [HAIKU, SONNET, OPUS]
    # 失败的两次也计费：总价 = 三次之和
    assert len(meter.records) == 3
    assert o.usd == sum(r.usd for r in meter.records)
    assert o.escalated


def test_cascade_can_start_from_rule_choice():
    client = scripted_client()
    [o] = run_cascade(client, [by_id["t7"]], CostMeter(), start=route_rule)
    assert o.attempts == [OPUS]


def test_cascade_gives_up_at_top_of_ladder():
    client = scripted_client()
    [o] = run_cascade(client, [by_id["t8"]], CostMeter(), ladder=[HAIKU, SONNET])
    assert o.attempts == [HAIKU, SONNET] and not o.passed


def test_rule_routing_misses_hard_task():
    [o] = run_fixed(scripted_client(), [by_id["t8"]], CostMeter(), route_rule)
    assert o.attempts == [SONNET] and not o.passed  # 规则按类型选，同是 code，难的那条判轻了


def test_compare_summary():
    result = compare()
    opus, haiku, rule, cascade = (result[k][0] for k in ("全用 Opus", "全用 Haiku", "规则路由", "级联路由"))
    assert opus["passed"] == 8 and cascade["passed"] == 8
    assert rule["passed"] == 6 and haiku["passed"] == 4
    assert cascade["daily_usd"] < 0.2 * opus["daily_usd"]
    # 按调用量算的通过率会掩盖难任务全军覆没：全 Haiku 也有 90% 以上
    assert haiku["pass_rate"] > 0.9
    assert 0 < cascade["escalation_rate"] < 0.1
