"""第 11 章：让 Agent 跟踪多步任务。"""

import json

from mini_cc.events import TasksUpdated
from mini_cc.model import call, calls, say
from mini_cc.tasks import TaskStore, task_reminder_provider


def _plan():
    return calls(("TaskCreate", {"subject": "读路由代码", "activeForm": "读路由代码"}),
                 ("TaskCreate", {"subject": "加分页参数", "activeForm": "加分页参数"}),
                 ("TaskCreate", {"subject": "补测试", "activeForm": "补测试"}), text="拆成三步。")


def test_store_roundtrip(tmp_path):
    p = tmp_path / "s.tasks.json"
    s = TaskStore.load(p)
    s.create("a")
    s.update("1", status="completed")
    s.create("b", active_form="做 b")
    s.update("2", status="in_progress")
    again = TaskStore.load(p)
    assert [t.status for t in again.tasks] == ["completed", "in_progress"]
    assert again.render() == "☒ #1 a\n◼ #2 b  ← 做 b\n(1/2 completed)"
    assert json.loads(p.read_text())[0]["subject"] == "a"


def test_model_builds_and_updates_list(make_app):
    app, client = make_app(
        _plan(),
        call("TaskUpdate", {"taskId": "1", "status": "in_progress"}),
        call("TaskUpdate", {"taskId": "1", "status": "completed"}),
        say("第一步做完了"))
    evs = list(app.agent.run_turn("给 /posts 加分页"))
    updates = [e for e in evs if isinstance(e, TasksUpdated)]
    assert len(updates) == 3  # 一批 3 个 TaskCreate 只显示一次最终清单
    assert updates[-1].rendered.startswith("☒ #1 读路由代码\n☐ #2 加分页参数")
    store = app.agent.ctx.extras["tasks"]
    assert [t.status for t in store.tasks] == ["completed", "pending", "pending"]
    assert "是否允许" not in app.ui.text  # 维护清单不需要审批
    last = client.requests[3].messages[-1]["content"][0]["content"]
    assert "2 task(s) remaining" in last


def test_tasks_persist_with_session_and_survive_resume(make_app):
    app, _ = make_app(_plan(), say("计划好了"))
    app.handle_line("加分页")
    sid = app.session.id
    assert app.session.tasks_path.exists()
    app.handle_line("/new")
    assert app.agent.ctx.extras["tasks"].tasks == []  # 新会话新清单
    app.handle_line(f"/resume {sid[:8]}")
    assert len(app.agent.ctx.extras["tasks"].tasks) == 3
    app.handle_line("/todos")
    assert "☐ #3 补测试" in app.ui.text


def test_reminder_after_gap(make_app):
    steps = [call("Bash", {"command": "true"}) for _ in range(6)]
    app, client = make_app(_plan(), *steps, say("ok"))
    list(app.agent.run_turn("干活"))
    reminders = [i for i, r in enumerate(client.requests)
                 if any("# Task list reminder" in b.get("text", "")
                        for b in (r.messages[-1]["content"] if isinstance(r.messages[-1]["content"], list) else []))]
    # 第 0 次请求建清单；之后连续 6 次没碰清单 → 第 7 次请求（index 7）前注入提醒
    assert reminders == [7]
    text = client.requests[7].messages[-1]["content"][-1]["text"]
    assert "not updated the task list in the last 6 steps" in text and "☐ #1 读路由代码" in text


def test_reminder_when_list_not_visible_in_history(make_app):
    """模拟压缩之后：清单还在，但历史里看不到 → 首条消息就提醒。"""
    app, client = make_app(say("继续"))
    store = app.agent.ctx.extras["tasks"]
    store.create("剩下的一步")
    app.handle_line("我们做到哪了？")
    first = client.requests[0].messages[0]["content"]
    assert any("current task list for this session" in b["text"] for b in first)


def test_no_reminder_when_all_done(make_app):
    app, _ = make_app(say("ok"))
    s = app.agent.ctx.extras["tasks"]
    s.create("x")
    s.update("1", status="completed")
    from mini_cc.context import InjectState
    assert task_reminder_provider()(InjectState(app.agent, "user")) is None


def test_update_unknown_and_double_in_progress(make_app):
    app, client = make_app(
        calls(("TaskCreate", {"subject": "a"}), ("TaskCreate", {"subject": "b"})),
        calls(("TaskUpdate", {"taskId": "1", "status": "in_progress"}),
              ("TaskUpdate", {"taskId": "2", "status": "in_progress"}),
              ("TaskUpdate", {"taskId": "9", "status": "completed"})),
        say("ok"))
    list(app.agent.run_turn("go"))
    results = client.requests[2].messages[-1]["content"]
    assert "#1 also in_progress" in results[1]["content"]
    assert results[2]["is_error"] and "not found" in results[2]["content"]


def test_ui_shows_checklist(make_app):
    app, _ = make_app(_plan(), say("ok"))
    app.handle_line("加分页")
    assert "  ☐ #1 读路由代码" in app.ui.text and "  (0/3 completed)" in app.ui.text
