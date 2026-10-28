"""给第 12–21 章预留的扩展点：这里只验证「挂得上、按时触发」，具体功能由后续章节实现。"""

from mini_cc.events import Notice, TurnEnd
from mini_cc.model import call, say
from mini_cc.permissions import Decision


def test_before_request_and_turn_end_hooks(make_app):
    app, client = make_app(call("Bash", {"command": "true"}), say("ok"))
    seen = []
    app.agent.before_request.append(lambda a: seen.append(("req", len(a.messages))) or [Notice("compact?")])
    app.agent.turn_end.append(lambda a, end: seen.append(("end", end.stop_reason)) or None)
    evs = list(app.agent.run_turn("go"))
    assert seen == [("req", 1), ("req", 3), ("end", "end_turn")]
    assert sum(isinstance(e, Notice) and e.text == "compact?" for e in evs) == 2
    assert isinstance(evs[-1], TurnEnd)


def test_listeners_write_hooks_system_sections_extra_checks(make_app):
    app, client = make_app(call("Write", {"file_path": "a.txt", "content": "x"}), say("ok"))
    msgs, writes = [], []
    app.agent.listeners.append(lambda m, meta: msgs.append(m["role"]))           # 第 13 章 rewind
    app.agent.ctx.write_hooks.append(lambda p: writes.append(p.name))            # 第 13 章文件快照
    app.agent.context.system_sections.append(lambda: "# Memory\n- prefers pnpm")  # 第 12 章记忆 / 第 20 章 skills
    app.agent.context.invalidate()
    app.agent.permissions.extra_checks.append(                                    # 第 21 章 plan 模式
        lambda t, a, m: Decision("allow", "plan file", "check") if t.kind == "edit" else None)
    list(app.agent.run_turn("写"))
    assert msgs == ["user", "assistant", "user", "assistant"] and writes == ["a.txt"]
    assert client.requests[0].system[-1]["text"] == "# Memory\n- prefers pnpm"
    assert "是否允许" not in app.ui.text  # extra_check 放行了编辑


def test_registry_accepts_new_tools_at_runtime(make_app):
    """第 15 章 MCP / 第 17 章 sub agent：运行时注册新工具，下一次请求就带上 schema。"""
    from mini_cc.tools import ToolResult
    from mini_cc.tools.base import Tool

    class Echo(Tool):
        name = "mcp__demo__echo"
        read_only = True
        input_schema = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}

        def run(self, args, ctx):
            return ToolResult(args["text"])

    app, client = make_app(call("mcp__demo__echo", {"text": "pong"}), say("ok"))
    app.agent.tools.register(Echo())
    list(app.agent.run_turn("ping"))
    assert client.requests[0].tools[-1]["name"] == "mcp__demo__echo"
    assert client.requests[1].messages[-1]["content"][0]["content"] == "pong"
