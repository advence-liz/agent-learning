"""不抓包也能看：直接读 ~/.claude/projects/*/*.jsonl 的**结构**（不打印任何正文）。

    uv run python -m http_analyzer.session_stats types              # 记录类型分布
    uv run python -m http_analyzer.session_stats cache [N]          # 最近 N 个会话前几轮的 usage 链
    uv run python -m http_analyzer.session_stats compact            # 所有 compact_boundary 的元数据
    uv run python -m http_analyzer.session_stats shape              # 最近一次 api-request-shape 的骨架

注意：jsonl 是 Claude Code 的内部存储格式，没有官方 schema，字段随版本变化。
本脚本只读结构字段（type / usage / 长度），不输出消息文本。
"""

from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

ROOT = Path.home() / ".claude" / "projects"


def iter_records(files):
    for f in files:
        with open(f, errors="ignore") as fh:
            for line in fh:
                try:
                    yield f, json.loads(line)
                except ValueError:
                    continue


def all_files():
    return sorted(ROOT.glob("*/*.jsonl"), key=lambda p: p.stat().st_mtime)


def cmd_types():
    c = collections.Counter(r.get("type") for _, r in iter_records(all_files()))
    for k, v in c.most_common():
        print(f"{v:>8}  {k}")


def usage_chain(path: Path, limit: int = 5):
    """主线程（非 sidechain）每次 API 响应的 usage；同一 message.id 的多条记录只算一次。"""
    seen, rows = set(), []
    for _, r in iter_records([path]):
        if r.get("type") != "assistant" or r.get("isSidechain"):
            continue
        m = r.get("message") or {}
        u = m.get("usage")
        if not u or m.get("id") in seen:
            continue
        seen.add(m.get("id"))
        rows.append((u.get("input_tokens", 0), u.get("cache_creation_input_tokens", 0),
                     u.get("cache_read_input_tokens", 0), u.get("output_tokens", 0)))
        if len(rows) >= limit:
            break
    return rows


def cmd_cache(n: int = 3):
    shown = 0
    for f in reversed(all_files()):
        rows = usage_chain(f)
        if len(rows) < 4:
            continue
        print(f"session {f.stem[:8]}   input  cache_create  cache_read  output   read(n)==read(n-1)+create(n-1)?")
        for i, (inp, cc, cr, out) in enumerate(rows):
            ok = "" if i == 0 else ("yes" if cr == rows[i - 1][1] + rows[i - 1][2] else "no")
            print(f"  turn {i + 1}  {inp:>7} {cc:>13} {cr:>11} {out:>7}   {ok}")
        shown += 1
        if shown >= n:
            break


def cmd_compact():
    rows = []
    for _, r in iter_records(all_files()):
        if r.get("type") == "system" and r.get("subtype") == "compact_boundary":
            m = r.get("compactMetadata") or {}
            rows.append((m.get("trigger"), m.get("preTokens"), m.get("postTokens")))
    print(f"{len(rows)} compact boundaries")
    by = collections.Counter(t for t, _, _ in rows)
    print("by trigger:", dict(by))
    ratios = sorted(post / pre for _, pre, post in rows if pre and post)
    if ratios:
        print(f"post/pre ratio: min {ratios[0]:.3f}  median {ratios[len(ratios) // 2]:.3f}  max {ratios[-1]:.3f}")
    pres = sorted(pre for t, pre, _ in rows if t == "auto" and pre)
    if pres:
        print(f"auto preTokens: min {pres[0]}  median {pres[len(pres) // 2]}  max {pres[-1]}")


def cmd_shape():
    last = None
    for _, r in iter_records(all_files()[-20:]):
        if r.get("type") == "api-request-shape":
            last = r
    if not last:
        print("no api-request-shape record found (this record type may not exist in your version)")
        return
    s = last["shape"]
    print("version", last.get("version"))
    for i, b in enumerate(s.get("system", [])):
        print(f"system[{i}] {len(b.get('text', ''))} chars")
    names = [t.get("name") for t in s.get("tools", [])]
    builtin = [x for x in names if not str(x).startswith("mcp__")]
    print(f"tools: {len(names)} total, {len(names) - len(builtin)} mcp__*, built-in: {builtin}")
    print("deferred:", sum(1 for t in s.get("tools", []) if t.get("defer_loading")))


def main(argv=None):
    argv = argv or sys.argv[1:]
    cmd = argv[0] if argv else "types"
    if cmd == "types":
        cmd_types()
    elif cmd == "cache":
        cmd_cache(int(argv[1]) if len(argv) > 1 else 3)
    elif cmd == "compact":
        cmd_compact()
    elif cmd == "shape":
        cmd_shape()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
