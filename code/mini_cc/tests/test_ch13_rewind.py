"""第 13 章：/rewind 回退对话和代码。"""

import json

from mini_cc.cli import App
from mini_cc.model import FakeClient, call, say
from mini_cc.rewind import FileHistory
from mini_cc.ui import BufferUI


def _two_turns(make_app, settings):
    """第 1 轮：新建 a.py；第 2 轮：改 a.py、新建 b.py。"""
    app, client = make_app(
        call("Write", {"file_path": "a.py", "content": "x = 1\n"}), say("建好了"),
        call("Read", {"file_path": "a.py"}),
        call("Edit", {"file_path": "a.py", "old_string": "x = 1", "new_string": "x = 2"}),
        call("Write", {"file_path": "b.py", "content": "y = 1\n"}), say("改好了"))
    app.agent.permissions.set_mode("acceptEdits")
    app.handle_line("建 a.py")
    app.first_turn = json.loads(json.dumps(app.agent.messages))
    app.handle_line("把 x 改成 2，再建 b.py")
    return app, client


def test_file_history_backs_up_once_per_checkpoint(tmp_path):
    proj = tmp_path / "p"
    proj.mkdir()
    f = proj / "f.txt"
    f.write_text("v0")
    h = FileHistory(tmp_path / "fh")
    h.begin("m1", "第一轮")
    h.before_write(f)
    f.write_text("v1")
    h.before_write(f)          # 同一检查点里第二次写：不再备份（要的是「这一轮开始前」的版本）
    f.write_text("v2")
    h.begin("m2", "第二轮")
    h.before_write(proj / "new.txt")   # 写之前不存在 → 记成 None
    (proj / "new.txt").write_text("n")
    assert [c.files for c in h.checkpoints][0][str(f)].endswith("@v1")
    assert h.checkpoints[1].files == {str(proj / "new.txt"): None}
    changes = h.restore("m1")
    assert f.read_text() == "v0" and not (proj / "new.txt").exists()
    assert sorted(a for _, a in changes) == ["deleted", "restored"]
    # 落盘后能读回（/resume 之后照样能回退代码）
    again = FileHistory.load(tmp_path / "fh")
    assert [c.uuid for c in again.checkpoints] == ["m1", "m2"]


def test_rewind_lists_checkpoints(make_app, settings):
    app, _ = _two_turns(make_app, settings)
    app.handle_line("/rewind")
    text = app.ui.text
    assert "1. 建 a.py" in text and "2. 把 x 改成 2，再建 b.py" in text
    assert "改了 2 个文件" in text


def test_rewind_both_restores_code_and_truncates_history(make_app, settings):
    app, client = _two_turns(make_app, settings)
    assert (settings.cwd / "a.py").read_text() == "x = 2\n"
    n_before = len(app.agent.messages)
    app.handle_line("/rewind 2")
    assert (settings.cwd / "a.py").read_text() == "x = 1\n"
    assert not (settings.cwd / "b.py").exists()
    assert len(app.agent.messages) == len(app.first_turn) == 4 < n_before   # 只剩第 1 轮
    assert "原话：把 x 改成 2，再建 b.py" in app.ui.text
    # 回退后历史是原来的前缀：逐字节相同（prompt cache 和 thinking 块都还有效）
    assert app.agent.messages == app.first_turn
    # 回退后文件状态清空：模型得重新 Read 才能改
    assert app.agent.ctx.file_state.paths() == []


def test_rewind_conversation_only_keeps_files(make_app, settings):
    app, _ = _two_turns(make_app, settings)
    app.handle_line("/rewind 2 conversation")
    assert (settings.cwd / "b.py").exists() and app.agent.messages == app.first_turn


def test_rewind_code_only_keeps_conversation(make_app, settings):
    app, _ = _two_turns(make_app, settings)
    n = len(app.agent.messages)
    app.handle_line("/rewind 2 code")
    assert (settings.cwd / "a.py").read_text() == "x = 1\n" and len(app.agent.messages) == n
    assert "b.py" in app.ui.text


def test_session_file_branches_and_resume_follows_new_branch(make_app, settings):
    app, client = _two_turns(make_app, settings)
    sid = app.session.id
    app.handle_line("/rewind 2")
    client.push(say("换个做法"))
    app.handle_line("只把 x 改成 3")
    recs = [json.loads(ln) for ln in app.session.path.read_text().splitlines()]
    msgs = [r for r in recs if r.get("type") in ("user", "assistant")]
    # 文件只追加：废弃分支的记录还在，新消息的 parentUuid 指回分叉点
    new_user = next(r for r in msgs if r["message"]["content"] == "只把 x 改成 3"
                    or "只把 x 改成 3" in json.dumps(r["message"], ensure_ascii=False))
    assert new_user["parentUuid"] == msgs[3]["uuid"]  # 第 1 轮最后一条 assistant
    app2 = App(settings, FakeClient([]), ui=BufferUI())
    app2.resume(sid)
    texts = json.dumps(app2.agent.messages, ensure_ascii=False)
    assert "只把 x 改成 3" in texts and "再建 b.py" not in texts
    assert len(app2.agent.messages) == 6


def test_bash_changes_are_not_tracked(make_app, settings):
    app, _ = make_app(call("Bash", {"command": "echo hi > c.txt"}), say("ok"))
    app.ui.answers = ["1"]
    app.handle_line("用 bash 建 c.txt")
    app.handle_line("/rewind 1 code")
    assert (settings.cwd / "c.txt").exists()
    assert "没有可恢复的文件改动" in app.ui.text


def test_rewind_bad_args(make_app):
    app, _ = make_app(say("hi"))
    app.handle_line("/rewind")
    assert "还没有可回退的检查点" in app.ui.text
    app.handle_line("hello")
    app.handle_line("/rewind 9")
    assert "没有第 9 个检查点" in app.ui.text
    app.handle_line("/rewind 1 everything")
    assert "both / conversation / code" in app.ui.text
