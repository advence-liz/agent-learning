from core.agent_loop import TOOLS, read_file, run_agent
from fake_llm import FakeAnthropic, text, tool_use


def test_loop_feeds_tool_result_back():
    client = FakeAnthropic([tool_use("read_file", {"path": "apps/web/vitest.config.ts"}), text("15 秒")])
    answer = run_agent(client, "超时多少？", TOOLS, {"read_file": read_file}, log=lambda _: None)
    assert answer == "15 秒"
    second = client.calls[1]["messages"]
    assert [m["role"] for m in second] == ["user", "assistant", "user"]
    result = second[2]["content"][0]
    assert result["type"] == "tool_result" and "testTimeout: 15000" in result["content"]
    assert result["tool_use_id"] == second[1]["content"][0]["id"]


def test_tool_error_goes_back_to_model_instead_of_crashing():
    client = FakeAnthropic([tool_use("read_file", {"path": "nope.ts"}), text("文件不存在")])
    run_agent(client, "读 nope.ts", TOOLS, {"read_file": read_file}, log=lambda _: None)
    result = client.calls[1]["messages"][2]["content"][0]
    assert result["is_error"] is True and "FileNotFoundError" in result["content"]


def test_max_turns_guard():
    client = FakeAnthropic([tool_use("read_file", {"path": "apps/web/vitest.config.ts"})] * 3)
    try:
        run_agent(client, "x", TOOLS, {"read_file": read_file}, max_turns=3, log=lambda _: None)
    except RuntimeError as e:
        assert "3" in str(e)
    else:
        raise AssertionError("应当在 max_turns 后抛错")
