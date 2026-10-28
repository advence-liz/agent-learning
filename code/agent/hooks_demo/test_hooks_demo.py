import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import guard_bash  # noqa: E402
import hook_runner  # noqa: E402
import stop_gate  # noqa: E402


def pre(cmd: str) -> dict:
    return {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}


def test_rm_root_exit2():
    code, out, err = guard_bash.decide(pre("rm -rf /"))
    assert code == 2 and out == "" and "根目录" in err


def test_force_push_json_deny():
    code, out, _ = guard_bash.decide(pre("git push --force"))
    assert code == 0
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_force_with_lease_passes():
    assert guard_bash.decide(pre("git push --force-with-lease")) == (0, "", "")


def test_updated_input():
    _, out, _ = guard_bash.decide(pre("python3 a.py"))
    hso = json.loads(out)["hookSpecificOutput"]
    assert hso["updatedInput"]["command"] == "python3 -I a.py"


def test_stop_gate_loop_guard(tmp_path):
    tp = tmp_path / "t.jsonl"
    tp.write_text("nothing")
    assert stop_gate.decide({"transcript_path": str(tp)})["decision"] == "block"
    assert stop_gate.decide({"transcript_path": str(tp), "stop_hook_active": True}) is None
    tp.write_text("3 passed in 0.1s")
    assert stop_gate.decide({"transcript_path": str(tp)}) is None


def test_runner_end_to_end(monkeypatch):
    monkeypatch.chdir(HERE.parent)
    settings = json.loads((HERE / "demo_settings.json").read_text())
    v = hook_runner.dispatch(settings, pre("rm -rf /"))
    assert v.blocked and v.permission == "deny"
    v = hook_runner.dispatch(settings, {"hook_event_name": "SessionStart"})
    assert v.context == ["本仓库：先跑 uv run pytest 再交付"]
    # matcher 不命中：Edit 不触发 Bash 守卫
    v = hook_runner.dispatch(settings, {"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {}})
    assert not v.blocked and v.log == []
