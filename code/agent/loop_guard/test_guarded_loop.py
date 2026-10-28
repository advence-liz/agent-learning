from fake_llm import FakeAnthropic, text, tool_use
from loop_guard.guarded_loop import (ABORTED, TOOLS, RunResult, add_user_text, dangling_tool_uses,
                                     demo_interrupt, run_guarded)

quiet = {"log": lambda _: None}
search = {"search_logs": lambda query: "hit"}


def start(task="x"):
    return [{"role": "user", "content": task}]


def test_end_turn_without_extra_call():
    client = FakeAnthropic([tool_use("search_logs", {"query": "a"}), text("好了")])
    r = run_guarded(client, start(), TOOLS, search, **quiet)
    assert r == RunResult("好了", "end_turn", 2)
    assert len(client.calls) == 2


def test_max_iterations_wraps_up_with_tools_disabled():
    step = tool_use("search_logs", {"query": "a"})
    client = FakeAnthropic([step, step, text("总结")])
    r = run_guarded(client, start(), TOOLS, search, max_turns=2, **quiet)
    assert r == RunResult("总结", "max_iterations", 2)
    last = client.calls[-1]
    assert last["tool_choice"] == {"type": "none"}
    assert last["tools"], "历史里有 tool_use，工具定义要保留"
    # 收口提示和最后一组 tool_result 在同一条 user 消息里
    tail = last["messages"][-1]["content"]
    assert [b["type"] for b in tail] == ["tool_result", "text"]
    assert "迭代上限 2" in tail[1]["text"]


def test_soft_budget_only_blocks_next_turn():
    clock = {"t": 0.0}

    def search_logs(query):
        clock["t"] = 60.0  # 这圈的工具执行中时间用完了
        return "hit"

    client = FakeAnthropic([tool_use("search_logs", {"query": "a"}), text("总结")])
    r = run_guarded(client, start(), TOOLS, {"search_logs": search_logs},
                    soft_budget_s=30, now=lambda: clock["t"], **quiet)
    assert r.stop == "soft_budget"
    assert client.calls[1]["messages"][2]["content"][0]["content"] == "hit"  # 已发出的工具调用没被丢弃


def test_interrupt_patches_unexecuted_tool_calls(capsys):
    first, second, messages, _ = demo_interrupt()
    assert first.stop == "interrupted" and second.stop == "end_turn"
    assert dangling_tool_uses(messages) == []
    results = messages[2]["content"]
    assert results[0]["content"] == "120 passed, 0 failed"
    assert (results[1]["content"], results[1]["is_error"]) == (ABORTED, True)
    # 用户的补充并进了同一条 user 消息，没有出现两条连续的 user
    assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant"]


def test_dangling_detects_missing_results():
    msgs = [
        {"role": "user", "content": "x"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "run_tests", "input": {}}]},
    ]
    assert dangling_tool_uses(msgs) == ["t1"]
    add_user_text(msgs, "继续")
    assert dangling_tool_uses(msgs) == ["t1"]  # 只补文字不补 tool_result，仍然缺
