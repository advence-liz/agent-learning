#!/usr/bin/env python3
"""演示用 PreToolUse hook：拦危险 Bash 命令。

协议（与 Claude Code hooks 文档一致）：
  - stdin：一个 JSON 对象，含 hook_event_name / tool_name / tool_input / cwd ...
  - 三种回应方式：
      exit 0 + 空 stdout         → 不表态，走正常权限流程
      exit 0 + stdout 是 JSON    → 用 hookSpecificOutput.permissionDecision 表态
      exit 2 + stderr            → 阻断，stderr 作为原因回灌给模型
  - 其它退出码（含 1）是「非阻断错误」，工具照常执行 —— 想拦必须 exit 2。

本脚本故意同时演示两种拦法：
  rm -rf /...      → exit 2（最硬：JSON 也救不回来）
  git push --force → JSON deny（带结构化理由）
  npm publish      → JSON ask（交给人确认）
  python3 ...      → JSON allow + updatedInput（改写参数：强制加 -I 隔离模式）
"""

from __future__ import annotations

import json
import re
import sys


def decide(payload: dict) -> tuple[int, str, str]:
    """返回 (exit_code, stdout, stderr)。纯函数，方便单测。"""
    if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") != "Bash":
        return 0, "", ""

    cmd: str = payload.get("tool_input", {}).get("command", "")

    if re.search(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+/(\s|$)", cmd) or re.search(r"\brm\s+-rf\s+~", cmd):
        return 2, "", f"拒绝：`{cmd}` 会删除根目录或家目录。请改成删除具体子目录。"

    if re.search(r"\bgit\s+push\b.*--force(?!-with-lease)", cmd):
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "禁止 --force，改用 --force-with-lease",
            }
        }
        return 0, json.dumps(out, ensure_ascii=False), ""

    if re.search(r"\bnpm\s+publish\b", cmd):
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": "发包需要人工确认",
            }
        }
        return 0, json.dumps(out, ensure_ascii=False), ""

    m = re.match(r"^\s*python3\s+(?!-I\b)(.*)$", cmd)
    if m:
        new_input = dict(payload["tool_input"], command=f"python3 -I {m.group(1)}")
        out = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "已自动加 -I 隔离模式",
                "updatedInput": new_input,
            }
        }
        return 0, json.dumps(out, ensure_ascii=False), ""

    return 0, "", ""


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        # 读不懂输入：fail-open（exit 1 = 非阻断错误）。安全敏感场景应改成 exit 2 fail-closed。
        print("guard_bash: stdin 不是 JSON", file=sys.stderr)
        sys.exit(1)
    code, out, err = decide(payload)
    if out:
        print(out)
    if err:
        print(err, file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
