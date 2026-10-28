"""一个假的「Claude Code CLI」：实现 claude_agent_sdk 的 Transport 接口，按脚本回放 stream-json 消息。

为什么能这么做？因为 SDK 和 CLI 之间就是 stdin/stdout 上一行一个 JSON：
  SDK → CLI： control_request(initialize, 带 hooks 回调 id)、user 消息、control_response
  CLI → SDK： system/assistant/user/result 消息、control_request(hook_callback / mcp_message)
我们把 CLI 那一侧换成脚本，就能离线观察 SDK 的 hook 和进程内 MCP 工具是怎么被「反向调用」的。

注意：Transport 是 SDK 标注为内部、可能变动的接口；这里的消息字段按 claude-agent-sdk 0.2.170
的 message_parser / query 源码对齐，只覆盖本 demo 用到的最小子集。
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, AsyncIterator

import anyio
from claude_agent_sdk._internal.transport import Transport

SESSION = "fake-session-0001"


class FakeCLITransport(Transport):
    def __init__(self, script: list[dict[str, Any]]):
        self.script = script  # 一组「CLI 动作」，见 demo.py
        self.wire: list[tuple[str, dict[str, Any]]] = []  # 记录所有收发，便于打印/断言
        self._send, self._recv = anyio.create_memory_object_stream[dict[str, Any] | None](100)
        self._pending: dict[str, anyio.Event] = {}
        self._responses: dict[str, Any] = {}
        self._hooks: dict[str, list[dict[str, Any]]] = {}
        self._ready = False
        self._n = 0
        self._rpc_id = 0
        self._mcp_ready: set[str] = set()

    # ---- Transport 接口 ----
    async def connect(self) -> None:
        self._ready = True

    def is_ready(self) -> bool:
        return self._ready

    async def end_input(self) -> None:
        pass

    async def close(self) -> None:
        self._ready = False

    async def write(self, data: str) -> None:
        for line in data.splitlines():
            msg = json.loads(line)
            self.wire.append(("SDK→CLI", msg))
            if msg["type"] == "control_request" and msg["request"]["subtype"] == "initialize":
                self._hooks = msg["request"].get("hooks") or {}
                await self._emit({
                    "type": "control_response",
                    "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}},
                })
            elif msg["type"] == "control_response":
                rid = msg["response"]["request_id"]
                self._responses[rid] = msg["response"].get("response")
                self._pending.pop(rid).set()
            elif msg["type"] == "user":
                # 收到用户 prompt 后开始「跑 agent」：在后台任务里回放脚本
                self._task = asyncio.get_running_loop().create_task(self._play())

    async def read_messages(self) -> AsyncIterator[dict[str, Any]]:
        async for msg in self._recv:
            if msg is None:
                return
            yield msg

    # ---- 假 CLI 的内部逻辑 ----
    async def _emit(self, msg: dict[str, Any]) -> None:
        self.wire.append(("CLI→SDK", msg))
        await self._send.send(msg)

    async def _ask_sdk(self, request: dict[str, Any]) -> Any:
        """CLI 反向请求 SDK（hook 回调 / 进程内 MCP），等它回 control_response。"""
        self._n += 1
        rid = f"cli_req_{self._n}"
        self._pending[rid] = anyio.Event()
        ev = self._pending[rid]
        await self._emit({"type": "control_request", "request_id": rid, "request": request})
        await ev.wait()
        return self._responses.pop(rid)

    async def _run_hooks(self, event: str, tool_name: str, tool_input: dict, tool_use_id: str) -> list[Any]:
        outs = []
        for m in self._hooks.get(event, []):
            if m.get("matcher") and not re.fullmatch(m["matcher"], tool_name):
                continue
            for cid in m["hookCallbackIds"]:
                outs.append(await self._ask_sdk({
                    "subtype": "hook_callback",
                    "callback_id": cid,
                    "tool_use_id": tool_use_id,
                    "input": {
                        "hook_event_name": event, "session_id": SESSION, "cwd": ".",
                        "transcript_path": "", "tool_name": tool_name, "tool_input": tool_input,
                    },
                }))
        return outs

    async def _mcp(self, server: str, method: str, params: dict[str, Any] | None) -> Any:
        """把一条 JSON-RPC 包进 control_request(mcp_message) 发给 SDK 里的 MCP server。"""
        if server not in self._mcp_ready:  # 和任何 MCP server 一样，先握手（第 11 章细讲）
            self._mcp_ready.add(server)
            await self._mcp(server, "initialize", {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": {"name": "fake-cli", "version": "0"}})
            await self._mcp(server, "notifications/initialized", None)
        self._rpc_id += 1
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not method.startswith("notifications/"):
            msg["id"] = self._rpc_id
        resp = await self._ask_sdk({"subtype": "mcp_message", "server_name": server, "message": msg})
        return resp["mcp_response"]

    def _assistant(self, content: list[dict[str, Any]], i: int) -> dict[str, Any]:
        return {
            "type": "assistant", "session_id": SESSION, "parent_tool_use_id": None,
            "message": {"id": f"msg_{i}", "role": "assistant", "model": "claude-opus-5-5", "content": content,
                        "stop_reason": "tool_use" if any(c["type"] == "tool_use" for c in content) else "end_turn",
                        "usage": {"input_tokens": 100, "output_tokens": 30}},
        }

    async def _play(self) -> None:
        await self._emit({"type": "system", "subtype": "init", "session_id": SESSION, "model": "claude-opus-5-5"})
        turns = 0
        for i, step in enumerate(self.script):
            turns += 1
            if "text" in step:
                await self._emit(self._assistant([{"type": "text", "text": step["text"]}], i))
                continue
            tid = f"toolu_{i:02d}"
            name, args = step["tool"], step["input"]
            await self._emit(self._assistant([{"type": "tool_use", "id": tid, "name": name, "input": args}], i))
            # 1) PreToolUse hooks：问 SDK 要不要放行
            outs = await self._run_hooks("PreToolUse", name, args, tid)
            denied = next((o["hookSpecificOutput"]["permissionDecisionReason"] for o in outs
                           if (o or {}).get("hookSpecificOutput", {}).get("permissionDecision") == "deny"), None)
            if denied:
                result, is_error = denied, True
            elif name.startswith("mcp__"):
                # 2) 进程内 MCP 工具：CLI 把 JSON-RPC 包在 control_request 里转给 SDK
                server, tool_name = name.split("__")[1:3]
                resp = await self._mcp(server, "tools/call", {"name": tool_name, "arguments": args})
                result = resp["result"]["content"][0]["text"]
                is_error = False
            else:
                result, is_error = step.get("fake_result", "(fake CLI 未真正执行内置工具)"), False
            await self._emit({
                "type": "user", "session_id": SESSION, "parent_tool_use_id": None,
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": tid, "content": result, "is_error": is_error}]},
            })
        await self._emit({
            "type": "result", "subtype": "success", "session_id": SESSION, "is_error": False,
            "duration_ms": 1234, "duration_api_ms": 1000, "num_turns": turns, "stop_reason": "end_turn",
            "total_cost_usd": 0.0, "result": self.script[-1].get("text", ""), "usage": {},
        })
        await self._send.send(None)
