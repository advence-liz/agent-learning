"""把 Messages API 的 SSE 流解析成事件，并重组出最终的 message 对象。

SSE 帧格式：若干行 `event: xxx` / `data: {...}`，以空行分隔。
Messages API 的事件序列：
  message_start → (content_block_start → content_block_delta* → content_block_stop)* → message_delta → message_stop
中间可能穿插 ping、error。
"""

from __future__ import annotations

import json
from typing import Iterable


def parse_sse(raw: str) -> list[dict]:
    """返回 [{"event": str, "data": obj|str}, ...]。"""
    events: list[dict] = []
    event, data_lines = None, []
    for line in raw.splitlines() + [""]:
        if line == "":
            if event is not None or data_lines:
                data = "\n".join(data_lines)
                try:
                    obj = json.loads(data)
                except ValueError:
                    obj = data
                events.append({"event": event or "message", "data": obj})
            event, data_lines = None, []
        elif line.startswith(":"):
            continue  # 注释行
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    return events


def assemble_message(events: Iterable[dict]) -> dict | None:
    """把增量事件拼回一个完整的 assistant message（和非流式响应同形）。"""
    msg: dict | None = None
    partial_json: dict[int, str] = {}
    for ev in events:
        d = ev["data"]
        if not isinstance(d, dict):
            continue
        t = d.get("type")
        if t == "message_start":
            msg = dict(d["message"])
            msg["content"] = list(msg.get("content", []))
        elif msg is None:
            continue
        elif t == "content_block_start":
            msg["content"].append(dict(d["content_block"]))
        elif t == "content_block_delta":
            block = msg["content"][d["index"]]
            delta = d["delta"]
            dt = delta.get("type")
            if dt == "text_delta":
                block["text"] = block.get("text", "") + delta["text"]
            elif dt == "thinking_delta":
                block["thinking"] = block.get("thinking", "") + delta["thinking"]
            elif dt == "signature_delta":
                block["signature"] = delta["signature"]
            elif dt == "input_json_delta":
                partial_json[d["index"]] = partial_json.get(d["index"], "") + delta["partial_json"]
        elif t == "content_block_stop":
            i = d["index"]
            if i in partial_json:
                try:
                    msg["content"][i]["input"] = json.loads(partial_json.pop(i) or "{}")
                except ValueError:
                    msg["content"][i]["input_raw"] = partial_json.pop(i, "")
        elif t == "message_delta":
            msg.update({k: v for k, v in d.get("delta", {}).items()})
            if "usage" in d:
                msg["usage"] = {**msg.get("usage", {}), **d["usage"]}
    return msg
