"""第 2 章：最小 Coding Agent —— tool_use → 执行 → tool_result 的 while 循环。

真实运行： uv run python -m coding_agent.agent "<任务>" [工作目录]
离线演示： uv run python -m coding_agent.demo
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

MODEL = "claude-opus-5-5"
SYSTEM = (
    "你是一个编程 Agent，工作目录是 {cwd}。"
    "先读代码再改；改完用 run_command 跑测试验证；全部完成后用一两句话总结。"
)

TOOLS = [
    {
        "name": "read_file",
        "description": "读取工作目录内一个文本文件的全部内容。",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "相对工作目录的路径"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "用 content 整体覆盖写入文件（不存在则创建）。",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "run_command",
        "description": "在工作目录执行一条 shell 命令，返回退出码和输出（超时 60 秒）。",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
]


def make_tools(cwd: Path) -> dict[str, Callable[..., str]]:
    root = cwd.resolve()

    def safe(path: str) -> Path:
        p = (root / path).resolve()
        if not p.is_relative_to(root):  # 模型给的路径是不可信输入
            raise ValueError(f"路径越界：{path}")
        return p

    def read_file(path: str) -> str:
        return safe(path).read_text()

    def write_file(path: str, content: str) -> str:
        p = safe(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return f"已写入 {path}（{len(content)} 字符）"

    def run_command(command: str) -> str:
        # 不写 .pyc：同一秒内改同样长度的 .py，Python 会按 mtime+size 误用旧缓存
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        r = subprocess.run(command, shell=True, cwd=root, env=env, capture_output=True, text=True, timeout=60)
        return f"exit={r.returncode}\n{(r.stdout + r.stderr)[-4000:]}"  # 截尾，防止撑爆上下文

    return {"read_file": read_file, "write_file": write_file, "run_command": run_command}


def run_agent(
    client: Any,
    task: str,
    cwd: Path,
    *,
    tools: dict[str, Callable[..., str]] | None = None,
    tool_specs: list[dict[str, Any]] | None = None,
    system: str | None = None,
    max_turns: int = 20,
    log: Callable[[str], None] = print,
) -> str:
    tools = tools or make_tools(cwd)
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]

    for turn in range(1, max_turns + 1):
        resp = client.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=system or SYSTEM.format(cwd=cwd),
            tools=tool_specs or TOOLS,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})

        calls = [b for b in resp.content if b.type == "tool_use"]
        if not calls:  # 模型不再要工具 → 任务结束
            return "".join(b.text for b in resp.content if b.type == "text")

        results = []
        for call in calls:  # 一轮可能有多个并行 tool_use，结果要放进同一条 user 消息
            log(f"⏺ {call.name}({_short(call.input)})")
            try:
                out, is_error = tools[call.name](**call.input), False
            except Exception as e:  # 工具出错也要回报给模型，让它自己纠正
                out, is_error = f"{type(e).__name__}: {e}", True
            log(f"  {'✘' if is_error else '✔'} {(out.splitlines() or [''])[-1][:70]}")
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": out, "is_error": is_error})
        messages.append({"role": "user", "content": results})

    return f"（达到 max_turns={max_turns}，强制停止）"


def _short(args: dict[str, Any], n: int = 60) -> str:
    s = ", ".join(f"{k}={v!r}" for k, v in args.items())
    return s if len(s) <= n else s[:n] + "…"


if __name__ == "__main__":
    import anthropic

    task = sys.argv[1]
    cwd = Path(sys.argv[2] if len(sys.argv) > 2 else ".")
    print(run_agent(anthropic.Anthropic(), task, cwd))
