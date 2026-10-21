"""第 21 章：plan 模式（先规划再动手）。"""

import json

from mini_cc.model import call, say
from mini_cc.permissions import ACCEPT_EDITS, AUTO, DEFAULT, PLAN, PermissionManager
from mini_cc.plan_mode import EXIT_HEADER, FULL_HEADER, SPARSE_HEADER


def _plan_app(make_app, *script, answers=()):
    app, client = make_app(*script)
    app.ui.answers = list(answers)
    app.agent.permissions.set_mode(PLAN)
    return app, client


def _reminders(req):
    return [b["text"] for m in req.messages if m["role"] == "user" and isinstance(m["content"], list)
            for b in m["content"] if b.get("type") == "text" and b["text"].startswith("<system-reminder>")]


def test_shift_tab_cycle_includes_plan(tmp_path):
    pm = PermissionManager(tmp_path)
    assert [pm.next_mode() for _ in range(4)] == [ACCEPT_EDITS, PLAN, AUTO, DEFAULT]


def test_plan_mode_blocks_edits_but_allows_plan_file(make_app, settings):
    (settings.cwd / "posts.py").write_text("x = 1\n")
    app, client = _plan_app(
        make_app,
        call("Read", {"file_path": "posts.py"}),
        call("Bash", {"command": "grep -n x posts.py"}),
        call("Edit", {"file_path": "posts.py", "old_string": "x = 1", "new_string": "x = 2"}),
        call("Write", {"file_path": "{PLAN}", "content": "# Plan\n1. 改 x\n"}),
        say("计划写好了"))
    plan = app.plan_file
    client.script[3].content[0]["input"]["file_path"] = str(plan)
    app.handle_line("把 x 改成 2")
    results = [client.requests[i].messages[-1]["content"][0] for i in (1, 2, 3, 4)]
    assert not results[0]["is_error"] and not results[1]["is_error"]          # 读、只读命令照常
    assert results[2]["is_error"] and "plan mode" in results[2]["content"]     # 改源码被拒
    assert str(plan) in results[2]["content"]                                 # 拒绝理由里告诉它该写哪
    assert not results[3]["is_error"] and plan.read_text().startswith("# Plan")
    assert (settings.cwd / "posts.py").read_text() == "x = 1\n"
    assert "是否允许" not in app.ui.text                                       # 写计划文件不用审批


def test_non_readonly_command_asks_even_in_plan(make_app):
    app, client = _plan_app(make_app, call("Bash", {"command": "npm install"}), say("ok"), answers=["3 规划阶段别装依赖"])
    app.handle_line("看看")
    assert "是否允许 Bash(npm install)" in app.ui.text
    assert "别装依赖" in client.requests[1].messages[-1]["content"][0]["content"]


def test_full_then_sparse_then_exit_reminders(make_app):
    app, client = _plan_app(make_app, *[call("Bash", {"command": "true"}) for _ in range(6)], say("ok"), say("好"))
    app.handle_line("规划一下")
    first = _reminders(client.requests[0])
    assert any(FULL_HEADER in r and str(app.plan_file) in r and "ExitPlanMode" in r for r in first)
    sparse = [i for i, req in enumerate(client.requests) if any(SPARSE_HEADER in r for r in _reminders(req))]
    assert sparse and sparse[0] == 5                                           # 每 5 次请求提醒一次精简版
    app.agent.permissions.set_mode(DEFAULT)
    app.handle_line("算了直接改")
    assert any(EXIT_HEADER in r for r in _reminders(client.requests[-1]))
    n = sum(EXIT_HEADER in r for r in _reminders(client.requests[-1]))
    assert n == 1


def test_exit_plan_mode_approved(make_app, settings):
    (settings.cwd / "posts.py").write_text("x = 1\n")
    app, client = _plan_app(
        make_app,
        call("Write", {"file_path": "{PLAN}", "content": "# Plan\n1. 把 x 改成 2\n"}),
        call("ExitPlanMode", {}),
        call("Read", {"file_path": "posts.py"}),
        call("Edit", {"file_path": "posts.py", "old_string": "x = 1", "new_string": "x = 2"}),
        say("改好了"), answers=["1"])
    client.script[0].content[0]["input"]["file_path"] = str(app.plan_file)
    app.handle_line("把 x 改成 2")
    assert "# Plan" in app.ui.text and "1. 批准，之后的编辑自动通过" in app.ui.text
    r = client.requests[2].messages[-1]["content"][0]["content"]
    assert r.startswith("User has approved your plan. You can now start coding.") and "1. 把 x 改成 2" in r
    assert app.agent.permissions.mode == ACCEPT_EDITS
    assert (settings.cwd / "posts.py").read_text() == "x = 2\n"
    recs = [json.loads(ln) for ln in app.session.path.read_text().splitlines()]
    assert [r["permissionMode"] for r in recs if r.get("type") == "permission-mode"][-1] == ACCEPT_EDITS


def test_exit_plan_mode_rejected_keeps_planning(make_app):
    app, client = _plan_app(make_app, call("Write", {"file_path": "{PLAN}", "content": "# Plan\n重写整个模块\n"}),
                            call("ExitPlanMode", {}), say("那我缩小范围"), answers=["3 范围太大，只改分页"])
    client.script[0].content[0]["input"]["file_path"] = str(app.plan_file)
    app.handle_line("规划")
    r = client.requests[2].messages[-1]["content"][0]
    assert "keep planning" in r["content"] and "只改分页" in r["content"]
    assert app.agent.permissions.mode == PLAN


def test_exit_plan_mode_needs_a_plan_file(make_app):
    app, client = _plan_app(make_app, call("ExitPlanMode", {}), say("先写计划"))
    app.handle_line("规划")
    r = client.requests[1].messages[-1]["content"][0]
    assert r["is_error"] and str(app.plan_file) in r["content"]


def test_model_can_enter_plan_mode(make_app):
    app, client = make_app(call("EnterPlanMode", {}), say("我先规划"))
    app.handle_line("这个重构有点大，你看着办")
    assert app.agent.permissions.mode == PLAN
    assert any(FULL_HEADER in r for r in _reminders(client.requests[1]))      # 工具结果里就带上完整规则


def test_subagents_are_read_only_in_plan_mode(make_app, settings):
    app, client = _plan_app(
        make_app,
        call("Agent", {"description": "设计方案", "prompt": "设计分页方案", "subagent_type": "Plan"}),
        call("Bash", {"command": "touch x.txt"}), say("方案：……"), say("ok"))
    app.handle_line("规划")
    assert not (settings.cwd / "x.txt").exists()
    names = {t["name"] for t in client.requests[1].tools}
    assert names == {"Read", "Bash"}


def test_plan_command(make_app):
    app, client = make_app(say("先看看代码"))
    app.handle_line("/plan 给 posts 加分页")
    assert app.agent.permissions.mode == PLAN
    assert any(FULL_HEADER in r for r in _reminders(client.requests[0]))


def test_fake_script_placeholders():
    from mini_cc.model import FakeClient, ModelRequest, complete

    c = FakeClient([call("Write", {"file_path": "{plan_file}", "content": "x"})])
    c.vars["plan_file"] = lambda: "/tmp/p.md"
    done = complete(c, ModelRequest(system=[], messages=[]))
    assert done.content[0]["input"]["file_path"] == "/tmp/p.md"
