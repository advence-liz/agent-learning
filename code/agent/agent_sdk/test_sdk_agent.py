import anyio

from agent_sdk.demo import SCRIPT, main
from agent_sdk.fake_cli import FakeCLITransport
from agent_sdk.sdk_agent import make_options, run


def _wire(t: FakeCLITransport, kind: str):
    return [m for d, m in t.wire if m["type"] == "control_request" and m["request"]["subtype"] == kind]


def test_hook_denies_dangerous_bash(capsys):
    t = anyio.run(main, False)
    out = capsys.readouterr().out
    assert "✘ 禁止执行危险命令：rm -rf build" in out
    # hook 只对 Bash 触发两次（matcher="Bash"），MCP 工具不触发
    assert [r["request"]["input"]["tool_name"] for r in _wire(t, "hook_callback")] == ["Bash", "Bash"]


def test_sdk_mcp_tool_called_in_process(capsys):
    t = anyio.run(main, False)
    methods = [r["request"]["message"]["method"] for r in _wire(t, "mcp_message")]
    assert methods == ["initialize", "notifications/initialized", "tools/call"]
    assert "*.md 中共有" in capsys.readouterr().out


def test_options_shape():
    o = make_options("/tmp")
    assert o.model == "claude-opus-5-5"
    assert "mcp__proj__count_todos" in o.allowed_tools
    assert o.hooks["PreToolUse"][0].matcher == "Bash"


def test_result_message():
    async def go():
        return await run("hi", ".", transport=FakeCLITransport([{"text": "hello"}]))

    r = anyio.run(go)
    assert r.num_turns == 1 and r.result == "hello" and not r.is_error
