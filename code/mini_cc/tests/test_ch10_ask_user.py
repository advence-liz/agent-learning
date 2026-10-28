"""第 10 章：让 Agent 主动向你提问。"""

from mini_cc.model import call, say
from mini_cc.tools import ToolContext, ToolRegistry, default_tools
from mini_cc.tools.ask_user import Question, parse_answer

QS = {"questions": [
    {"question": "博客用什么技术栈？", "header": "技术栈",
     "options": [{"label": "Next.js (Recommended)", "description": "SSR + 静态导出"},
                 {"label": "Astro", "description": "内容站首选"}]},
    {"question": "需要哪些功能？", "header": "功能", "multiSelect": True,
     "options": [{"label": "评论"}, {"label": "RSS"}, {"label": "全文搜索"}]},
]}


def test_parse_answer():
    q = Question("x", "h", [{"label": "A"}, {"label": "B"}, {"label": "C"}], multi_select=True)
    assert parse_answer("2", q).choices == ["B"]
    assert parse_answer("1, 3", q).choices == ["A", "C"]
    assert parse_answer("1，3", q).choices == ["A", "C"]          # 中文逗号
    assert parse_answer("用 Hugo", q).choices == ["用 Hugo"]       # Other
    assert parse_answer("", q).skipped
    assert parse_answer("9", q) is None
    single = Question("x", "h", [{"label": "A"}, {"label": "B"}])
    assert parse_answer("1,2", single) is None                    # 单选不能选两个


def test_agent_asks_and_continues_with_answers(make_app):
    app, client = make_app(call("AskUserQuestion", QS, text="先确认两件事。"), say("好的：Astro + 评论、RSS。"))
    app.ui.answers = ["2", "1,2"]
    app.handle_line("帮我开发一个博客系统")
    assert "[技术栈] (1/2) 博客用什么技术栈？" in app.ui.text
    assert "  1. Next.js (Recommended) — SSR + 静态导出" in app.ui.text
    assert "是否允许" not in app.ui.text  # 提问不需要权限审批
    result = client.requests[1].messages[-1]["content"][0]
    assert not result["is_error"]
    assert result["content"] == ('Your questions have been answered: "博客用什么技术栈？"="Astro", '
                                 '"需要哪些功能？"="评论, RSS". You can now continue with these answers in mind.')


def test_other_and_skip(make_app):
    app, client = make_app(call("AskUserQuestion", QS), say("ok"))
    app.ui.answers = ["用 Hugo，我熟", ""]
    app.handle_line("博客")
    content = client.requests[1].messages[-1]["content"][0]["content"]
    assert '"博客用什么技术栈？"="用 Hugo，我熟"' in content and '"需要哪些功能？"=(no answer)' in content


def test_invalid_then_retry(make_app):
    app, client = make_app(call("AskUserQuestion", {"questions": QS["questions"][:1]}), say("ok"))
    app.ui.answers = ["7", "1"]
    app.handle_line("博客")
    assert "输入无效" in app.ui.text
    assert '"Next.js (Recommended)"' in client.requests[1].messages[-1]["content"][0]["content"]


def test_all_skipped_means_declined(make_app):
    app, client = make_app(call("AskUserQuestion", QS), say("那你说说想要什么"))
    app.ui.answers = ["", ""]
    app.handle_line("博客")
    assert "User declined to answer" in client.requests[1].messages[-1]["content"][0]["content"]


def test_schema_limits_enforced(tmp_path):
    reg = ToolRegistry(default_tools())
    ctx = ToolContext(cwd=tmp_path)
    five = {"questions": [QS["questions"][0]] * 5}
    one_option = {"questions": [{"question": "q", "header": "h", "options": [{"label": "only"}]}]}
    assert "at most 4 items" in reg.execute("AskUserQuestion", five, ctx).content
    assert "at least 2 items" in reg.execute("AskUserQuestion", one_option, ctx).content


def test_no_ui_available(tmp_path):
    reg = ToolRegistry(default_tools())
    r = reg.execute("AskUserQuestion", QS, ToolContext(cwd=tmp_path))
    assert r.is_error and "sensible defaults" in r.content


def test_system_prompt_mentions_when_to_ask(make_app):
    app, client = make_app(say("ok"))
    app.handle_line("hi")
    assert "AskUserQuestion" in client.requests[0].system[0]["text"]
    assert any(t["name"] == "AskUserQuestion" for t in client.requests[0].tools)
