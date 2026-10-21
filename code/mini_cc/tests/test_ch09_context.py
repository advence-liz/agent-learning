"""第 9 章：上下文组装与注入。"""

import subprocess
import threading
from datetime import date

from mini_cc.context import date_provider, find_instruction_files
from mini_cc.events import ContextInjected
from mini_cc.model import AnthropicClient, ModelRequest, call, say

from .sdk_stub import StubSDK, text_stream


def _reminders(msg):
    c = msg["content"]
    return [b["text"] for b in c if b.get("text", "").startswith("<system-reminder>")] if isinstance(c, list) else []


def test_system_prompt_is_stable_and_cached(make_app):
    app, client = make_app(call("Bash", {"command": "true"}), say("ok"))
    list(app.agent.run_turn("hi"))
    s1, s2 = client.requests[0].system, client.requests[1].system
    assert s1 == s2  # 同一会话内逐字节相同 → prompt cache 能命中
    assert s1[-1]["cache_control"] == {"type": "ephemeral"}
    assert "# Environment" in s1[-1]["text"] and str(app.settings.cwd) in s1[-1]["text"]
    assert "Today's date" not in s1[0]["text"] + s1[-1]["text"]  # 会变的东西不进 system
    assert client.requests[0].cache is True


def test_adapter_sends_top_level_cache_control():
    sdk = StubSDK([text_stream("ok")])
    c = AnthropicClient("claude-opus-5-5", sdk_client=sdk, fallbacks=False)
    list(c.stream(ModelRequest(system=[], messages=[], cache=True)))
    assert sdk.calls[0]["cache_control"] == {"type": "ephemeral"}


def test_instructions_injected_once_in_first_user_message(make_app):
    app, client = make_app(say("一"), say("二"))
    (app.settings.cwd / "AGENTS.md").write_text("变量名必须用 snake_case")
    app.handle_line("第一句")
    app.handle_line("第二句")
    first, third = client.requests[1].messages[0], client.requests[1].messages[2]
    assert any("变量名必须用 snake_case" in r for r in _reminders(first))
    assert not any("# Project instructions" in r for r in _reminders(third))
    assert "◇ system  项目说明 1 个文件" in app.ui.text


def test_instruction_file_order(tmp_path):
    repo = tmp_path / "repo"
    sub = repo / "pkg" / "web"
    sub.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / "AGENTS.md").write_text("root")
    (repo / "pkg" / "CLAUDE.md").write_text("pkg")
    (sub / "AGENTS.md").write_text("web")
    home = tmp_path / "home"
    home.mkdir()
    (home / "AGENTS.md").write_text("user")
    got = [p.read_text() for p in find_instruction_files(sub.resolve(), home)]
    assert got == ["user", "root", "pkg", "web"]  # 用户级 → 仓库根 → … → cwd，越近越靠后


def test_new_session_reinjects_and_resume_does_not_duplicate(make_app):
    app, client = make_app(say("a"), say("b"), say("c"))
    app.handle_line("x")
    app.handle_line("/new")
    app.handle_line("y")
    assert any("# Project instructions" in r for r in _reminders(client.requests[1].messages[0]))
    sid = app.session.id
    app.handle_line("/new")
    app.handle_line(f"/resume {sid[:8]}")
    app.handle_line("z")
    msgs = client.requests[2].messages
    n = sum("# Project instructions" in r for m in msgs if m["role"] == "user" for r in _reminders(m))
    assert n == 1  # 恢复的会话里已经有了，不再重复注入


def test_date_change(make_app):
    app, client = make_app(say("a"), say("b"))
    days = iter([date(2026, 10, 21), date(2026, 10, 22)])
    app.agent.context.providers[1] = date_provider(lambda: next(days))
    app.handle_line("今天")
    app.handle_line("明天了")
    assert any("Today's date is 2026-10-21." in r for r in _reminders(client.requests[0].messages[0]))
    assert any("The date has changed. Today's date is now 2026-10-22." in r
               for r in _reminders(client.requests[1].messages[2]))


def test_external_change_is_reported_with_diff(make_app):
    app, client = make_app(call("Read", {"file_path": "a.py"}), say("读完了"), say("看到你的修改了"))
    f = app.settings.cwd / "a.py"
    f.write_text("x = 1\ny = 2\n")
    app.handle_line("读 a.py")
    f.write_text("x = 1\ny = 3\n")  # 用户在编辑器里改了
    app.handle_line("我刚改了点东西")
    rem = "\n".join(_reminders(client.requests[2].messages[-1]))
    assert "a.py was modified outside of your tools" in rem and "-y = 2" in rem and "+y = 3" in rem
    # 提醒过之后按新内容登记：直接 Edit 不会撞「modified since read」
    assert not app.agent.ctx.file_state.is_stale(f)


def test_own_edits_do_not_trigger_reminder_but_bash_changes_do(make_app):
    app, client = make_app(
        call("Read", {"file_path": "a.py"}),
        call("Edit", {"file_path": "a.py", "old_string": "1", "new_string": "2"}),
        call("Bash", {"command": "echo 'z = 9' >> a.py"}),
        say("done"))
    (app.settings.cwd / "a.py").write_text("x = 1\n")
    app.ui.answers = ["1"]
    app.handle_line("改")
    after_edit = client.requests[2].messages[-1]
    after_bash = client.requests[3].messages[-1]
    assert not any("modified outside" in r for r in _reminders(after_edit))
    # Bash 改的文件也算「外部修改」，提醒跟在 tool_result 后面
    assert after_bash["content"][0]["type"] == "tool_result"
    assert any("+z = 9" in r for r in _reminders(after_bash))


def test_notifications_from_other_threads(make_app):
    app, client = make_app(call("Bash", {"command": "true"}), say("收到通知"))
    t = threading.Thread(target=app.agent.notify, args=("<task-notification>build finished</task-notification>",))
    t.start(); t.join()
    evs = list(app.agent.run_turn("go"))
    assert any(isinstance(e, ContextInjected) and e.kind == "notification" for e in evs)
    assert any("build finished" in r for r in _reminders(client.requests[0].messages[0]))
    assert app.agent.drain_notifications() == []


def test_history_is_append_only(make_app):
    app, client = make_app(call("Bash", {"command": "true"}), call("Bash", {"command": "true"}), say("ok"))
    list(app.agent.run_turn("go"))
    a, b, c = (r.messages for r in client.requests)
    assert b[: len(a)] == a and c[: len(b)] == b  # 每次请求都是上一次的严格前缀扩展


def test_broken_provider_is_skipped(make_app):
    app, _ = make_app(say("ok"))
    app.agent.context.providers.insert(0, lambda st: 1 / 0)
    assert list(app.agent.run_turn("hi"))[-1].stop_reason == "end_turn"


def test_context_command(make_app):
    app, _ = make_app(say("ok"))
    app.handle_line("hi")
    app.handle_line("/context")
    assert "system[0]" in app.ui.text and "<system-reminder> 块" in app.ui.text
