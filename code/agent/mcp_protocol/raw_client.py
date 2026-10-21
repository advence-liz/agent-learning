"""第 11 章：不用任何 MCP 库，直接起第 10 章的 server，手写 JSON-RPC 收发并打印原始报文。

    uv run python -m mcp_protocol.raw_client

stdio 传输的分帧规则很朴素：一条消息 = 一行 JSON（UTF-8，以 \\n 结尾，消息内部不能有裸换行）。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

SERVER = Path(__file__).resolve().parent.parent / "mcp_tool" / "notes_server.py"


class RawClient:
    def __init__(self, cmd: list[str], verbose: bool = True):
        # stderr 单独接走：server 的日志在那里，绝不会混进协议流
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        self.next_id = 0
        self.verbose = verbose
        self.log: list[tuple[str, dict[str, Any]]] = []

    def _send(self, msg: dict[str, Any]) -> None:
        line = json.dumps(msg, ensure_ascii=False)
        self.log.append(("→", msg))
        if self.verbose:
            print(f"→ {line}")
        self.p.stdin.write(line + "\n")
        self.p.stdin.flush()

    def _recv(self) -> dict[str, Any]:
        line = self.p.stdout.readline()
        if not line:
            raise EOFError(self.p.stderr.read())
        msg = json.loads(line)
        self.log.append(("←", msg))
        if self.verbose:
            print(f"← {line.rstrip()}")
        return msg

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.next_id += 1
        msg: dict[str, Any] = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            msg["params"] = params
        self._send(msg)
        while True:  # 等到 id 对上的那条响应；中途 server 发来的通知/请求先打印再跳过
            resp = self._recv()
            if resp.get("id") == self.next_id and "method" not in resp:
                return resp

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}  # 没有 id = 通知，对方不回
        if params is not None:
            msg["params"] = params
        self._send(msg)

    def close(self) -> str:
        self.p.stdin.close()  # stdio 传输里，关 stdin 就是「断开连接」
        self.p.wait(timeout=5)
        return self.p.stderr.read()


def session(verbose: bool = True) -> RawClient:
    c = RawClient([sys.executable, str(SERVER)], verbose)

    def step(title: str) -> None:
        if verbose:
            print(f"\n## {title}")

    step("1. initialize：客户端报协议版本和能力，服务端回它的版本、能力和简介")
    c.request("initialize", {
        "protocolVersion": "2025-11-25",
        "capabilities": {},
        "clientInfo": {"name": "raw-client", "version": "0.0.1"},
    })
    step("2. notifications/initialized：握手完成（通知，没有 id，也没有响应）")
    c.notify("notifications/initialized")

    step("3. tools/list：动态拉取工具清单（含 JSON Schema）")
    c.request("tools/list")

    step("4. tools/call：调用工具")
    c.request("tools/call", {"name": "search_notes", "arguments": {"query": "stop hook"}})

    step("5. 工具执行失败：不是 JSON-RPC error，而是 result.isError = true")
    c.request("tools/call", {"name": "read_note", "arguments": {"path": "/etc/passwd"}})

    step("6. 协议层错误：调用不存在的方法 → JSON-RPC error 对象")
    c.request("resources/subscribe_everything")

    step("7. ping：保活")
    c.request("ping")
    return c


def edge_cases(verbose: bool = True) -> dict[str, dict[str, Any]]:
    out = {}
    c = RawClient([sys.executable, str(SERVER)], verbose)
    if verbose:
        print("\n## 边界 A：不握手直接 tools/list")
    out["no_handshake"] = c.request("tools/list")
    c.close()
    c = RawClient([sys.executable, str(SERVER)], verbose)
    if verbose:
        print("\n## 边界 B：客户端报一个服务端不认识的版本 → 服务端还价")
    out["bad_version"] = c.request("initialize", {
        "protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": {"name": "x", "version": "0"}})
    c.close()
    return out


if __name__ == "__main__":
    if "--edge" in sys.argv:
        edge_cases()
        sys.exit()
    c = session()
    err = c.close()
    print("\n## server 的 stderr（日志都在这里）")
    print(err.strip())
