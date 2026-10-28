"""第 4 章：JSONL 持久化 + /resume。"""

import json

from mini_cc.model import FakeTurn, call, say, tool_block
from mini_cc.session import SessionStore, project_slug

from .conftest import without_session_context


def _lines(path):
    return [json.loads(l) for l in path.read_text().splitlines()]


def test_slug_matches_claude_code_style(tmp_path):
    assert project_slug(tmp_path / "my.proj") .endswith("-my-proj")
    assert "/" not in project_slug(tmp_path)


def test_each_message_appended_immediately(make_app):
    app, _ = make_app(call("Bash", {"command": "echo hi"}), say("done"))
    assert not app.session.path.exists()  # 第一条消息之前不建文件
    app.handle_line("跑一下")
    recs = _lines(app.session.path)
    assert [r["type"] for r in recs] == ["user", "assistant", "user", "assistant"]
    # parentUuid 串成一条链（第 13 章 rewind 靠它）
    assert recs[0]["parentUuid"] is None
    assert all(recs[i]["parentUuid"] == recs[i - 1]["uuid"] for i in range(1, 4))
    assert recs[1]["usage"]["input_tokens"] == 100
    assert recs[2]["message"]["content"][0]["type"] == "tool_result"


def test_resume_restores_history_and_continues_same_file(make_app, settings):
    app, _ = make_app(say("记住了，42"))
    app.handle_line("记住数字 42")
    sid, path = app.session.id, app.session.path

    # 「重启进程」：新的 App，同一个 home/cwd
    app2, client2 = make_app(say("你让我记的是 42"))
    app2.handle_line("/resume")
    assert "记住数字 42" in app2.ui.text
    app2.handle_line("/resume 1")
    assert app2.session.id == sid
    app2.handle_line("我让你记的是几？")
    # 模型收到了完整历史
    sent = client2.requests[0].messages
    assert without_session_context(sent[0]["content"]) == "记住数字 42" and sent[1]["role"] == "assistant"
    # 新消息追加在同一个文件上
    assert len(_lines(path)) == 4
    # usage 也从文件里恢复了
    assert app2.agent.usage.requests == 2


def test_new_keeps_old_session_on_disk(make_app):
    app, _ = make_app(say("a"), say("b"))
    app.handle_line("第一个会话")
    first = app.session.path
    app.handle_line("/new")
    app.handle_line("第二个会话")
    assert first.exists() and app.session.path != first
    titles = [i.title for i in app.store.list()]
    assert set(titles) == {"第一个会话", "第二个会话"}


def test_truncated_last_line_is_tolerated(make_app):
    app, _ = make_app(say("ok"))
    app.handle_line("hi")
    with app.session.path.open("a") as f:
        f.write('{"type": "assistant", "mess')  # 进程被杀时写了半行
    _, msgs, _ = app.store.load(app.session.id)
    assert len(msgs) == 2


def test_resume_repairs_dangling_tool_use(settings):
    store = SessionStore(settings.home, settings.cwd)
    s = store.new()
    s.record({"role": "user", "content": "go"})
    s.record({"role": "assistant", "content": [tool_block("Bash", {"command": "sleep 99"}, id="t1")]})
    from mini_cc.cli import App
    from mini_cc.model import FakeClient
    from mini_cc.ui import BufferUI
    app = App(settings, FakeClient([]), ui=BufferUI())
    app.resume(s.id)
    last = app.agent.messages[-1]
    assert last["content"][0]["tool_use_id"] == "t1" and last["content"][0]["is_error"]
    assert len(store.read_records(s.path)) == 3  # 修复记录也落盘了


def test_resolve_by_prefix_and_errors(make_app):
    app, _ = make_app(say("a"))
    app.handle_line("x")
    assert app.store.resolve(app.session.id[:6]) == app.session.id
    app.handle_line("/resume zzzz")
    assert "没有会话匹配" in app.ui.text
