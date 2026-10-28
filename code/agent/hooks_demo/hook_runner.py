#!/usr/bin/env python3
"""一个「迷你 hook 调度器」：模拟 Claude Code 在主循环里怎么调用 hook、怎么解读结果。

只实现教学需要的子集（规则来自官方 hooks 文档）：
  1. 按 matcher 选中 hook（只支持「精确名 / a|b 列表 / 空=全匹配」）。
  2. 把事件 JSON 写进子进程 stdin，收 exit code / stdout / stderr。
  3. 解读：
     - exit 2           → 阻断类事件被阻断，stderr 是理由；JSON 被忽略
     - exit 0 + JSON    → 读 continue / decision / hookSpecificOutput
     - exit 0 + 纯文本  → SessionStart / UserPromptSubmit 当作上下文注入，其它事件只进 debug log
     - 其它退出码       → 非阻断错误，动作照常进行
  多个 hook 命中时，本 demo 取「最严格」的决定（deny > ask > allow）——这是 demo 的选择，
  以官方文档的合并规则为准。

用法：python3 hook_runner.py <settings.json> <event-json-file>
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass, field

BLOCKABLE = {"PreToolUse", "UserPromptSubmit", "Stop", "SubagentStop"}
PLAIN_STDOUT_IS_CONTEXT = {"SessionStart", "UserPromptSubmit"}
SEVERITY = {"allow": 0, "ask": 1, "deny": 2}


@dataclass
class Verdict:
    blocked: bool = False
    permission: str | None = None  # allow / ask / deny（PreToolUse）
    reason: str = ""
    updated_input: dict | None = None
    context: list[str] = field(default_factory=list)  # 要注入给模型的文字
    stop_session: bool = False  # continue:false
    log: list[str] = field(default_factory=list)


def matches(matcher: str | None, name: str) -> bool:
    if not matcher or matcher == "*":
        return True
    return name in matcher.split("|")


def run_one(cmd: str, payload: dict) -> tuple[int, str, str]:
    p = subprocess.run(cmd, shell=True, input=json.dumps(payload), capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def dispatch(settings: dict, payload: dict) -> Verdict:
    event = payload["hook_event_name"]
    target = payload.get("tool_name", "")
    v = Verdict()
    for group in settings.get("hooks", {}).get(event, []):
        if event in {"PreToolUse", "PostToolUse"} and not matches(group.get("matcher"), target):
            continue
        for h in group["hooks"]:
            code, out, err = run_one(h["command"], payload)
            v.log.append(f"{h['command']!r} -> exit={code}")
            if code == 2:
                if event in BLOCKABLE:
                    v.blocked, v.reason = True, err
                    if event == "PreToolUse":
                        v.permission = "deny"
                else:
                    v.log.append(f"  (exit 2 在 {event} 上不阻断；stderr 只给人看)")
                continue
            if code != 0:
                v.log.append(f"  非阻断错误，忽略：{err}")
                continue
            if not out:
                continue
            try:
                data = json.loads(out)
            except json.JSONDecodeError:
                if event in PLAIN_STDOUT_IS_CONTEXT:
                    v.context.append(out)
                else:
                    v.log.append("  纯文本 stdout，非上下文事件 → 仅进 debug log")
                continue
            if data.get("continue") is False:
                v.stop_session, v.reason = True, data.get("stopReason", "")
            if data.get("decision") == "block":
                v.blocked, v.reason = True, data.get("reason", "")
            hso = data.get("hookSpecificOutput") or {}
            pd = hso.get("permissionDecision")
            if pd and (v.permission is None or SEVERITY.get(pd, 0) > SEVERITY.get(v.permission, 0)):
                v.permission = pd
                v.reason = hso.get("permissionDecisionReason", "")
                if pd == "deny":
                    v.blocked = True
            if "updatedInput" in hso:
                v.updated_input = hso["updatedInput"]
            if hso.get("additionalContext"):
                v.context.append(hso["additionalContext"])
    return v


def main() -> None:
    settings = json.load(open(sys.argv[1]))
    payload = json.load(open(sys.argv[2]))
    v = dispatch(settings, payload)
    for line in v.log:
        print("·", line)
    print(json.dumps({k: val for k, val in v.__dict__.items() if k != "log"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
