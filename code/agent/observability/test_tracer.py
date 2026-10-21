from pathlib import Path

from coding_agent import demo
from fake_llm import FakeAnthropic, text, tool_use
from observability.tracer import Tracer, run_traced


def test_trace_tree_and_otlp(tmp_path: Path):
    demo.setup(tmp_path)
    script = [
        tool_use("read_file", {"path": "calc.py"}, input_tokens=100, output_tokens=10),
        tool_use("read_file", {"path": "nope.py"}, input_tokens=150, output_tokens=10),
        text("done", input_tokens=200, output_tokens=5),
    ]
    tr = Tracer()
    run_traced(FakeAnthropic(script), "x", tmp_path, tr, log=lambda s: None)

    names = [s.name for s in sorted(tr.spans, key=lambda s: s.start_ns)]
    assert names == ["invoke_agent coding_agent", "chat claude-opus-5-5", "execute_tool read_file",
                     "chat claude-opus-5-5", "execute_tool read_file", "chat claude-opus-5-5"]
    root = next(s for s in tr.spans if s.parent_id is None)
    assert all(s.parent_id == root.span_id for s in tr.spans if s is not root)
    assert root.attrs["agent.usage.input_tokens"] == 450 and root.attrs["agent.turns"] == 3

    tools = [s for s in tr.spans if s.name.startswith("execute_tool")]
    assert tools[0].error is None and "FileNotFoundError" in tools[1].error
    assert tools[0].attrs["gen_ai.tool.call.id"].startswith("toolu_")

    otlp = tr.to_otlp()["resourceSpans"][0]
    spans = otlp["scopeSpans"][0]["spans"]
    assert otlp["resource"]["attributes"][0] == {"key": "service.name", "value": {"stringValue": "mini-coding-agent"}}
    assert {s["status"]["code"] for s in spans} == {1, 2}
    assert all(len(s["traceId"]) == 32 and len(s["spanId"]) == 16 for s in spans)
