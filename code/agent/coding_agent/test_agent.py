from pathlib import Path

import pytest

from coding_agent import demo
from coding_agent.agent import make_tools, run_agent
from fake_llm import FakeAnthropic, text, tool_use


def test_agent_fixes_bug(tmp_path: Path):
    demo.setup(tmp_path)
    client = FakeAnthropic(demo.script())
    final = run_agent(client, "修好测试", tmp_path, log=lambda s: None)

    assert (tmp_path / "calc.py").read_text() == demo.FIXED
    assert "通过" in final
    assert len(client.calls) == 5  # 4 次工具轮 + 1 次总结

    # 第一次工具结果是失败的测试输出，它被真实地喂回了模型
    first_result = client.calls[1]["messages"][2]["content"][0]
    assert first_result["type"] == "tool_result"
    assert "AssertionError" in first_result["content"]
    # 最后一次工具结果是测试通过
    last_result = client.calls[4]["messages"][-1]["content"][0]
    assert "exit=0" in last_result["content"] and "ok" in last_result["content"]


def test_tool_error_is_reported_not_raised(tmp_path: Path):
    client = FakeAnthropic([tool_use("read_file", {"path": "nope.txt"}), text("文件不存在")])
    run_agent(client, "读 nope.txt", tmp_path, log=lambda s: None)
    result = client.calls[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True
    assert "FileNotFoundError" in result["content"]


def test_path_escape_blocked(tmp_path: Path):
    tools = make_tools(tmp_path)
    with pytest.raises(ValueError):
        tools["read_file"]("../../etc/passwd")


def test_max_turns_stops_runaway_loop(tmp_path: Path):
    client = FakeAnthropic([tool_use("run_command", {"command": "true"}) for _ in range(3)])
    out = run_agent(client, "x", tmp_path, max_turns=3, log=lambda s: None)
    assert "max_turns" in out
