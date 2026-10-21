"""第 1 章：命令系统 + 最小 agent 循环。"""

from mini_cc.cli import EXIT
from mini_cc.model import call, say


def test_plain_text_goes_to_model(make_app):
    app, client = make_app(say("你好，我是 mini-cc"))
    app.handle_line("hi")
    assert "你好，我是 mini-cc" in app.ui.text
    assert client.requests[0].messages[0] == {"role": "user", "content": "hi"}


def test_tool_loop_runs_bash_and_feeds_result_back(make_app):
    app, client = make_app(call("Bash", {"command": "echo hello"}), say("命令输出了 hello"))
    app.handle_line("跑一下 echo")
    # 第二次请求里，最后一条是 tool_result
    last = client.requests[1].messages[-1]
    assert last["role"] == "user"
    assert last["content"][0]["type"] == "tool_result"
    assert "hello" in last["content"][0]["content"]
    assert "⏺ Bash(echo hello)" in app.ui.text


def test_slash_command_does_not_hit_model(make_app):
    app, client = make_app()
    app.handle_line("/help")
    assert client.requests == []
    assert "/status" in app.ui.text and "/new" in app.ui.text


def test_new_clears_history(make_app):
    app, _ = make_app(say("ok"))
    app.handle_line("记住 42")
    assert len(app.agent.messages) == 2
    app.handle_line("/new")
    assert app.agent.messages == []


def test_alias_and_exit(make_app):
    app, _ = make_app()
    assert app.handle_line("/quit") == EXIT
    assert app.handle_line("/clear") is None


def test_unknown_command_suggests_closest(make_app):
    app, _ = make_app()
    app.handle_line("/stauts")
    assert "/status" in app.ui.text


def test_status_reports_usage(make_app):
    app, _ = make_app(say("ok"))
    app.handle_line("hi")
    app.handle_line("/status")
    assert "messages  2" in app.ui.text
    assert "100 tokens" in app.ui.text


def test_model_switch(make_app):
    app, _ = make_app()
    app.handle_line("/model claude-sonnet-5-5")
    assert app.settings.model == "claude-sonnet-5-5"
