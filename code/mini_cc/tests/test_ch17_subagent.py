"""第 17 章：Sub Agent。"""

import json

from mini_cc.model import FakeClient, call, say


def _agent(prompt, kind="Explore", desc="找分页逻辑", bg=False):
    args = {"description": desc, "prompt": prompt, "subagent_type": kind}
    if bg:
        args["run_in_background"] = True
    return call("Agent", args)


def test_foreground_explore_runs_in_its_own_context(make_app, settings):
    (settings.cwd / "posts.py").write_text("def list_posts(posts):\n    return posts\n")
    app, client = make_app(
        _agent("在项目里找到 list_posts 的定义，回答文件和行号"),
        call("Bash", {"command": "grep -n list_posts posts.py"}),   # ← 子 agent 的第 1 步
        say("posts.py:1 定义了 list_posts"),                          # ← 子 agent 的结论
        say("在 posts.py 第 1 行"))                                   # ← 父 agent 继续
    app.handle_line("list_posts 定义在哪？我之前说过别动 utils 目录")
    child_first = client.requests[1]
    # 子 agent 看不到父历史：第一条消息就是委派的 prompt
    assert len(child_first.messages) == 1
    assert "在项目里找到 list_posts" in json.dumps(child_first.messages, ensure_ascii=False)
    assert "别动 utils" not in json.dumps(child_first.messages, ensure_ascii=False)
    # 子 agent 有自己的 system 和工具子集
    sys_text = "\n".join(b["text"] for b in child_first.system)
    assert "read-only" in sys_text and "# Memory" not in sys_text
    assert sorted(t["name"] for t in child_first.tools) == ["Bash", "Read"]
    # 父亲只拿到结论（外加一行统计），子 agent 的 grep 输出不进父历史
    result = client.requests[3].messages[-1]["content"][0]["content"]
    assert result.startswith("posts.py:1 定义了 list_posts") and "1 tool use" in result
    assert "grep -n" not in json.dumps(app.agent.messages, ensure_ascii=False)
    assert "⎿ Explore: Bash(grep -n list_posts posts.py)" in app.ui.text   # 进度实时显示给人看


def test_explore_cannot_write(make_app, settings):
    app, client = make_app(
        _agent("顺手建个文件"),
        call("Bash", {"command": "touch x.txt"}),
        say("我是只读的，没建"),
        say("ok"))
    app.agent.permissions.set_mode("bypassPermissions")   # 父亲 bypass 也不能让 Explore 写文件
    app.handle_line("探索一下")
    assert not (settings.cwd / "x.txt").exists()
    denied = client.requests[2].messages[-1]["content"][0]
    assert denied["is_error"] and "read-only" in denied["content"]


def test_general_purpose_has_tools_but_no_recursion(make_app):
    app, client = make_app(_agent("干活", kind="general-purpose"), say("干完了"), say("ok"))
    app.handle_line("派个通用 agent")
    names = {t["name"] for t in client.requests[1].tools}
    assert {"Read", "Write", "Edit", "Bash"} <= names
    assert not names & {"Agent", "AskUserQuestion", "TaskCreate", "Memory", "TaskStop", "Monitor"}


def test_unknown_type_lists_available(make_app):
    app, client = make_app(_agent("x", kind="Nope"), say("ok"))
    app.handle_line("派")
    r = client.requests[1].messages[-1]["content"][0]
    assert r["is_error"] and "Explore" in r["content"] and "general-purpose" in r["content"]


def test_background_agent_notifies_with_result(make_app):
    app, client = make_app(_agent("查一下", bg=True), say("已派出，先干别的"), say("子 agent 说在 posts.py"))
    sub = FakeClient([say("结论：posts.py 第 1 行")])
    app.subagent_client = lambda desc: sub          # 后台 agent 跑在另一个线程，用自己的剧本
    app.handle_line("后台派一个 Explore")
    first = client.requests[1].messages[-1]["content"][0]["content"]
    assert first.startswith("Async agent launched successfully") and "a1" in first
    app.jobs.get("a1").wait(5)
    assert app.wake_if_idle()
    sent = json.dumps(client.requests[2].messages[-1], ensure_ascii=False)
    assert "<task-notification>" in sent and "<result>" in sent and "结论：posts.py 第 1 行" in sent
    assert 'Agent \\"找分页逻辑\\" completed' in sent


def test_custom_agent_definition(make_app, settings):
    d = settings.cwd / ".mini_cc" / "agents"
    d.mkdir(parents=True)
    (d / "reviewer.md").write_text("---\nname: reviewer\ndescription: 审查改动，只给意见\ntools: Read\n---\n"
                                   "你是代码审查员，只读代码，按严重度列问题。\n")
    app, client = make_app(_agent("审一下 posts.py", kind="reviewer"), say("没问题"), say("ok"))
    app.handle_line("派 reviewer")
    agent_tool = next(t for t in client.requests[0].tools if t["name"] == "Agent")
    assert "reviewer: 审查改动，只给意见" in agent_tool["description"]
    child = client.requests[1]
    assert [t["name"] for t in child.tools] == ["Read"]
    assert "你是代码审查员" in "\n".join(b["text"] for b in child.system)


def test_transcript_is_saved_as_sidechain(make_app):
    app, _ = make_app(_agent("查"), say("结论"), say("ok"))
    app.handle_line("派")
    files = list((app.session.path.parent / app.session.id / "subagents").glob("agent-*.jsonl"))
    assert len(files) == 1
    recs = [json.loads(ln) for ln in files[0].read_text().splitlines()]
    assert all(r["isSidechain"] and r["agentId"] == "a1" for r in recs)
    assert [r["type"] for r in recs] == ["user", "assistant"]


def test_max_turns_gives_partial_result(make_app):
    app, client = make_app(_agent("一直查"), *[call("Bash", {"command": "true"}) for _ in range(3)], say("ok"))
    app.subagent_max_turns = 3
    app.handle_line("派")
    r = client.requests[4].messages[-1]["content"][0]["content"]
    assert r.startswith("[partial]")
