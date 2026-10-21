from core.api_formats import send_all


def test_three_formats_on_the_wire():
    results, seen = send_all()
    by_path = {c.path: c for c in seen}
    a, c, r = by_path["/v1/messages"], by_path["/v1/chat/completions"], by_path["/v1/responses"]

    # 鉴权头
    assert "x-api-key" in a.headers and a.headers["anthropic-version"]
    assert c.headers["authorization"].startswith("Bearer ") and "x-api-key" not in c.headers

    # system 放在哪
    assert isinstance(a.body["system"], str) and all(m["role"] != "system" for m in a.body["messages"])
    assert c.body["messages"][0]["role"] == "system"
    assert "instructions" in r.body and "messages" not in r.body

    # 工具定义的嵌套
    assert "input_schema" in a.body["tools"][0]
    assert "parameters" in c.body["tools"][0]["function"]
    assert "parameters" in r.body["tools"][0] and "function" not in r.body["tools"][0]

    # 工具结果怎么回去
    assert a.body["messages"][-1]["content"][0]["type"] == "tool_result"
    assert c.body["messages"][-1]["role"] == "tool"
    assert r.body["input"][-1]["type"] == "function_call_output"
    # OpenAI 两种格式里工具参数是 JSON 字符串，Anthropic 是对象
    assert isinstance(c.body["messages"][2]["tool_calls"][0]["function"]["arguments"], str)
    assert isinstance(a.body["messages"][1]["content"][0]["input"], dict)

    # 三种响应解析成同一个结果
    assert {u.text for u in results.values()} == {"超时是 15000ms。"}
    assert results["anthropic"].stop == "end_turn" and results["chat_completions"].stop == "stop"
