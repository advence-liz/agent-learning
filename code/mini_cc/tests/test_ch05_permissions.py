"""第 5 章：权限模式与审批。"""

import pytest

from mini_cc.events import PermissionDecision, TurnEnd
from mini_cc.model import call, calls, say
from mini_cc.permissions import ACCEPT_EDITS, BYPASS, DEFAULT, Decision, PermissionManager
from mini_cc.tools import default_tools
from mini_cc.tools.bash import is_read_only


@pytest.fixture
def tools():
    return {t.name: t for t in default_tools()}


@pytest.mark.parametrize("cmd,ro", [
    ("ls -la", True), ("git status && git diff", True), ("cat a.txt | grep x | wc -l", True),
    ("npm test", False), ("ls > out.txt", False), ("echo $(rm x)", False), ("find . -delete", False),
    ("git push", False), ("sleep 1 &", False),
])
def test_read_only_bash_classifier(cmd, ro):
    assert is_read_only(cmd) is ro


def test_decision_table(tools, tmp_path):
    pm = PermissionManager(tmp_path)
    bash, write, read = tools["Bash"], tools["Write"], tools["Read"]
    assert pm.decide(read, {"file_path": "x"}).behavior == "allow"
    assert pm.decide(bash, {"command": "ls"}).behavior == "allow"
    assert pm.decide(bash, {"command": "npm test"}).behavior == "ask"
    assert pm.decide(write, {"file_path": "a.txt", "content": ""}).behavior == "ask"
    pm.set_mode(ACCEPT_EDITS)
    assert pm.decide(write, {"file_path": "a.txt", "content": ""}).behavior == "allow"
    # acceptEdits 只放行项目目录内的编辑
    assert pm.decide(write, {"file_path": "/etc/hosts", "content": ""}).behavior == "ask"
    assert pm.decide(write, {"file_path": "../outside.txt", "content": ""}).behavior == "ask"
    assert pm.decide(bash, {"command": "npm test"}).behavior == "ask"
    pm.set_mode(BYPASS)
    assert pm.decide(bash, {"command": "rm -rf /"}).behavior == "allow"
    pm.set_mode(DEFAULT)
    pm.deny_rules.add("Bash(rm -rf build)")
    assert pm.decide(bash, {"command": "rm -rf build"}).behavior == "deny"


def test_dangerous_command_asks_even_with_allow_rule(tools, tmp_path):
    pm = PermissionManager(tmp_path, mode=ACCEPT_EDITS, allow_rules={"Bash"})
    assert pm.decide(tools["Bash"], {"command": "sudo rm -rf /"}).behavior == "ask"


def test_extra_check_hook_runs_first(tools, tmp_path):
    pm = PermissionManager(tmp_path, mode=BYPASS)
    pm.extra_checks.append(lambda t, a, m: Decision("deny", "frozen", "check") if t.kind == "edit" else None)
    assert pm.decide(tools["Write"], {"file_path": "a", "content": ""}).behavior == "deny"
    assert pm.decide(tools["Bash"], {"command": "npm test"}).behavior == "allow"


def test_mode_cycle(tmp_path):
    pm = PermissionManager(tmp_path, cycle=[DEFAULT, ACCEPT_EDITS])  # 第 5 章时的循环；第 6 章起默认多了 auto
    seen = []
    pm.on_mode_change.append(lambda old, new: seen.append(new))
    assert [pm.next_mode(), pm.next_mode()] == [ACCEPT_EDITS, DEFAULT]
    assert seen == [ACCEPT_EDITS, DEFAULT]


# ---------------------------------------------------------------- 循环里的审批

def test_user_approves_once(make_app):
    app, client = make_app(call("Bash", {"command": "echo ok > f.txt"}), say("写好了"))
    app.ui.answers = ["1"]
    app.handle_line("写个文件")
    assert "是否允许 Bash(echo ok > f.txt)？" in app.ui.text
    assert (app.settings.cwd / "f.txt").read_text().strip() == "ok"


def test_always_remembers_rule(make_app):
    cmd = {"command": "echo hi > a.txt"}
    app, _ = make_app(call("Bash", cmd), say("1"), call("Bash", cmd), say("2"))
    app.ui.answers = ["2"]
    app.handle_line("第一次")
    n_prompts = app.ui.text.count("是否允许")
    app.handle_line("第二次")
    assert app.ui.text.count("是否允许") == n_prompts == 1
    assert "Bash(echo hi > a.txt)" in app.agent.permissions.allow_rules


def test_deny_with_feedback_continues(make_app):
    app, client = make_app(call("Bash", {"command": "rm -rf build"}), say("好的，改用 make clean"))
    app.ui.answers = ["3", "别删 build，用 make clean"]
    app.handle_line("清理一下")
    result = client.requests[1].messages[-1]["content"][0]
    assert result["is_error"] and "NOT executed" in result["content"]
    assert "别删 build，用 make clean" in result["content"]
    assert "好的，改用 make clean" in app.ui.text


def test_deny_without_feedback_stops_turn_and_skips_rest(make_app):
    app, client = make_app(calls(("Bash", {"command": "touch a"}), ("Bash", {"command": "touch b"})))
    app.ui.answers = ["3", ""]
    evs = list(app.agent.run_turn("建两个文件"))
    assert evs[-1] == TurnEnd("denied", "")
    assert len(client.requests) == 1  # 没有再请求模型：等用户发话
    results = app.agent.messages[-1]["content"]
    assert "STOP" in results[0]["content"] and "Skipped" in results[1]["content"]
    assert not (app.settings.cwd / "a").exists() and not (app.settings.cwd / "b").exists()


def test_deny_rule_event(make_app):
    app, _ = make_app(call("Bash", {"command": "git push"}), say("那我不推了"))
    app.agent.permissions.deny_rules.add("Bash(git push)")
    evs = list(app.agent.run_turn("推一下"))
    assert any(isinstance(e, PermissionDecision) and e.behavior == "deny" and e.source == "rule" for e in evs)


def test_no_approver_means_deny(make_app):
    app, _ = make_app(call("Write", {"file_path": "x.txt", "content": "x"}))
    app.agent.approver = None
    list(app.agent.run_turn("写"))
    assert not (app.settings.cwd / "x.txt").exists()


def test_mode_command_and_record(make_app):
    app, _ = make_app(say("ok"))
    app.handle_line("hi")
    app.handle_line("/mode acceptEdits")
    assert app.agent.permissions.mode == ACCEPT_EDITS
    recs = app.store.read_records(app.session.path)
    assert recs[-1] == {"type": "permission-mode", "permissionMode": "acceptEdits", "sessionId": app.session.id}
    app.handle_line("/mode yolo")
    assert "unknown mode" in app.ui.text
