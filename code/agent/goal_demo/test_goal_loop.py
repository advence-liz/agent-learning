import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))

from goal_loop import Turn, keyword_judge, make_llm_judge, run_goal, scripted_worker  # noqa: E402


def test_achieved_with_background_skip():
    w = scripted_worker([
        Turn("2 failed", 1),
        Turn("bg", 1, background_running=True),
        Turn("0 failed", 1),
        Turn("lint clean", 1),
    ])
    r = run_goal("cond", w, keyword_judge)
    assert r.outcome == "achieved" and r.turns == 4 and r.evaluations == 3


def test_stalled_when_no_tool_use():
    w = scripted_worker([Turn("我觉得已经好了", 0)] * 5)
    r = run_goal("cond", w, keyword_judge)
    assert r.outcome == "stalled" and r.evaluations == 2


def test_impossible():
    r = run_goal("cond", scripted_worker([Turn("测试库无法访问", 1)]), keyword_judge)
    assert r.outcome == "impossible"


def test_llm_judge_with_fake_client():
    calls = []

    class FakeMessages:
        def create(self, **kw):
            calls.append(kw)
            return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps({"status": "met", "reason": "ok"}))])

    judge = make_llm_judge(SimpleNamespace(messages=FakeMessages()))
    v = judge("cond", [{"role": "assistant", "content": "0 failed"}])
    assert v.status == "met"
    assert "tools" not in calls[0]  # 评审不给工具
    assert calls[0]["output_config"]["format"]["type"] == "json_schema"
