"""第 2 章：循环变成事件流，模型输出逐步可见。"""

from mini_cc.events import ToolEnd, ToolStart, TurnEnd
from mini_cc.model import AnthropicClient, FakeTurn, ModelRequest, TextDelta, ThinkingDelta, say, text_block, tool_block
from mini_cc.tools import ToolResult
from mini_cc.tools.base import Tool

from .sdk_stub import StubSDK, text_stream


class Probe(Tool):
    name = "Probe"
    input_schema = {"type": "object", "properties": {}}

    def __init__(self):
        self.ran = False

    def run(self, args, ctx):
        self.ran = True
        return ToolResult("probed")


def test_event_order(make_app):
    app, _ = make_app(
        FakeTurn([{"type": "thinking", "thinking": "先看看目录", "signature": "s"},
                  text_block("我先列一下文件。"), tool_block("Bash", {"command": "echo hi"})]),
        say("完成"),
    )
    kinds = [type(e).__name__ for e in app.agent.run_turn("go")]
    # 思考、文本先流出来，然后才是工具，最后是下一轮文本和 TurnEnd
    assert kinds.index("ThinkingDelta") < kinds.index("TextDelta") < kinds.index("ToolStart")
    assert kinds[-1] == "TurnEnd"
    assert kinds.count("ToolStart") == kinds.count("ToolEnd") == 1


def test_deltas_arrive_before_tool_runs(make_app):
    app, _ = make_app(FakeTurn([text_block("马上调用探针"), tool_block("Probe", {})]), say("ok"))
    probe = Probe()
    app.agent.tools.register(probe)
    gen = app.agent.run_turn("go")
    first = next(gen)
    assert isinstance(first, TextDelta)
    assert probe.ran is False  # 生成器是惰性的：文本已经到了，工具还没执行
    rest = list(gen)
    assert probe.ran is True
    assert any(isinstance(e, ToolEnd) and e.result.content == "probed" for e in rest)


def test_intermediate_text_is_shown(make_app):
    """第 1 章的毛病：调工具前那句话丢了。现在它应该出现在 UI 里。"""
    app, _ = make_app(FakeTurn([text_block("我先看看目录。"), tool_block("Bash", {"command": "true"})]), say("看完了"))
    app.handle_line("看目录")
    text = app.ui.text
    assert text.index("● 我先看看目录。") < text.index("⏺ Bash(true)") < text.index("● 看完了")
    assert "✔ Bash -> (no output)" in text


def test_request_asks_for_summarized_thinking(make_app):
    app, client = make_app(say("ok"))
    list(app.agent.run_turn("hi"))
    assert client.requests[0].thinking == {"type": "adaptive", "display": "summarized"}


def test_run_helper_collects(make_app):
    app, _ = make_app(say("hello world"))
    r = app.agent.run("hi")
    assert r.text == "hello world" and isinstance(r.events[-1], TurnEnd)


def test_anthropic_adapter_converts_stream():
    sdk = StubSDK([text_stream("你好世界", thinking="想一下")])
    c = AnthropicClient("claude-opus-5-5", sdk_client=sdk)
    req = ModelRequest(system=[], messages=[{"role": "user", "content": "hi"}],
                       tools=[{"name": "Bash", "description": "", "input_schema": {"type": "object"}}])
    evs = list(c.stream(req))
    assert [type(e).__name__ for e in evs] == ["ThinkingDelta", "TextDelta", "TextDelta", "MessageDone"]
    done = evs[-1]
    assert done.content[-1] == {"type": "text", "text": "你好世界"}
    assert done.content[0]["signature"] == "sig"  # thinking 块原样保留
    kw = sdk.calls[0]
    assert kw["model"] == "claude-opus-5-5"
    assert kw["tools"][0]["eager_input_streaming"] is True
