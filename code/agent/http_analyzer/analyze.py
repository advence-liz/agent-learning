"""读抓包目录，把一次 /v1/messages 请求拆成「system / tools / messages / cache 断点 / usage」。

    uv run python -m http_analyzer.analyze captures/                # 所有请求的一行摘要
    uv run python -m http_analyzer.analyze captures/ --show 3       # 拆开第 3 个请求
    uv run python -m http_analyzer.analyze captures/ --prefix 3 4   # 两次请求的公共前缀（解释缓存命中）
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(capdir: Path, idx: int) -> tuple[dict, dict]:
    d = sorted(p for p in capdir.iterdir() if p.is_dir())[idx - 1]
    req = json.loads((d / "request.json").read_text())
    resp = json.loads((d / "response.json").read_text())
    return req, resp


def _blocks(content) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content or []


def _size(b: dict) -> int:
    return len(json.dumps(b, ensure_ascii=False))


def cache_breakpoints(body: dict) -> list[str]:
    """按 API 的前缀顺序 tools → system → messages 找出所有 cache_control 位置。"""
    out = []
    for i, t in enumerate(body.get("tools", [])):
        if "cache_control" in t:
            out.append(f"tools[{i}]({t.get('name')})")
    sysp = body.get("system")
    for i, b in enumerate(_blocks(sysp) if sysp else []):
        if "cache_control" in b:
            out.append(f"system[{i}] {b['cache_control']}")
    for i, m in enumerate(body.get("messages", [])):
        for j, b in enumerate(_blocks(m.get("content"))):
            if isinstance(b, dict) and "cache_control" in b:
                out.append(f"messages[{i}].content[{j}] {b['cache_control']}")
    return out


def show(req: dict, resp: dict) -> str:
    body = req["body"]
    lines = [f"{req['method']} {req['path']}  body={req['body_bytes']} bytes  model={body.get('model')}"]
    beta = req["headers"].get("anthropic-beta") or req["headers"].get("Anthropic-Beta")
    if beta:
        lines.append(f"anthropic-beta: {beta}")
    lines.append("-- system")
    for i, b in enumerate(_blocks(body.get("system"))):
        head = b.get("text", "")[:60].replace("\n", " ")
        lines.append(f"  [{i}] {len(b.get('text', ''))} chars  {head!r}")
    tools = body.get("tools", [])
    lines.append(f"-- tools ({len(tools)})")
    for t in tools:
        flag = " defer_loading" if t.get("defer_loading") else ""
        lines.append(f"  {t.get('name', t.get('type'))}: {_size(t)} bytes{flag}")
    lines.append(f"-- messages ({len(body.get('messages', []))})")
    for i, m in enumerate(body.get("messages", [])):
        parts = [f"{b.get('type')}:{_size(b)}" for b in _blocks(m.get("content")) if isinstance(b, dict)]
        lines.append(f"  [{i}] {m['role']}: {', '.join(parts)}")
    lines.append("-- cache_control breakpoints")
    lines += [f"  {x}" for x in cache_breakpoints(body)] or ["  (none)"]
    msg = resp.get("message") or resp.get("body") or {}
    if isinstance(msg, dict) and msg.get("usage"):
        lines.append(f"-- usage {json.dumps(msg['usage'])}")
    return "\n".join(lines)


def linearize(body: dict) -> list[str]:
    """把请求按缓存前缀顺序展开成一串「块」，用来比较两次请求的公共前缀。"""
    seq = [json.dumps(t, sort_keys=True) for t in body.get("tools", [])]
    seq += [json.dumps({k: v for k, v in b.items() if k != "cache_control"}, sort_keys=True)
            for b in _blocks(body.get("system"))]
    for m in body.get("messages", []):
        for b in _blocks(m.get("content")):
            if isinstance(b, dict):
                b = {k: v for k, v in b.items() if k != "cache_control"}
            seq.append(m["role"] + ":" + json.dumps(b, sort_keys=True))
    return seq


def common_prefix(a: dict, b: dict) -> tuple[int, int, int]:
    sa, sb = linearize(a), linearize(b)
    n = 0
    while n < min(len(sa), len(sb)) and sa[n] == sb[n]:
        n += 1
    return n, len(sa), len(sb)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("capdir", type=Path)
    ap.add_argument("--show", type=int)
    ap.add_argument("--prefix", type=int, nargs=2)
    a = ap.parse_args(argv)
    if a.show:
        print(show(*load(a.capdir, a.show)))
    elif a.prefix:
        (ra, _), (rb, _) = load(a.capdir, a.prefix[0]), load(a.capdir, a.prefix[1])
        n, la, lb = common_prefix(ra["body"], rb["body"])
        print(f"request {a.prefix[0]}: {la} blocks, request {a.prefix[1]}: {lb} blocks, "
              f"shared prefix: {n} blocks")
    else:
        idx = a.capdir / "index.jsonl"
        for line in idx.read_text().splitlines():
            print(line)


if __name__ == "__main__":
    main()
