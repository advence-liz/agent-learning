#!/usr/bin/env python3
"""/goal 的骨架：「干活的模型」+「验收的模型」两个角色，用 Stop 时机串成循环。

官方文档（code.claude.com/docs/en/goal）给出的行为：
  - /goal 是一个 session 级的 prompt 型 Stop hook 的包装；
  - 每轮结束，把「条件 + 到目前为止的对话」发给 small fast model（默认 Haiku 档）；
  - 返回三种判定之一并附简短理由：not yet met / met / impossible；
  - not yet met → 理由作为下一轮的指引，继续干；met / impossible → 清除目标；
  - 评审模型不调工具，只能看对话里已经出现的证据；
  - 有后台任务在跑时，本轮跳过评审；
  - 连续若干轮没有任何工具调用（只在「回嘴」）→ 停循环、警告、目标保留。

本文件只复刻这套控制流，「连续几轮无进展」的阈值取 3 是 demo 值（文档只说 several turns）。
真实评审调用见 make_llm_judge()；单测和 demo 全部用离线 fake，不发网络请求。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Callable, Protocol

NO_PROGRESS_LIMIT = 3  # demo 值


@dataclass
class Turn:
    text: str
    tool_calls: int = 0
    background_running: bool = False


@dataclass
class Verdict:
    status: str  # "not_met" | "met" | "impossible"
    reason: str


Judge = Callable[[str, list[dict]], Verdict]


class Worker(Protocol):
    def __call__(self, directive: str, transcript: list[dict]) -> Turn: ...


JUDGE_SYSTEM = (
    "你是验收员。只依据对话里已经出现的证据判断条件是否满足，不要假设对话里没出现的事。"
    "输出 JSON：status 取 not_met/met/impossible，reason 一句话说明还差什么或为什么满足。"
)

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["not_met", "met", "impossible"]},
        "reason": {"type": "string"},
    },
    "required": ["status", "reason"],
    "additionalProperties": False,
}


def render_for_judge(condition: str, transcript: list[dict]) -> str:
    convo = "\n".join(f"[{m['role']}] {m['content']}" for m in transcript)
    return f"<condition>\n{condition}\n</condition>\n<conversation>\n{convo}\n</conversation>"


def make_llm_judge(client) -> Judge:
    """真实评审：一次无工具的单轮调用 + 结构化输出。client 为 anthropic.Anthropic()。

    支持 ANTHROPIC_BASE_URL（SDK 自动读取）。本仓库的测试只注入 fake client。
    """
    model = os.environ.get("GOAL_JUDGE_MODEL", "claude-haiku-5-5")

    def judge(condition: str, transcript: list[dict]) -> Verdict:
        resp = client.messages.create(
            model=model,
            max_tokens=1024,
            system=JUDGE_SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
            messages=[{"role": "user", "content": render_for_judge(condition, transcript)}],
        )
        text = next(b.text for b in resp.content if b.type == "text")
        data = json.loads(text)
        return Verdict(data["status"], data["reason"])

    return judge


@dataclass
class GoalResult:
    outcome: str  # achieved / impossible / stalled / max_turns
    turns: int
    evaluations: int
    log: list[str] = field(default_factory=list)


def run_goal(condition: str, worker: Worker, judge: Judge, max_turns: int = 20) -> GoalResult:
    transcript: list[dict] = [{"role": "user", "content": condition}]  # 设目标即以条件为指令开第一轮
    directive = condition
    no_progress = 0
    evals = 0
    log: list[str] = []
    for i in range(1, max_turns + 1):
        turn = worker(directive, transcript)
        transcript.append({"role": "assistant", "content": turn.text})
        no_progress = 0 if turn.tool_calls else no_progress + 1
        if turn.background_running:
            log.append(f"turn {i}: 后台任务未结束 → 跳过评审")
            directive = "（后台任务完成通知）"
            continue
        if no_progress >= NO_PROGRESS_LIMIT:
            log.append(f"turn {i}: 连续 {no_progress} 轮无工具调用 → 停循环，目标保留")
            return GoalResult("stalled", i, evals, log)
        v = judge(condition, transcript)
        evals += 1
        log.append(f"turn {i}: judge={v.status} reason={v.reason}")
        if v.status == "met":
            return GoalResult("achieved", i, evals, log)
        if v.status == "impossible":
            return GoalResult("impossible", i, evals, log)
        # not_met：理由作为下一轮指令回灌 —— 和 Stop hook 的 decision:block + reason 是同一个形状
        directive = v.reason
        transcript.append({"role": "user", "content": f"[goal evaluator] {v.reason}"})
    return GoalResult("max_turns", max_turns, evals, log)


# ---------------- 离线 fake ----------------

def scripted_worker(turns: list[Turn]) -> Worker:
    it = iter(turns)

    def w(directive: str, transcript: list[dict]) -> Turn:
        return next(it)

    return w


def keyword_judge(condition: str, transcript: list[dict]) -> Verdict:
    """fake 评审：只看对话里有没有 '0 failed' 和 'lint clean' 两个证据。"""
    text = "\n".join(m["content"] for m in transcript if m["role"] == "assistant")
    missing = [k for k in ("0 failed", "lint clean") if k not in text]
    if "无法访问" in text:
        return Verdict("impossible", "测试依赖的服务无法访问，条件不可能达成")
    if missing:
        return Verdict("not_met", f"对话里还没出现证据：{', '.join(missing)}")
    return Verdict("met", "测试与 lint 证据都已出现")


if __name__ == "__main__":
    worker = scripted_worker([
        Turn("改了 auth.ts，跑测试：3 passed, 2 failed", tool_calls=3),
        Turn("后台起了 e2e，等结果", tool_calls=1, background_running=True),
        Turn("修了两个用例：5 passed, 0 failed", tool_calls=4),
        Turn("跑 lint：lint clean", tool_calls=1),
    ])
    r = run_goal("test/auth 全部通过且 lint clean", worker, keyword_judge)
    print("\n".join(r.log))
    print(f"outcome={r.outcome} turns={r.turns} evaluations={r.evaluations}")
