#!/usr/bin/env python3
"""演示用 Stop hook：「没看到测试通过的证据就不许停」。

Stop 事件的 stdin 带 transcript_path 和 stop_hook_active。
  - stop_hook_active == true 表示「这次 Stop 本身就是被某个 Stop hook 拦回去之后再次触发的」，
    官方建议此时直接放行，避免死循环（Claude Code 另有连续 8 次的硬上限）。
  - 拦截方式：stdout 输出 {"decision": "block", "reason": "..."}，reason 会作为下一步指令喂回模型。

这里用一个极简规则：transcript 最后 N 行里要出现 "passed" 字样（模拟 pytest 输出）。
真实 transcript 是 jsonl，每行一条记录；本 demo 只做字符串搜索。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def decide(payload: dict) -> dict | None:
    if payload.get("stop_hook_active"):
        return None  # 已经拦过一次，放行
    tp = payload.get("transcript_path")
    tail = ""
    if tp and Path(tp).exists():
        tail = "\n".join(Path(tp).read_text(encoding="utf-8").splitlines()[-50:])
    if "passed" in tail:
        return None
    return {
        "decision": "block",
        "reason": "还没看到测试通过的输出。请运行 `uv run pytest -q` 并把结果贴出来再结束。",
    }


def main() -> None:
    payload = json.load(sys.stdin)
    out = decide(payload)
    if out:
        print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
