"""离线演示：假上游 + 抓包代理 + 两次「像 Claude Code 一样」的请求，然后拆解抓包结果。

    uv run python -m http_analyzer.demo
"""

from __future__ import annotations

import json
import tempfile
import threading
from pathlib import Path

import httpx

from . import analyze
from .fake_upstream import make_server
from .proxy import serve

TOOLS = [
    {"name": "Read", "description": "Reads a file from the local filesystem." * 5,
     "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}},
                      "required": ["file_path"]}},
    {"name": "Bash", "description": "Executes a bash command." * 8,
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}},
                      "required": ["command"]}},
]
SYSTEM = [
    {"type": "text", "text": "You are a coding agent."},
    {"type": "text", "text": "# 行为规范\n" + "规则……" * 200,
     "cache_control": {"type": "ephemeral"}},
]


def body(messages):
    msgs = [dict(m) for m in messages]
    # 和 Claude Code 一样：在最后一条消息的最后一个块上打断点，让下一轮能读到这一轮的缓存
    last = msgs[-1]
    content = [{"type": "text", "text": last["content"]}] if isinstance(last["content"], str) else last["content"]
    content = [dict(b) for b in content]
    content[-1]["cache_control"] = {"type": "ephemeral"}
    msgs[-1] = {"role": last["role"], "content": content}
    return {"model": "claude-sonnet-5-5", "max_tokens": 1024, "stream": True,
            "system": SYSTEM, "tools": TOOLS, "messages": msgs}


def main():
    up, _ = make_server(0)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    out = Path(tempfile.mkdtemp(prefix="cap-"))
    px = serve(0, f"http://127.0.0.1:{up.server_port}", out)
    threading.Thread(target=px.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{px.server_port}"
    headers = {"x-api-key": "sk-ant-api03-THIS-IS-A-FAKE-KEY-0000000000",
               "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-demo"}

    turn1 = [{"role": "user", "content": "hi"}]
    turn2 = turn1 + [
        {"role": "assistant", "content": [{"type": "text", "text": "你好！我是离线假模型。"}]},
        {"role": "user", "content": "再说一句"},
    ]
    print("== proxy stdout")
    for msgs in (turn1, turn2):
        with httpx.stream("POST", base + "/v1/messages", json=body(msgs), headers=headers) as r:
            chunks = [c for c in r.iter_text()]
        assert r.status_code == 200 and "message_stop" in "".join(chunks)

    print("\n== analyze --show 1")
    print(analyze.show(*analyze.load(out, 1)))
    print("\n== analyze --prefix 1 2")
    (ra, _), (rb, _) = analyze.load(out, 1), analyze.load(out, 2)
    print("shared prefix blocks: %d / %d / %d" % analyze.common_prefix(ra["body"], rb["body"]))
    print("\n== request.json headers (redacted)")
    print(json.dumps(json.loads((sorted(out.iterdir())[0] / "request.json").read_text())["headers"],
                     indent=1)[:400])
    px.shutdown()
    up.shutdown()


if __name__ == "__main__":
    main()
