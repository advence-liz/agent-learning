import json

from streaming.sse import FIXTURE, Accumulator, lines_from_chunks, parse_sse, via_sdk


def _assemble(lines):
    acc = Accumulator()
    for _, ev in parse_sse(lines):
        acc.feed(ev)
    return acc.message


def test_tool_input_assembled_only_at_stop():
    msg = _assemble(FIXTURE.open())
    assert msg["stop_reason"] == "tool_use"
    assert msg["content"][1]["input"] == {"path": "calc.py", "content": "def add(a, b):\n    return a + b\n"}
    assert msg["usage"] == {"input_tokens": 412, "output_tokens": 58}


def test_arbitrary_network_chunking():
    data = FIXTURE.read_bytes()
    for size in (1, 3, 7, 64):  # 1 字节一块：汉字的 UTF-8 也会被切开
        chunks = [data[i : i + size] for i in range(0, len(data), size)]
        assert _assemble(lines_from_chunks(chunks)) == _assemble(FIXTURE.open())


def test_sse_multiline_data_and_comments():
    raw = [": keep-alive\n", "event: x\n", 'data: {"a":\n', "data: 1}\n", "\n"]
    assert list(parse_sse(raw)) == [("x", {"a": 1})]


def test_matches_real_sdk_accumulation():
    kinds, final = via_sdk()
    assert "ping" not in kinds  # SDK 把心跳吞掉了
    ours = _assemble(FIXTURE.open())
    assert final.model_dump(exclude_none=True)["content"] == ours["content"]
