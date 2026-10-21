import importlib


def test_pydantic_ai_offline():
    m = importlib.import_module("sdk_compare.pydantic_ai_agent")
    r = m.agent.run_sync("修好 calc.py")
    assert r.output.fixed and "a + b" in m.FILES["calc.py"]
    assert r.usage.tool_calls == 2 and r.usage.requests == 3


def test_langgraph_offline():
    m = importlib.import_module("sdk_compare.langgraph_agent")
    final = m.app.invoke({"messages": [{"role": "user", "content": "x"}], "step": 0})
    assert [x["role"] for x in final["messages"]] == ["user", "assistant", "tool", "assistant", "tool", "assistant"]
    assert "a + b" in m.FILES["calc.py"]
