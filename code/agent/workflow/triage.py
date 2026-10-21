"""第 5 章：同一个任务的两种写法——Workflow（代码决定控制流） vs Agent（模型决定控制流）。

任务：把一条用户反馈分诊：bug → 整理成工单草稿；咨询 → 查资料回答；其它 → 礼貌回复。

离线演示： uv run python -m workflow.triage
"""

from __future__ import annotations

import json
from typing import Any

from coding_agent.agent import run_agent  # 直接复用第 2 章的 agent 循环，只换工具
from rag.rag import Index

MODEL = "claude-opus-5-5"


def _text(resp: Any) -> str:
    return "".join(b.text for b in resp.content if b.type == "text")


# ---------------------------------------------------------------- Workflow
CLASSIFY = '把用户反馈分类，只输出 JSON：{"label": "bug" | "question" | "other"}'
BUG = "把 bug 反馈整理成工单草稿，必须包含「复现步骤」「期望」「实际」三个小节。"


def workflow(client: Any, index: Index, feedback: str, trace: list[str]) -> str:
    # 步骤 1：分类（一次 LLM 调用，输出被代码解析）
    resp = client.messages.create(
        model=MODEL, max_tokens=256, system=CLASSIFY, messages=[{"role": "user", "content": feedback}]
    )
    label = json.loads(_text(resp))["label"]
    trace.append(f"classify → {label}")

    # 步骤 2：路由——if/else 写在代码里，模型无权改变
    if label == "bug":
        resp = client.messages.create(
            model=MODEL, max_tokens=2048, system=BUG, messages=[{"role": "user", "content": feedback}]
        )
        draft = _text(resp)
        # 步骤 3：闸门（gate）——用代码校验，不合格就重试一次
        if not all(k in draft for k in ("复现步骤", "期望", "实际")):
            trace.append("gate ✗ → retry")
            resp = client.messages.create(
                model=MODEL,
                max_tokens=2048,
                system=BUG,
                messages=[
                    {"role": "user", "content": feedback},
                    {"role": "assistant", "content": draft},
                    {"role": "user", "content": "缺少必需小节，请按格式重写。"},
                ],
            )
            draft = _text(resp)
        trace.append("gate ✓")
        return draft
    if label == "question":
        hits = index.search(feedback, 2)
        trace.append(f"retrieve → {[c.source for _, c in hits]}")
        docs = "\n".join(c.text for _, c in hits)
        resp = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system="只根据资料回答。",
            messages=[{"role": "user", "content": f"资料：\n{docs}\n\n问题：{feedback}"}],
        )
        return _text(resp)
    return "感谢反馈，我们已记录。"


# ---------------------------------------------------------------- Agent
def agent(client: Any, index: Index, feedback: str, trace: list[str]) -> str:
    tickets: list[str] = []

    def search_docs(query: str) -> str:
        return "\n".join(c.text for _, c in index.search(query, 2))

    def create_ticket(title: str, body: str) -> str:
        tickets.append(title)
        return f"已创建工单 #{100 + len(tickets)}：{title}"

    tools = {"search_docs": search_docs, "create_ticket": create_ticket}
    return run_agent(
        client,
        f"处理这条用户反馈：{feedback}",
        cwd=None,  # type: ignore[arg-type]
        tools=tools,
        tool_specs=AGENT_TOOLS,
        system=AGENT_SYSTEM,
        log=trace.append,
    )


AGENT_SYSTEM = "你是客服分诊 Agent。自己判断反馈类型：咨询就查资料回答，bug 就建工单，可以两件事都做。"
AGENT_TOOLS = [
    {
        "name": "search_docs",
        "description": "在产品帮助文档里检索，返回最相关的两段。",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "create_ticket",
        "description": "创建一张 bug 工单。body 需包含复现步骤、期望、实际。",
        "input_schema": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "body": {"type": "string"}},
            "required": ["title", "body"],
        },
    },
]


# ---------------------------------------------------------------- demo
FEEDBACK = "我是 Pro 会员，导出时一直转圈，到底 Pro 能导出几次？"

if __name__ == "__main__":
    from fake_llm import FakeAnthropic, text, tool_use

    index = Index.from_dir()

    print("=== Workflow：代码写死 classify → route → gate ===")
    wf_client = FakeAnthropic([
        text('{"label": "bug"}', input_tokens=40, output_tokens=8),
        text("## 现象\n导出一直转圈", input_tokens=60, output_tokens=40),  # 故意缺小节，触发 gate
        text("## 复现步骤\n1. 设置-数据管理-导出\n## 期望\n收到下载链接\n## 实际\n一直转圈"),
    ])
    trace: list[str] = []
    out = workflow(wf_client, index, FEEDBACK, trace)
    print("trace:", " | ".join(trace))
    print(f"LLM 调用 {len(wf_client.calls)} 次；输出：{out!r}")

    print("\n=== Agent：模型自己决定先查资料、再建工单 ===")
    ag_client = FakeAnthropic([
        tool_use("search_docs", {"query": "Pro 导出次数"}, say="先确认导出规则。"),
        tool_use("create_ticket", {"title": "Pro 用户导出卡在转圈", "body": "复现步骤…期望…实际…"}),
        text("Pro 会员导出不限次数；转圈的问题已建工单 #101 跟进。"),
    ])
    trace = []
    out = agent(ag_client, index, FEEDBACK, trace)
    print("trace:\n  " + "\n  ".join(trace))
    print(f"LLM 调用 {len(ag_client.calls)} 次；输出：{out!r}")
