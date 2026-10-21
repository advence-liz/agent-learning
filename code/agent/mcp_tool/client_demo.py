"""用官方 mcp 客户端拉起 notes_server（真实 stdio 子进程），列工具、调工具。

uv run python -m mcp_tool.client_demo
"""

from __future__ import annotations

import sys
from pathlib import Path

import anyio

from mcp import ClientSession, StdioServerParameters, stdio_client

SERVER = Path(__file__).parent / "notes_server.py"


async def main() -> None:
    params = StdioServerParameters(command=sys.executable, args=[str(SERVER)])
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        init = await session.initialize()
        print(f"已连接：{init.server_info.name} {init.server_info.version}，协议 {init.protocol_version}")
        tools = await session.list_tools()
        for t in tools.tools:
            print(f"- {t.name}: {t.description[:30]}…  参数={list(t.input_schema['properties'])}")
        r = await session.call_tool("search_notes", {"query": "nginx"})
        print("search_notes(nginx) →", r.structured_content)
        r = await session.call_tool("read_note", {"path": "../../../etc/passwd"})
        print("read_note(越界) → is_error =", r.is_error, "|", r.content[0].text)


if __name__ == "__main__":
    anyio.run(main)
