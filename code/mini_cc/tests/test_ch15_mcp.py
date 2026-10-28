"""第 15 章：按 .mcp.json 注册 MCP server（真实 stdio 子进程，不联网）。"""

import json
import sys
from pathlib import Path

import pytest

from mini_cc.cli import App
from mini_cc.mcp_client import convert_content, load_config, mcp_tool_name
from mini_cc.model import FakeClient, call, say
from mini_cc.ui import BufferUI

SERVER = str(Path(__file__).parent.parent / "examples" / "mcp_tracker_server.py")


def _write_mcp_json(cwd: Path, **servers):
    (cwd / ".mcp.json").write_text(json.dumps({"mcpServers": servers}))


@pytest.fixture
def apps():
    made = []
    yield made
    for a in made:
        a.close()


def _app(settings, apps, script, answers):
    app = App(settings, FakeClient(list(script)), ui=BufferUI(list(answers)))
    apps.append(app)
    app.start_mcp()
    return app


def test_load_config_expands_env_and_merges_scopes(tmp_path, monkeypatch):
    monkeypatch.setenv("TRACKER_TOKEN", "t0k")
    proj, home = tmp_path / "p", tmp_path / "h"
    proj.mkdir(), home.mkdir()
    (home / "mcp.json").write_text(json.dumps({"mcpServers": {
        "notes": {"command": "notes-server"}, "tracker": {"command": "old"}}}))
    _write_mcp_json(proj, tracker={"command": "python", "args": ["s.py", "${TRACKER_TOKEN}", "${MISSING:-dflt}"]})
    cfg = load_config(proj, home)
    assert cfg["tracker"].scope == "project" and cfg["tracker"].args == ["s.py", "t0k", "dflt"]
    assert cfg["notes"].scope == "user"


def test_tool_name_is_api_safe():
    assert mcp_tool_name("my server", "do.thing") == "mcp__my_server__do_thing"
    assert len(mcp_tool_name("s" * 40, "t" * 40)) == 64


def test_convert_content_keeps_images():
    from mcp_types import ImageContent, TextContent

    out = convert_content([TextContent(type="text", text="hi"),
                           ImageContent(type="image", data="AAAA", mime_type="image/png")])
    assert out[0] == {"type": "text", "text": "hi"}
    assert out[1] == {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}


def test_real_stdio_server_end_to_end(settings, apps):
    _write_mcp_json(settings.cwd, tracker={"command": sys.executable, "args": [SERVER]})
    script = [call("mcp__tracker__list_issues", {}),
              call("mcp__tracker__add_comment", {"issue_id": "BUG-101", "body": "已加分页"}),
              say("查到了，也回复了")]
    app = _app(settings, apps, script, ["1", "1"])   # 第 1 个 1：批准项目 server；第 2 个 1：允许 add_comment
    assert "项目 .mcp.json 声明了 MCP server tracker" in app.ui.text
    app.handle_line("看看有哪些 issue，给 BUG-101 回复一下")
    req = app.client.requests
    names = [t["name"] for t in req[0].tools]
    assert {"mcp__tracker__list_issues", "mcp__tracker__get_issue", "mcp__tracker__add_comment"} <= set(names)
    # 只读工具（readOnlyHint）免审批；写操作要问
    assert app.ui.text.count("是否允许") == 1 and "是否允许 mcp__tracker__add_comment" in app.ui.text
    first = req[1].messages[-1]["content"][0]
    assert "BUG-101 [Todo]" in first["content"][0]["text"] and not first["is_error"]
    assert "Comment added to BUG-101" in req[2].messages[-1]["content"][0]["content"][0]["text"]
    # server 的 instructions 进了 system
    system = "\n".join(b["text"] for b in req[0].system)
    assert "# MCP server instructions" in system and "## tracker" in system
    app.handle_line("/mcp")
    assert "tracker" in app.ui.text and "connected" in app.ui.text and "3 tools" in app.ui.text


def test_tool_error_is_returned_to_model(settings, apps):
    _write_mcp_json(settings.cwd, tracker={"command": sys.executable, "args": [SERVER]})
    app = _app(settings, apps, [call("mcp__tracker__get_issue", {"issue_id": "NOPE"}), say("没有")], ["1"])
    app.handle_line("看看 NOPE")
    r = app.client.requests[1].messages[-1]["content"][0]
    assert r["is_error"] and "No issue NOPE" in json.dumps(r)


def test_failed_server_does_not_block_startup(settings, apps):
    _write_mcp_json(settings.cwd, broken={"command": "definitely-not-a-real-binary-xyz"},
                    tracker={"command": sys.executable, "args": [SERVER]})
    app = _app(settings, apps, [], ["1", "1"])
    st = {s.name: s for s in app.mcp.servers.values()}
    assert st["broken"].status == "failed" and st["broken"].error
    assert st["tracker"].status == "connected"
    app.handle_line("/mcp")
    assert "failed" in app.ui.text


def test_project_server_needs_approval_and_is_remembered(settings, apps):
    _write_mcp_json(settings.cwd, tracker={"command": sys.executable, "args": [SERVER]})
    app = _app(settings, apps, [], ["2"])                     # 2 = 不启动
    assert app.mcp.servers["tracker"].status == "disabled"
    assert not any(n.startswith("mcp__") for n in app.agent.tools.names())
    app2 = _app(settings, apps, [], ["1"])                    # 换个进程再问，这次批准
    assert app2.mcp.servers["tracker"].status == "connected"
    app3 = _app(settings, apps, [], [])                       # 批准过且配置没变：不再问
    assert "是否启动" not in app3.ui.text and app3.mcp.servers["tracker"].status == "connected"
