"""第 10 章：一个查本地 markdown 笔记的 stdio MCP server（Python `mcp` 包 2.x，MCPServer）。

    NOTES_DIR=~/notes uv run --directory <本项目> python mcp_tool/notes_server.py

stdio 传输：client 把本进程当子进程拉起，stdin 收 JSON-RPC，stdout 回 JSON-RPC。
所以**绝对不能往 stdout print 日志**——那会混进协议流，日志一律走 stderr。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from pydantic import BaseModel

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

NOTES_DIR = Path(os.environ.get("NOTES_DIR", Path(__file__).parent / "sample_notes")).expanduser().resolve()

mcp = MCPServer(
    name="notes",
    version="0.1.0",
    instructions="查询用户本地的 markdown 笔记。先用 search_notes 找到文件，再用 read_note 读全文。",
)


class Hit(BaseModel):
    path: str
    line: int
    text: str


@mcp.tool()
def search_notes(query: str, limit: int = 5) -> list[Hit]:
    """在笔记里按关键词搜索（大小写不敏感，空格分隔的多个词需同时出现在一行）。返回命中的文件、行号和该行内容。"""
    words = [w.lower() for w in query.split()]
    hits: list[Hit] = []
    for p in sorted(NOTES_DIR.rglob("*.md")):
        for i, line in enumerate(p.read_text(errors="ignore").splitlines(), 1):
            if all(w in line.lower() for w in words):
                hits.append(Hit(path=str(p.relative_to(NOTES_DIR)), line=i, text=line.strip()))
                if len(hits) >= limit:
                    break
    print(f"[notes] search {query!r} → {len(hits)} hits", file=sys.stderr)  # 日志走 stderr
    return hits[:limit]


@mcp.tool()
def read_note(path: str) -> str:
    """读取一篇笔记的全文。path 是 search_notes 返回的相对路径。"""
    p = (NOTES_DIR / path).resolve()
    if not p.is_relative_to(NOTES_DIR) or p.suffix != ".md":
        # 用 ToolError：消息会原样回给模型；普通异常只会回「Error executing tool」，细节留在服务端
        raise ToolError(f"只能读取笔记目录下的 .md 文件：{path}")
    return p.read_text()


if __name__ == "__main__":
    mcp.run()  # 默认 transport="stdio"
