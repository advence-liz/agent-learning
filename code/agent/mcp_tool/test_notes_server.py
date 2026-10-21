import sys

import anyio

from mcp import ClientSession, StdioServerParameters, stdio_client
from mcp_tool.client_demo import SERVER


def test_real_stdio_roundtrip():
    async def go():
        params = StdioServerParameters(command=sys.executable, args=[str(SERVER)])
        async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
            await s.initialize()
            names = sorted(t.name for t in (await s.list_tools()).tools)
            hit = await s.call_tool("search_notes", {"query": "permissionDecision"})
            note = await s.call_tool("read_note", {"path": "claude-hooks.md"})
            bad = await s.call_tool("read_note", {"path": "../notes_server.py"})
            return names, hit, note, bad

    names, hit, note, bad = anyio.run(go)
    assert names == ["read_note", "search_notes"]
    assert hit.structured_content["result"][0]["path"] == "claude-hooks.md"
    assert note.content[0].text.startswith("# Claude Code hooks")
    assert bad.is_error and "只能读取" in bad.content[0].text
