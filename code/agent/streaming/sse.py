"""第 9 章：手写 SSE 解析 + 流式消息拼装（含 tool_use 参数的 input_json_delta 拼接）。

fixture.sse 是按 Messages API 流式事件格式手工构造的一段响应（离线，不是真实录制）。
  uv run python -m streaming.sse            # 逐事件回放，打印拼装过程
  uv run python -m streaming.sse --sdk      # 同一段字节喂给真实 anthropic SDK（MockTransport），对比结果
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Iterable, Iterator

FIXTURE = Path(__file__).parent / "fixture.sse"


# ---------- 1. SSE 帧解析：空行分隔事件，每行 "field: value" ----------
def parse_sse(lines: Iterable[str]) -> Iterator[tuple[str, dict[str, Any]]]:
    event, data = "message", []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":  # 空行 = 一个事件结束
            if data:
                yield event, json.loads("\n".join(data))
            event, data = "message", []
        elif line.startswith(":"):  # 注释行（常被用作心跳）
            continue
        else:
            field, _, value = line.partition(":")
            value = value.removeprefix(" ")
            if field == "event":
                event = value
            elif field == "data":
                data.append(value)  # 多行 data 要用 \n 拼回去
    if data:
        yield event, json.loads("\n".join(data))


def lines_from_chunks(chunks: Iterable[bytes]) -> Iterator[str]:
    """网络 chunk 的边界和事件边界无关（可能切在一个汉字的 UTF-8 字节中间），先按行重组。"""
    buf = b""
    for c in chunks:
        buf += c
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line.decode("utf-8") + "\n"
    if buf:
        yield buf.decode("utf-8")


# ---------- 2. 事件 → 完整消息 ----------
class Accumulator:
    def __init__(self) -> None:
        self.message: dict[str, Any] = {}
        self._json_buf: dict[int, str] = {}  # index → 尚未闭合的 tool 参数 JSON 片段

    def feed(self, ev: dict[str, Any]) -> str | None:
        """吃一个事件；返回一句人类可读的说明（演示用）。"""
        t = ev["type"]
        if t == "message_start":
            self.message = ev["message"]
            return f"开始 id={self.message['id']} input_tokens={self.message['usage']['input_tokens']}"
        if t == "content_block_start":
            block = dict(ev["content_block"])
            self.message["content"].append(block)  # index 就是它在 content 里的位置
            if block["type"] == "tool_use":
                self._json_buf[ev["index"]] = ""
                return f"[{ev['index']}] tool_use 开始 name={block['name']}（参数还没来）"
            return f"[{ev['index']}] {block['type']} 块开始"
        if t == "content_block_delta":
            i, d = ev["index"], ev["delta"]
            block = self.message["content"][i]
            if d["type"] == "text_delta":
                block["text"] += d["text"]
                return f"[{i}] +{d['text']!r:<14} → {block['text']}"
            if d["type"] == "input_json_delta":
                self._json_buf[i] += d["partial_json"]
                buf = self._json_buf[i]
                return f"[{i}] +{d['partial_json']!r:<32} 缓冲区能解析吗？{_parses(buf)}"
            if d["type"] == "thinking_delta":
                block["thinking"] += d["thinking"]
            elif d["type"] == "signature_delta":
                block["signature"] = d["signature"]
            return None
        if t == "content_block_stop":
            i = ev["index"]
            if i in self._json_buf:  # 只有到 stop 才保证 JSON 完整
                raw = self._json_buf.pop(i)
                self.message["content"][i]["input"] = json.loads(raw) if raw else {}
                return f"[{i}] tool_use 结束 → input={self.message['content'][i]['input']}"
            return f"[{i}] 块结束"
        if t == "message_delta":
            self.message.update(ev["delta"])  # stop_reason 在这里才出现
            self.message["usage"].update(ev["usage"])  # output_tokens 是累计值，直接覆盖
            return f"message_delta stop_reason={ev['delta']['stop_reason']} output_tokens={ev['usage']['output_tokens']}"
        if t == "message_stop":
            return "结束"
        if t == "ping":
            return "ping（心跳，忽略）"
        if t == "error":
            raise RuntimeError(ev["error"])  # 流中途也可能来 error 事件（如 overloaded_error）
        return None


def _parses(s: str) -> str:
    try:
        json.loads(s)
        return "✔"
    except json.JSONDecodeError:
        return "✘"


def replay(path: Path = FIXTURE) -> dict[str, Any]:
    acc = Accumulator()
    with path.open() as f:
        for name, ev in parse_sse(f):
            note = acc.feed(ev)
            if note:
                print(f"{name:20} {note}")
    return acc.message


# ---------- 3. 同样的字节交给真 SDK：验证我们拼得对 ----------
def via_sdk(path: Path = FIXTURE):
    import anthropic
    import httpx2

    body = path.read_bytes()

    def handler(request: httpx2.Request) -> httpx2.Response:
        assert json.loads(request.content)["stream"] is True
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    client = anthropic.Anthropic(
        api_key="offline-fake-key",
        base_url="http://offline.invalid",  # 永远不会真的发出去：MockTransport 截住了
        http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler)),
    )
    with client.messages.stream(
        model="claude-opus-5-5", max_tokens=64000, messages=[{"role": "user", "content": "修 calc.py"}]
    ) as stream:
        kinds = [ev.type for ev in stream]
        final = stream.get_final_message()
    return kinds, final


if __name__ == "__main__":
    msg = replay()
    print("\n拼装结果：")
    print(json.dumps(msg, ensure_ascii=False, indent=2))
    if "--sdk" in sys.argv:
        kinds, final = via_sdk()
        print("\nSDK 产出的事件类型：", kinds)
        print("SDK final message 的 tool_use.input：", final.content[1].input)
        print("与手写拼装一致：", final.model_dump(exclude_none=True)["content"] == msg["content"])
