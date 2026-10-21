"""第 14 章：compact 压缩上下文。"""

import json

from mini_cc.cli import App
from mini_cc.compact import SUMMARY_HEADER, extract_summary, merge_consecutive_users
from mini_cc.events import Notice
from mini_cc.model import FakeClient, FakeTurn, call, say, text_block
from mini_cc.ui import BufferUI


def summary_turn(text="1. 用户要给 posts 加分页\n2. 已读 posts.py，还没改"):
    return say(f"<summary>\n{text}\n</summary>")


def test_extract_summary_and_merge():
    assert extract_summary("前言 <summary>\nA\n</summary> 尾巴") == "A"
    assert extract_summary("没有标签的摘要") == "没有标签的摘要"
    msgs = [{"role": "user", "content": "s"}, {"role": "user", "content": [text_block("p")]},
            {"role": "assistant", "content": [text_block("a")]}]
    merged = merge_consecutive_users(msgs)
    assert [m["role"] for m in merged] == ["user", "assistant"]
    assert merged[0]["content"] == [text_block("s"), text_block("p")]
    assert msgs[0]["content"] == "s"  # 只合并请求视图，不动历史


def test_manual_compact_replaces_history_with_summary(make_app, settings):
    (settings.cwd / "posts.py").write_text("def list_posts(posts):\n    return posts\n")
    app, client = make_app(call("Read", {"file_path": "posts.py"}), say("读完了"), summary_turn(), say("继续"))
    app.handle_line("看看 posts.py")
    before = list(app.agent.messages)
    app.handle_line("/compact 重点保留分页相关的内容")
    # 摘要请求：同一个 system、同一套工具（prompt cache 前缀能命中），历史 + 末尾一条摘要指令
    req = client.requests[2]
    assert req.system == client.requests[1].system and req.tools == client.requests[1].tools
    assert req.messages[:-1] == before
    ask = req.messages[-1]["content"][-1]["text"]
    assert "<summary>" in ask and "Do not call any tools" in ask and "重点保留分页相关的内容" in ask
    # 压缩后：只剩一条 user 消息（摘要 + 重新挂回的文件 + 重新注入的项目说明）
    assert len(app.agent.messages) == 1
    blob = json.dumps(app.agent.messages[0], ensure_ascii=False)
    assert SUMMARY_HEADER in blob and "用户要给 posts 加分页" in blob
    assert "def list_posts" in blob and "# Project instructions" in blob
    assert "已压缩" in app.ui.text
    # 下一轮：摘要和新提示词在请求里合并成一条 user 消息，user/assistant 交替不被打破
    app.handle_line("开始改吧")
    sent = client.requests[3].messages
    assert [m["role"] for m in sent] == ["user"] and "开始改吧" in json.dumps(sent, ensure_ascii=False)


def test_compact_boundary_in_session_and_resume(make_app, settings):
    app, client = make_app(say("hi"), summary_turn("摘要正文"), say("ok"))
    app.handle_line("你好")
    app.handle_line("/compact")
    recs = [json.loads(ln) for ln in app.session.path.read_text().splitlines()]
    b = next(r for r in recs if r.get("subtype") == "compact_boundary")
    assert b["parentUuid"] is None and b["logicalParentUuid"] and b["compactMetadata"]["trigger"] == "manual"
    app2 = App(settings, FakeClient([]), ui=BufferUI())
    app2.resume(app.session.id)
    assert len(app2.agent.messages) == 1 and "摘要正文" in json.dumps(app2.agent.messages, ensure_ascii=False)
    # 压缩之前的检查点不再能 rewind（那段对话已经不在上下文里）
    assert app.checkpoints() == []


def test_auto_compact_mid_turn(make_app, settings):
    settings.context_window, settings.auto_compact_buffer = 10_000, 2_000
    big = FakeTurn([{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "echo big"}}],
                   usage={"input_tokens": 9_000, "output_tokens": 10})
    app, client = make_app(big, summary_turn("正在跑 echo big"), say("接着干完了"))
    app.ui.answers = ["1"]
    evs = list(app.agent.run_turn("跑一下"))
    notices = [e.text for e in evs if isinstance(e, Notice)]
    assert any("自动压缩" in t for t in notices)
    # 第 3 次请求（压缩后）只带一条 user 消息，并要求模型接着干、不要复述
    last = client.requests[2].messages
    assert len(last) == 1 and "Continue from where you left off" in json.dumps(last, ensure_ascii=False)
    assert evs[-1].text == "接着干完了"
    assert app.agent.usage.last_input < 9_000  # 估算值已经更新，不会立刻又触发


def test_no_auto_compact_below_threshold(make_app):
    app, client = make_app(say("ok"))
    list(app.agent.run_turn("hi"))
    assert len(client.requests) == 1


def test_compact_failure_keeps_history(make_app):
    app, client = make_app(say("hi"), FakeTurn([]), say("ok"))
    app.handle_line("你好")
    n = len(app.agent.messages)
    app.handle_line("/compact")
    assert len(app.agent.messages) == n and "压缩失败" in app.ui.text


def test_file_state_only_keeps_reattached_files(make_app, settings):
    for i in range(7):
        (settings.cwd / f"f{i}.py").write_text(f"x = {i}\n")
    reads = [call("Read", {"file_path": f"f{i}.py"}) for i in range(7)]
    app, client = make_app(*reads, say("读完了"), summary_turn(), say("ok"))
    app.handle_line("把 7 个文件都读一遍")
    app.handle_line("/compact")
    kept = sorted(p.name for p in app.agent.ctx.file_state.paths())
    assert kept == ["f2.py", "f3.py", "f4.py", "f5.py", "f6.py"]  # 最近 5 个：重新挂回上下文，也重新登记
    blob = json.dumps(app.agent.messages[0], ensure_ascii=False)
    assert "x = 6" in blob and "x = 0" not in blob


def test_fake_script_can_set_usage(tmp_path):
    p = tmp_path / "s.json"
    p.write_text(json.dumps([{"say": "hi", "usage": {"input_tokens": 975000}}]))
    turn = FakeClient.from_json(str(p)).script[0]
    assert turn.usage == {"output_tokens": 20, "input_tokens": 975000}
