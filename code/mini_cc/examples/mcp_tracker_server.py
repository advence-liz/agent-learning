"""第 15 章演示用的 stdio MCP server：一个假的 issue tracker（数据在内存里，不联网）。

    uv run python examples/mcp_tracker_server.py      # 一般不直接跑，由 mini-cc 按 .mcp.json 拉起

mcp 2.x 的服务端类叫 MCPServer（1.x 的 FastMCP 已改名）。stdout 是协议通道，日志只能写 stderr。
"""

from __future__ import annotations

import sys

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations

ISSUES = {
    "BUG-101": {"title": "list_posts 没有分页，首页一次返回 5000 条", "status": "Todo", "comments": []},
    "BUG-102": {"title": "登录页在 Safari 上按钮错位", "status": "In Progress", "comments": []},
}

mcp = MCPServer(
    name="tracker",
    version="0.1.0",
    instructions="Issue tracker for this project. Use list_issues to find an issue id, get_issue for details, "
                 "and add_comment only when the user asks you to report back.",
)


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True))
def list_issues(status: str = "") -> str:
    """List issues as `ID [status] title` lines. Optional status filter, e.g. "Todo"."""
    rows = [f"{k} [{v['status']}] {v['title']}" for k, v in ISSUES.items() if not status or v["status"] == status]
    print(f"[tracker] list_issues {status!r} -> {len(rows)}", file=sys.stderr)
    return "\n".join(rows) or "(no issues)"


@mcp.tool(annotations=ToolAnnotations(read_only_hint=True))
def get_issue(issue_id: str) -> str:
    """Get one issue with its comments."""
    if issue_id not in ISSUES:
        raise ToolError(f"No issue {issue_id}. Use list_issues to see ids.")
    v = ISSUES[issue_id]
    comments = "\n".join(f"- {c}" for c in v["comments"]) or "(no comments)"
    return f"{issue_id}: {v['title']}\nstatus: {v['status']}\ncomments:\n{comments}"


@mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False))
def add_comment(issue_id: str, body: str) -> str:
    """Add a comment to an issue (visible to the whole team)."""
    if issue_id not in ISSUES:
        raise ToolError(f"No issue {issue_id}.")
    ISSUES[issue_id]["comments"].append(body)
    return f"Comment added to {issue_id} ({len(ISSUES[issue_id]['comments'])} total)."


if __name__ == "__main__":
    mcp.run()
