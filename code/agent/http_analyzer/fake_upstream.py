"""离线假上游：模拟 /v1/messages 的流式 SSE 响应，用来自测代理，不碰真实 Anthropic。

它还会「假装」实现 prompt cache：在每个 cache_control 断点处记下前缀，
下次请求取最长的已记前缀算作 cache_read。数字是按字符数/4 粗估的，只为演示形状。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _blocks(c):
    return [{"type": "text", "text": c}] if isinstance(c, str) else (c or [])


def _linear(body: dict) -> tuple[list[str], list[int]]:
    """按缓存前缀顺序 tools → system → messages 展开成块序列，并返回带断点的块下标。"""
    seq, bps = [], []
    items = [("tools", t) for t in body.get("tools", [])]
    items += [("system", b) for b in _blocks(body.get("system"))]
    for m in body.get("messages", []):
        items += [(m["role"], b) for b in _blocks(m.get("content"))]
    for i, (role, b) in enumerate(items):
        if isinstance(b, dict) and "cache_control" in b:
            bps.append(i)
            b = {k: v for k, v in b.items() if k != "cache_control"}
        seq.append(role + json.dumps(b, sort_keys=True, ensure_ascii=False))
    return seq, bps


class FakeAnthropic:
    """极简 prompt cache 模型：
    - 写：每个 cache_control 断点处，把「从头到这个块」的前缀记下来；
    - 读：找本次请求里最长的、之前写过的前缀 → cache_read；
    - 最后一个断点之前、没命中的部分 → cache_creation；断点之后 → 普通 input。
    token 数按字符数 / 4 粗估，只为演示三个字段的关系。
    """

    def __init__(self):
        self.store: set[str] = set()
        self.received_headers: list[dict] = []
        self.lock = threading.Lock()

    def usage_for(self, body: dict) -> dict:
        seq, bps = _linear(body)
        cum, acc = [], ""
        for s in seq:
            acc += s
            cum.append(acc)
        with self.lock:
            hit = max((i + 1 for i in range(len(seq)) if cum[i] in self.store), default=0)
            for i in bps:
                self.store.add(cum[i])
        last_bp = (bps[-1] + 1) if bps else 0
        tok = lambda a, b: sum(len(x) for x in seq[a:b]) // 4
        read = tok(0, hit)
        create = tok(hit, last_bp) if last_bp > hit else 0
        rest = tok(max(hit, last_bp), len(seq))
        return {"input_tokens": rest, "cache_creation_input_tokens": create,
                "cache_read_input_tokens": read, "output_tokens": 0}


def sse_frames(model: str, text: str, usage: dict) -> list[bytes]:
    def ev(name, data):
        return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()

    start_usage = dict(usage, output_tokens=1)
    frames = [
        ev("message_start", {"type": "message_start", "message": {
            "id": "msg_fake_001", "type": "message", "role": "assistant", "model": model,
            "content": [], "stop_reason": None, "usage": start_usage}}),
        ev("content_block_start", {"type": "content_block_start", "index": 0,
                                   "content_block": {"type": "text", "text": ""}}),
        ev("ping", {"type": "ping"}),
    ]
    for piece in (text[: len(text) // 2], text[len(text) // 2:]):
        frames.append(ev("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                 "delta": {"type": "text_delta", "text": piece}}))
    frames += [
        ev("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                             "usage": {"output_tokens": max(1, len(text) // 2)}}),
        ev("message_stop", {"type": "message_stop"}),
    ]
    return frames


def make_server(port: int = 0) -> tuple[ThreadingHTTPServer, FakeAnthropic]:
    state = FakeAnthropic()

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            state.received_headers.append({k.lower(): v for k, v in self.headers.items()})
            if self.headers.get("x-api-key") is None and self.headers.get("authorization") is None:
                msg = b'{"type":"error","error":{"type":"authentication_error","message":"no key"}}'
                self.send_response(401)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return
            usage = state.usage_for(body)
            frames = sse_frames(body.get("model", "fake"), "你好！我是离线假模型。", usage)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("request-id", "req_fake_123")
            self.send_header("content-length", str(sum(len(f) for f in frames)))
            self.end_headers()
            for f in frames:
                self.wfile.write(f)
                self.wfile.flush()

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    srv.daemon_threads = True
    return srv, state
