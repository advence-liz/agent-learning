"""MCP 客户端（第 15 章）：读 .mcp.json → 启动并连接每个 server → 把它们的工具注册成普通的 Tool。

难点只有一个：MCP Python SDK 是 async 的，而 agent 循环是同步生成器。
做法：开一个后台线程跑 asyncio 事件循环；每个 server 一个常驻协程（握手、列工具，然后一直等到关闭）；
工具调用用 asyncio.run_coroutine_threadsafe 提交到那个循环，同步等结果。

配置格式和 Claude Code 一样：
    {"mcpServers": {"tracker": {"command": "python", "args": ["server.py"], "env": {"K": "${TOKEN}"}},
                    "remote":  {"type": "http", "url": "https://example.com/mcp"}}}
项目级 <cwd>/.mcp.json（第一次启动前要用户批准）+ 用户级 <home>/mcp.json（自己写的，不用批准）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .tools.base import Tool, ToolContext, ToolResult

CONNECT_TIMEOUT = 15.0
CALL_TIMEOUT = 120.0
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


# ---------------------------------------------------------------- 配置


@dataclass
class ServerConfig:
    name: str
    scope: str                      # project | user
    type: str = "stdio"             # stdio | http
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    url: str = ""

    def fingerprint(self) -> str:
        """批准记录绑定到「这份配置」：命令或参数一变就要重新批准。"""
        raw = json.dumps([self.type, self.command, self.args, self.env, self.url], ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def describe(self) -> str:
        return self.url if self.type == "http" else " ".join([self.command, *self.args])


def _expand(v: Any) -> Any:
    """${VAR} 和 ${VAR:-默认值}（Claude Code 的 .mcp.json 也支持这两种写法），让密钥留在环境变量里。"""
    if isinstance(v, str):
        return _VAR.sub(lambda m: os.environ.get(m[1], m[2] if m[2] is not None else ""), v)
    if isinstance(v, list):
        return [_expand(x) for x in v]
    if isinstance(v, dict):
        return {k: _expand(x) for k, x in v.items()}
    return v


def load_config(cwd: Path, home: Path) -> dict[str, ServerConfig]:
    out: dict[str, ServerConfig] = {}
    for scope, path in (("user", home / "mcp.json"), ("project", cwd / ".mcp.json")):  # 后读的覆盖先读的
        if not path.is_file():
            continue
        for name, raw in (json.loads(path.read_text(encoding="utf-8")).get("mcpServers") or {}).items():
            raw = _expand(raw)
            out[name] = ServerConfig(name, scope, raw.get("type", "http" if "url" in raw else "stdio"),
                                     raw.get("command", ""), list(raw.get("args", [])), dict(raw.get("env", {})),
                                     raw.get("url", ""))
    return out


def mcp_tool_name(server: str, tool: str) -> str:
    """mcp__<server>__<tool>。API 要求工具名匹配 ^[a-zA-Z0-9_-]{1,64}$，所以先清洗再截断。"""
    clean = lambda s: re.sub(r"[^A-Za-z0-9_-]", "_", s)  # noqa: E731
    return f"mcp__{clean(server)}__{clean(tool)}"[:64]


def convert_content(blocks: list[Any]) -> list[dict[str, Any]]:
    """MCP 的 content → Anthropic 的 content block。图片原样转成 image 块（第 19 章会用到）。"""
    out: list[dict[str, Any]] = []
    for b in blocks:
        t = getattr(b, "type", "")
        if t == "text":
            out.append({"type": "text", "text": b.text})
        elif t == "image":
            out.append({"type": "image", "source": {"type": "base64", "media_type": b.mime_type, "data": b.data}})
        else:  # audio / resource 等：给模型一个占位，至少知道有东西没显示
            out.append({"type": "text", "text": f"[{t or 'unknown'} content omitted]"})
    return out or [{"type": "text", "text": "(no content)"}]


# ---------------------------------------------------------------- 连接管理


@dataclass
class ServerState:
    name: str
    config: ServerConfig
    status: str = "pending"         # pending | connected | failed | disabled
    error: str = ""
    tools: list[Any] = field(default_factory=list)
    instructions: str = ""
    session: Any = None
    _stop: Any = None


class McpManager:
    def __init__(self, log_dir: Path):
        self.log_dir = log_dir
        self.servers: dict[str, ServerState] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._tasks: list[Any] = []

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            self._loop = asyncio.new_event_loop()
            self._thread = threading.Thread(target=self._loop.run_forever, name="mcp-loop", daemon=True)
            self._thread.start()
        return self._loop

    def start(self, configs: list[ServerConfig], timeout: float = CONNECT_TIMEOUT) -> None:
        """并行连接所有 server，最多等 timeout 秒。连不上的标成 failed，不影响别的 server 和启动。"""
        if not configs:
            return
        loop = self._ensure_loop()
        ready = []
        for cfg in configs:
            st = self.servers[cfg.name] = ServerState(cfg.name, cfg)
            ev = threading.Event()
            ready.append((st, ev))
            self._tasks.append(asyncio.run_coroutine_threadsafe(self._serve(st, ev), loop))
        for st, ev in ready:
            if not ev.wait(timeout) and st.status == "pending":
                st.status, st.error = "failed", f"connection timed out after {timeout:.0f}s"

    async def _serve(self, st: ServerState, ready: threading.Event) -> None:
        from contextlib import AsyncExitStack

        from mcp import ClientSession, StdioServerParameters, stdio_client

        st._stop = asyncio.Event()
        try:
            async with AsyncExitStack() as stack:
                if st.config.type == "http":
                    from mcp.client.streamable_http import streamable_http_client

                    streams = await stack.enter_async_context(streamable_http_client(st.config.url))
                    read, write = streams[0], streams[1]
                else:
                    self.log_dir.mkdir(parents=True, exist_ok=True)
                    # server 的 stderr（日志）写文件，不能混进终端，更不能进 stdout（那是协议通道）
                    errlog = stack.enter_context(open(self.log_dir / f"mcp-{st.name}.log", "a", encoding="utf-8"))
                    params = StdioServerParameters(command=st.config.command, args=st.config.args,
                                                   env={**os.environ, **st.config.env} if st.config.env else None)
                    read, write = await stack.enter_async_context(stdio_client(params, errlog=errlog))
                session = await stack.enter_async_context(ClientSession(read, write))
                init = await session.initialize()
                st.instructions = init.instructions or ""
                st.tools = (await session.list_tools()).tools
                st.session, st.status = session, "connected"
                ready.set()
                await st._stop.wait()          # 常驻：直到 close()
        except BaseException as e:  # noqa: BLE001 —— 子进程起不来、握手失败……都记下来，不往外抛
            if st.status != "connected":
                st.status = "failed"
                st.error = f"{type(e).__name__}: {e}"[:300]
        finally:
            if st.status == "connected":
                st.status = "closed"
            ready.set()

    def call(self, server: str, tool: str, args: dict[str, Any], timeout: float = CALL_TIMEOUT) -> ToolResult:
        st = self.servers.get(server)
        if st is None or st.status != "connected" or self._loop is None:
            return ToolResult(f"MCP server {server} is not connected ({st.status if st else 'unknown'}).", True)
        fut = asyncio.run_coroutine_threadsafe(st.session.call_tool(tool, args), self._loop)
        try:
            r = fut.result(timeout)
        except TimeoutError:
            fut.cancel()
            return ToolResult(f"MCP tool {tool} timed out after {timeout:.0f}s.", True)
        return ToolResult(convert_content(getattr(r, "content", []) or []), bool(getattr(r, "is_error", False)))

    def close(self) -> None:
        if self._loop is None:
            return
        for st in self.servers.values():
            if st._stop is not None:
                self._loop.call_soon_threadsafe(st._stop.set)
        for t in self._tasks:
            try:
                t.result(5)
            except Exception:  # noqa: BLE001
                pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(5)
        self._loop = None

    # ------------------------------------------------------------ 给 Agent 用

    def tools(self) -> list[Tool]:
        out: list[Tool] = []
        for st in self.servers.values():
            if st.status == "connected":
                out += [McpTool(self, st.name, t) for t in st.tools]
        return out

    def instructions_section(self) -> str | None:
        """挂 ContextBuilder.system_sections：server 自带的使用说明（Claude Code 叫 MCP Server Instructions）。"""
        parts = [f"## {st.name}\n{st.instructions.strip()}" for st in self.servers.values()
                 if st.status == "connected" and st.instructions.strip()]
        if not parts:
            return None
        return ("# MCP server instructions\nThe following MCP servers are connected and gave these instructions "
                "for their tools (named mcp__<server>__<tool>):\n\n" + "\n\n".join(parts))


class McpTool(Tool):
    kind = "mcp"

    def __init__(self, manager: McpManager, server: str, tool: Any):
        self.manager, self.server, self.remote_name = manager, server, tool.name
        self.name = mcp_tool_name(server, tool.name)
        self.description = tool.description or f"MCP tool {tool.name} from server {server}"
        self.input_schema = tool.input_schema or {"type": "object", "properties": {}}
        ann = tool.annotations
        # readOnlyHint 是 server 自己声明的「我不改东西」。它只是提示，所以只用来**放宽**审批，不用来做安全边界
        self.read_only = bool(ann and ann.read_only_hint)

    def summary(self, args) -> str:
        first = next(iter(args.values()), "") if args else ""
        return f"{self.name}({str(first)[:50]})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        return self.manager.call(self.server, self.remote_name, args)


# ---------------------------------------------------------------- 批准项目级 server


class Approvals:
    """<home>/mcp-approvals.json：{项目目录: {server 名: 配置指纹}}。"""

    def __init__(self, path: Path, project: str):
        self.path, self.project = path, project
        self.data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def approved(self, cfg: ServerConfig) -> bool:
        return self.data.get(self.project, {}).get(cfg.name) == cfg.fingerprint()

    def approve(self, cfg: ServerConfig) -> None:
        self.data.setdefault(self.project, {})[cfg.name] = cfg.fingerprint()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")


def select_servers(configs: dict[str, ServerConfig], approvals: Approvals,
                   ask: Callable[[str], str], info: Callable[[str], None]) -> tuple[list[ServerConfig], list[ServerConfig]]:
    """项目级 server 没批准过就问一次。返回 (要启动的, 被拒绝的)。"""
    start, rejected = [], []
    for cfg in configs.values():
        if cfg.scope == "user" or approvals.approved(cfg):
            start.append(cfg)
            continue
        info(f"项目 .mcp.json 声明了 MCP server {cfg.name}：{cfg.describe()}")
        info("  它会以你的身份在本机运行。是否启动？  1. 启动并记住  2. 本次不启动")
        if ask("选择 [1/2]: ").strip().startswith("1"):
            approvals.approve(cfg)
            start.append(cfg)
        else:
            rejected.append(cfg)
    return start, rejected
