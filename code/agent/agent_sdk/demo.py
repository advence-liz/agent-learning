"""离线演示：真实的 claude_agent_sdk.query() + 假 CLI 传输层。

uv run python -m agent_sdk.demo          # 看 agent 视角的输出
uv run python -m agent_sdk.demo --wire   # 额外打印 SDK 与 CLI 之间的原始 JSON 行
"""

from __future__ import annotations

import json
import sys

import anyio

from agent_sdk.fake_cli import FakeCLITransport
from agent_sdk.sdk_agent import run

SCRIPT = [
    {"tool": "Bash", "input": {"command": "rm -rf build && python test_calc.py"}},
    {"tool": "Bash", "input": {"command": "python test_calc.py"}, "fake_result": "AssertionError: -1"},
    {"tool": "mcp__proj__count_todos", "input": {"glob": "*.md"}},
    {"text": "危险命令被 hook 拦下后，我改用了安全命令；测试失败原因已定位。"},
]


def summarize(msg: dict) -> str:
    t = msg["type"]
    if t == "control_request":
        r = msg["request"]
        if r["subtype"] == "initialize":
            return f"control_request initialize  hooks={json.dumps(r['hooks'])}"
        if r["subtype"] == "hook_callback":
            return f"control_request hook_callback  {r['callback_id']} {r['input']['tool_name']} {r['input']['tool_input']}"
        if r["subtype"] == "mcp_message":
            m = r["message"]
            return f"control_request mcp_message  {r['server_name']} {m['method']} id={m.get('id')}"
    if t == "control_response":
        body = json.dumps(msg["response"].get("response"), ensure_ascii=False)
        return f"control_response {msg['response']['request_id']}  {body[:80]}"
    if t in ("assistant", "user"):
        c = msg["message"]["content"]
        return f"{t}  {json.dumps(c, ensure_ascii=False)[:80]}"
    return f"{t} {msg.get('subtype', '')}"


async def main(show_wire: bool) -> FakeCLITransport:
    t = FakeCLITransport(SCRIPT)
    await run("test_calc.py 挂了，帮我修好", ".", transport=t)
    if show_wire:
        print("\n---- 线上的原始消息（截断） ----")
        for direction, msg in t.wire:
            print(f"{direction}  {summarize(msg)}")
    return t


if __name__ == "__main__":
    anyio.run(main, "--wire" in sys.argv)
