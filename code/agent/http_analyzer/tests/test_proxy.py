"""离线自测：假上游 + 代理。运行：uv run python -m unittest discover -s http_analyzer/tests -t ."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path

import httpx

from http_analyzer.analyze import cache_breakpoints, common_prefix
from http_analyzer.fake_upstream import make_server
from http_analyzer.proxy import serve
from http_analyzer.redact import redact_text
from http_analyzer.sse import assemble_message, parse_sse

FAKE_KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ-123456"


class ProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.up, cls.state = make_server(0)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        cls.out = Path(tempfile.mkdtemp())
        cls.px = serve(0, f"http://127.0.0.1:{cls.up.server_port}", cls.out)
        threading.Thread(target=cls.px.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.px.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.px.shutdown()
        cls.up.shutdown()

    def _post(self, body, key=FAKE_KEY):
        h = {"anthropic-version": "2023-06-01", "content-type": "application/json"}
        if key:
            h["x-api-key"] = key
        with httpx.stream("POST", self.base + "/v1/messages?beta=true", content=json.dumps(body), headers=h) as r:
            return r.status_code, r.headers, "".join(r.iter_text())

    def test_sse_passthrough_and_key_forwarded_but_redacted_on_disk(self):
        body = {"model": "m", "stream": True, "max_tokens": 10,
                "system": [{"type": "text", "text": "S" * 400, "cache_control": {"type": "ephemeral"}}],
                "messages": [{"role": "user", "content": "hi"}]}
        status, headers, text = self._post(body)
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", headers["content-type"])
        msg = assemble_message(parse_sse(text))
        self.assertEqual(msg["content"][0]["text"], "你好！我是离线假模型。")
        # 上游拿到的是真 key（代理只在落盘时脱敏）
        self.assertEqual(self.state.received_headers[-1]["x-api-key"], FAKE_KEY)
        # 磁盘上任何文件都不含 key
        for f in self.out.rglob("*"):
            if f.is_file():
                self.assertNotIn(FAKE_KEY, f.read_text())
        d = sorted(p for p in self.out.iterdir() if p.is_dir())[-1]
        resp = json.loads((d / "response.json").read_text())
        self.assertEqual(resp["message"]["stop_reason"], "end_turn")
        self.assertEqual(resp["sse_event_counts"]["content_block_delta"], 2)

    def test_cache_read_on_second_identical_prefix(self):
        sysb = [{"type": "text", "text": "X" * 800, "cache_control": {"type": "ephemeral"}}]
        b1 = {"model": "m", "stream": True, "system": sysb, "messages": [{"role": "user", "content": "a"}]}
        self._post(b1)
        self._post(b1)
        rows = [json.loads(l) for l in (self.out / "index.jsonl").read_text().splitlines()]
        last2 = [r["usage"] for r in rows[-2:]]
        self.assertGreater(last2[0]["cache_creation_input_tokens"], 0)
        self.assertEqual(last2[1]["cache_creation_input_tokens"], 0)
        self.assertGreater(last2[1]["cache_read_input_tokens"], 0)

    def test_upstream_error_status_is_passed_through(self):
        status, _, text = self._post({"model": "m", "messages": []}, key=None)
        self.assertEqual(status, 401)
        self.assertIn("authentication_error", text)


class UnitTest(unittest.TestCase):
    def test_redact_text_patterns(self):
        s = redact_text(f'{{"k": "{FAKE_KEY}", "auth": "Bearer abcdefghijklmnopqrstu"}}')
        self.assertNotIn("ABCDEFGHIJ", s)
        self.assertNotIn("abcdefghijklmnop", s)

    def test_tool_use_json_reassembly(self):
        raw = (
            'event: message_start\ndata: {"type":"message_start","message":{"id":"x","role":"assistant","content":[],"usage":{"input_tokens":3}}}\n\n'
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}\n\n'
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_pa"}}\n\n'
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"th\\": \\"/a.py\\"}"}}\n\n'
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n'
        )
        m = assemble_message(parse_sse(raw))
        self.assertEqual(m["content"][0]["input"], {"file_path": "/a.py"})
        self.assertEqual(m["stop_reason"], "tool_use")
        self.assertEqual(m["usage"], {"input_tokens": 3, "output_tokens": 9})

    def test_breakpoints_and_prefix(self):
        a = {"system": [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}],
             "messages": [{"role": "user", "content": "hi"}]}
        b = {"system": a["system"], "messages": a["messages"] + [{"role": "assistant", "content": "yo"}]}
        self.assertEqual(cache_breakpoints(a), ["system[0] {'type': 'ephemeral'}"])
        self.assertEqual(common_prefix(a, b), (2, 2, 3))


if __name__ == "__main__":
    unittest.main()
