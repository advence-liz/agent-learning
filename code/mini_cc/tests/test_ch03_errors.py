"""第 3 章：三层错误处理——API 重试、工具两道防线、主循环安全网。"""

import anthropic
import httpx2
import pytest

from mini_cc.events import Notice, ToolEnd, TurnEnd
from mini_cc.model import AnthropicClient, FakeTurn, ModelError, ModelRequest, call, say, text_block, tool_block
from mini_cc.retry import RetryPolicy
from mini_cc.tools import ToolResult
from mini_cc.tools.base import Tool

from .sdk_stub import StubSDK, text_stream

OVERLOADED = ModelError("529 Overloaded", retryable=True, kind="overloaded", status=529)
AUTH = ModelError("401 invalid x-api-key", retryable=False, kind="auth", status=401)


@pytest.fixture
def quiet(make_app):
    def _make(*script):
        app, client = make_app(*script)
        app.agent.slept = []
        app.agent.sleep = app.agent.slept.append
        return app, client
    return _make


# ---------------------------------------------------------------- 第一层：API 重试

def test_retry_then_succeed(quiet):
    app, client = quiet(OVERLOADED, OVERLOADED, say("终于好了"))
    evs = list(app.agent.run_turn("hi"))
    notices = [e for e in evs if isinstance(e, Notice)]
    assert len(notices) == 2 and "第 1/5 次重试" in notices[0].text
    assert evs[-1] == TurnEnd("end_turn", "终于好了")
    assert len(client.requests) == 3 and len(app.agent.slept) == 2


def test_backoff_grows_and_respects_retry_after():
    p = RetryPolicy(max_retries=5, base_delay=1.0, max_delay=30.0)
    d1, d3 = p.delay(1, OVERLOADED), p.delay(3, OVERLOADED)
    assert 1.0 <= d1 < 1.5 and 4.0 <= d3 < 4.5
    assert p.delay(1, ModelError("429", retryable=True, retry_after=7)) == 7


def test_non_retryable_fails_fast_and_repl_survives(quiet):
    app, client = quiet(AUTH, say("key 修好之后的回答"))
    app.handle_line("hi")
    assert "模型请求失败（auth）" in app.ui.text
    assert len(client.requests) == 1  # 401 不重试
    app.handle_line("再试一次")  # 进程还活着，可以继续聊
    assert "key 修好之后的回答" in app.ui.text


def test_gives_up_after_max_retries(quiet):
    app, client = quiet(*[OVERLOADED] * 6)
    evs = list(app.agent.run_turn("hi"))
    assert evs[-1].stop_reason == "error" and len(client.requests) == 6


def test_mid_stream_failure_discards_partial_and_history_stays_clean(quiet):
    broken = FakeTurn([text_block("这句话说到一半")], fail_after=4,
                      fail_with=ModelError("connection reset", retryable=True, kind="network"))
    app, _ = quiet(broken, say("完整的回答"))
    app.handle_line("hi")
    assert "上面的输出不完整，已丢弃" in app.ui.text
    assistant_msgs = [m for m in app.agent.messages if m["role"] == "assistant"]
    assert assistant_msgs == [{"role": "assistant", "content": [text_block("完整的回答")]}]


def test_sdk_errors_are_translated():
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx2.Response(529, request=req, headers={"retry-after": "3"})
    sdk = StubSDK([anthropic.APIStatusError("Overloaded", response=resp, body=None), text_stream("ok")])
    c = AnthropicClient("claude-opus-5-5", sdk_client=sdk)
    r = ModelRequest(system=[], messages=[{"role": "user", "content": "hi"}])
    with pytest.raises(ModelError) as ei:
        list(c.stream(r))
    assert ei.value.retryable and ei.value.kind == "overloaded" and ei.value.retry_after == 3.0
    list(c.stream(r))
    # fallbacks 默认开：走 beta 接口，带 server-side-fallback 头和 fallbacks="default"
    assert sdk.calls[1]["fallbacks"] == "default"
    assert sdk.calls[1]["betas"] == ["server-side-fallback-2026-07-01"]


def test_invalid_tool_json_from_stream_is_retryable():
    sdk = StubSDK([text_stream("x", error=ValueError("Unterminated string")), text_stream("ok")])
    c = AnthropicClient("claude-opus-5-5", sdk_client=sdk, fallbacks=False)
    with pytest.raises(ModelError) as ei:
        list(c.stream(ModelRequest(system=[], messages=[])))
    assert ei.value.retryable and ei.value.kind == "invalid_json"


# ---------------------------------------------------------------- 第二层：工具防线

class Boom(Tool):
    name = "Boom"
    input_schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}

    def run(self, args, ctx):
        return ToolResult(str(1 / args["n"]))


def test_tool_exception_becomes_error_result(quiet):
    app, client = quiet(call("Boom", {"n": 0}), say("除零了，换个数"))
    app.agent.tools.register(Boom())
    evs = list(app.agent.run_turn("算 1/0"))
    end = next(e for e in evs if isinstance(e, ToolEnd))
    assert end.result.is_error and "ZeroDivisionError" in end.result.content
    sent = client.requests[1].messages[-1]["content"][0]
    assert sent["is_error"] is True and sent["content"].startswith("<tool_use_error>")


def test_validation_error_is_fed_back(quiet):
    app, client = quiet(call("Boom", {"n": "zero"}), say("参数类型错了"))
    app.agent.tools.register(Boom())
    list(app.agent.run_turn("go"))
    content = client.requests[1].messages[-1]["content"][0]["content"]
    assert "InputValidationError" in content and "input.n should be integer" in content


def test_unknown_tool(quiet):
    app, client = quiet(call("Nope", {}), say("ok"))
    list(app.agent.run_turn("go"))
    assert "No such tool available: Nope" in client.requests[1].messages[-1]["content"][0]["content"]


def test_bash_timeout(quiet):
    app, client = quiet(call("Bash", {"command": "sleep 5", "timeout": 1}), say("超时了"))
    list(app.agent.run_turn("go"))
    assert "timed out after 1s" in client.requests[1].messages[-1]["content"][0]["content"]


def test_huge_output_is_truncated(quiet):
    app, client = quiet(call("Bash", {"command": "python3 -c 'print(\"x\"*50000)'"}), say("ok"))
    app.settings.max_tool_output = 1000
    list(app.agent.run_turn("go"))
    content = client.requests[1].messages[-1]["content"][0]["content"]
    assert len(content) < 1100 and "output truncated" in content


# ---------------------------------------------------------------- 第三层：安全网

def test_max_tokens_with_tool_use_is_not_executed(quiet):
    trunc = FakeTurn([tool_block("Write", {"file_path": "a.txt"})], stop_reason="max_tokens")
    app, client = quiet(trunc, say("我分块写"))
    list(app.agent.run_turn("写大文件"))
    assert not (app.settings.cwd / "a.txt").exists()
    assert "NOT executed" in client.requests[1].messages[-1]["content"][0]["content"]


def test_refusal_stops_turn(quiet):
    app, _ = quiet(FakeTurn([], stop_reason="refusal"))
    evs = list(app.agent.run_turn("..."))
    assert evs[-1].stop_reason == "refusal"


def test_interrupt_repairs_dangling_tool_use(quiet):
    app, _ = quiet(call("Bash", {"command": "echo hi"}))
    gen = app.agent.run_turn("go")
    for ev in gen:
        if type(ev).__name__ == "ToolStart":
            gen.close()  # 模拟 Ctrl+C：在工具开始后、结果写回前关掉生成器
            break
    last = app.agent.messages[-1]
    assert last["role"] == "user" and last["content"][0]["type"] == "tool_result"
    assert "Interrupted" in last["content"][0]["content"]


def test_unexpected_internal_error_does_not_escape(quiet):
    def explode(req):
        raise KeyError("bug in our code")
    app, _ = quiet(explode)
    evs = list(app.agent.run_turn("go"))
    assert evs[-1].stop_reason == "error" and "内部错误" in evs[-2].text
