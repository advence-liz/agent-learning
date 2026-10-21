"""第 6 章：用 Claude Agent SDK（pip 包 claude-agent-sdk）重写第 2 章的 Coding Agent。

对比第 2 章的 ~120 行：循环、工具执行、tool_result 拼装全部交给 SDK（它背后就是 Claude Code）。
我们只剩三件事：写 prompt、配 options、（可选）挂自定义工具和 hook。

真实运行（会启动 SDK 自带的 claude CLI，并真实调用模型，需要 ANTHROPIC_API_KEY）：
    uv run python -m agent_sdk.sdk_agent "test_calc.py 挂了，帮我修好" /path/to/project
离线演示（用假的 CLI 传输层回放一段脚本，不调用任何模型）：
    uv run python -m agent_sdk.demo
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    query,
    tool,
)

DANGEROUS = ("rm -rf", "git push --force", "git reset --hard")


# ---------- 1. 自定义工具：进程内 MCP server（不用另起进程） ----------
@tool("count_todos", "统计项目里 TODO 注释的数量", {"glob": str})
async def count_todos(args: dict[str, Any]) -> dict[str, Any]:
    n = sum(p.read_text(errors="ignore").count("TODO") for p in Path(".").glob(args["glob"]) if p.is_file())
    return {"content": [{"type": "text", "text": f"{args['glob']} 中共有 {n} 个 TODO"}]}


TOOLS_SERVER = create_sdk_mcp_server(name="proj", version="1.0.0", tools=[count_todos])


# ---------- 2. Hook：在工具执行前拦截危险命令 ----------
async def block_dangerous(input_data: dict[str, Any], tool_use_id: str | None, context: Any) -> dict[str, Any]:
    cmd = input_data["tool_input"].get("command", "")
    if any(d in cmd for d in DANGEROUS):
        return {
            "hookSpecificOutput": {
                "hookEventName": input_data["hook_event_name"],
                "permissionDecision": "deny",
                "permissionDecisionReason": f"禁止执行危险命令：{cmd}",
            }
        }
    return {}


def make_options(cwd: str | Path) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        model="claude-opus-5-5",
        cwd=str(cwd),
        system_prompt={"type": "preset", "preset": "claude_code", "append": "改完代码必须跑测试验证。"},
        allowed_tools=["Read", "Edit", "Write", "Bash", "mcp__proj__count_todos"],
        permission_mode="acceptEdits",
        mcp_servers={"proj": TOOLS_SERVER},
        hooks={"PreToolUse": [HookMatcher(matcher="Bash", hooks=[block_dangerous])]},
        max_turns=20,
    )


# ---------- 3. 跑起来：遍历消息流 ----------
async def run(prompt: str, cwd: str | Path, transport: Any = None) -> ResultMessage | None:
    result = None
    async for msg in query(prompt=prompt, options=make_options(cwd), transport=transport):
        if isinstance(msg, AssistantMessage):
            for b in msg.content:
                if isinstance(b, TextBlock):
                    print(f"⏺ {b.text}")
                elif isinstance(b, ToolUseBlock):
                    print(f"⏺ {b.name}({b.input})")
        elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
            for b in msg.content:
                if isinstance(b, ToolResultBlock):
                    print(f"  {'✘' if b.is_error else '✔'} {b.content}")
        elif isinstance(msg, ResultMessage):
            result = msg
            print(f"■ result: turns={msg.num_turns} cost=${msg.total_cost_usd} stop={msg.stop_reason}")
    return result


if __name__ == "__main__":
    import anyio

    anyio.run(run, sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ".")
