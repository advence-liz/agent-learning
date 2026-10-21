from fake_llm import FakeAnthropic, text, tool_use
from rag.rag import Index
from workflow.triage import FEEDBACK, agent, workflow


def test_workflow_gate_retries_once():
    c = FakeAnthropic([text('{"label": "bug"}'), text("缺格式"), text("复现步骤 期望 实际")])
    trace: list[str] = []
    out = workflow(c, Index.from_dir(), FEEDBACK, trace)
    assert trace == ["classify → bug", "gate ✗ → retry", "gate ✓"]
    assert len(c.calls) == 3 and "复现步骤" in out


def test_workflow_question_path_is_fixed():
    c = FakeAnthropic([text('{"label": "question"}'), text("不限次数")])
    trace: list[str] = []
    workflow(c, Index.from_dir(), "Pro 能导出几次", trace)
    assert trace[0] == "classify → question" and trace[1].startswith("retrieve")
    assert "tools" not in c.calls[1]  # workflow 的每一步都不给模型工具


def test_agent_decides_its_own_path():
    c = FakeAnthropic([
        tool_use("search_docs", {"query": "导出"}),
        tool_use("create_ticket", {"title": "t", "body": "b"}),
        text("done"),
    ])
    trace: list[str] = []
    assert agent(c, Index.from_dir(), FEEDBACK, trace) == "done"
    assert [t.split("(")[0] for t in trace if t.startswith("⏺")] == ["⏺ search_docs", "⏺ create_ticket"]
    assert c.calls[0]["tools"][0]["name"] == "search_docs"
