import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import subagent  # noqa: E402


def test_parent_context_much_smaller():
    inline, _ = subagent.scenario_inline()
    parent, child, ps, cs = subagent.scenario_subagent()
    assert parent < inline / 5
    assert child > parent  # 探索的体积留在了子数组里
    assert ps.tool_calls == 1 and cs.tool_calls == 4


def test_child_starts_with_fresh_messages():
    seen = []
    orig = subagent.ScriptedClient.create

    def spy(self, **kw):
        if "子 agent" in kw["system"]:
            seen.append([m["content"] for m in kw["messages"]][:1])
        return orig(self, **kw)

    subagent.ScriptedClient.create = spy
    try:
        subagent.scenario_subagent()
    finally:
        subagent.ScriptedClient.create = orig
    # 子 agent 第一次请求只有一条消息：任务描述；看不到父亲的原始提问
    assert seen[0] == ["在 *_demo 里找 hook exit 2 的处理位置，给文件:行号"]
