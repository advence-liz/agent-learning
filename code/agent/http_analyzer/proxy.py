"""Claude Code 抓包用的本地反向代理（明文 HTTP 入，HTTPS 出）。

用法：
    uv run python -m http_analyzer.proxy --port 8787 --out captures/
    ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude     # 另一个终端

为什么是「反向代理」而不是 mitmproxy 那种「中间人」：
    Claude Code 支持 ANTHROPIC_BASE_URL，客户端自己就会把请求发到我们这里，
    不需要伪造证书、不需要装根 CA。代理再用正常的 HTTPS 转发给上游。

每个请求落盘为 <out>/<seq>-<method>-<path>/：
    request.json      method / path / 脱敏 header / 解析后的 JSON body
    response.json     status / header / 若是 SSE 则附上重组后的 message
    response.raw      原始响应体（SSE 就是一行行 event/data）
    index.jsonl       <out> 下每个请求一行摘要
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

from .redact import redact_headers, redact_text
from .sse import assemble_message, parse_sse

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
    "accept-encoding",  # 强制上游返回未压缩内容，便于落盘
}


class Recorder:
    """线程安全地给每个 exchange 分配目录并写文件。"""

    def __init__(self, out: Path):
        self.out = out
        self.out.mkdir(parents=True, exist_ok=True)
        self._seq = itertools.count(1)
        self._lock = threading.Lock()

    def new_dir(self, method: str, path: str) -> Path:
        with self._lock:
            n = next(self._seq)
        slug = re.sub(r"[^A-Za-z0-9]+", "_", path.split("?")[0]).strip("_")[:40]
        d = self.out / f"{n:04d}-{method}-{slug}"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def append_index(self, row: dict) -> None:
        with self._lock, open(self.out / "index.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _write_json(path: Path, obj) -> None:
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    path.write_text(redact_text(text), encoding="utf-8")


def make_handler(upstream: str, recorder: Recorder, client: httpx.Client):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # 安静一点，自己打印摘要
            pass

        def _read_body(self) -> bytes:
            if self.headers.get("transfer-encoding", "").lower() == "chunked":
                chunks = []
                while True:
                    size = int(self.rfile.readline().strip() or b"0", 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    chunks.append(self.rfile.read(size))
                    self.rfile.readline()
                return b"".join(chunks)
            n = int(self.headers.get("content-length") or 0)
            return self.rfile.read(n) if n else b""

        def _proxy(self):
            t0 = time.time()
            body = self._read_body()
            req_headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
            d = recorder.new_dir(self.command, self.path)

            try:
                parsed = json.loads(body) if body else None
            except ValueError:
                parsed = body.decode("utf-8", "replace")
            _write_json(d / "request.json", {
                "method": self.command,
                "path": self.path,
                "headers": redact_headers(dict(self.headers.items())),
                "body_bytes": len(body),
                "body": parsed,
            })

            url = upstream.rstrip("/") + self.path
            raw = bytearray()
            status = 502
            resp_headers: dict[str, str] = {}
            try:
                with client.stream(self.command, url, headers=req_headers, content=body) as r:
                    status = r.status_code
                    resp_headers = dict(r.headers.items())
                    self.send_response(status)
                    for k, v in r.headers.items():
                        if k.lower() not in HOP_BY_HOP and k.lower() != "content-encoding":
                            self.send_header(k, v)
                    self.send_header("transfer-encoding", "chunked")
                    self.end_headers()
                    # 边收边转发：SSE 必须逐块 flush，否则 Claude Code 会等到整条响应结束才显示
                    for chunk in r.iter_bytes():
                        raw.extend(chunk)
                        self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                    # 先落盘再发结束块：客户端读完响应时，记录一定已经写好（测试也靠这点）
                    self._record(d, parsed, status, resp_headers, raw, t0)
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    return
            except httpx.HTTPError as e:
                msg = json.dumps({"type": "error", "error": {"type": "proxy_error", "message": str(e)}}).encode()
                raw.extend(msg)
                self.send_response(502)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
            self._record(d, parsed, status, resp_headers, raw, t0)

        def _record(self, d, parsed, status, resp_headers, raw, t0):
            text = raw.decode("utf-8", "replace")
            (d / "response.raw").write_text(redact_text(text), encoding="utf-8")
            is_sse = "text/event-stream" in resp_headers.get("content-type", "")
            resp_obj: dict = {"status": status, "headers": redact_headers(resp_headers)}
            if is_sse:
                events = parse_sse(text)
                resp_obj["sse_event_counts"] = _count(e["event"] for e in events)
                resp_obj["message"] = assemble_message(events)
            else:
                try:
                    resp_obj["body"] = json.loads(text) if text else None
                except ValueError:
                    resp_obj["body"] = text[:2000]
            _write_json(d / "response.json", resp_obj)

            row = summarize(d.name, parsed, resp_obj, time.time() - t0)
            recorder.append_index(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _proxy

    return Handler


def _count(it) -> dict[str, int]:
    c: dict[str, int] = {}
    for x in it:
        c[x] = c.get(x, 0) + 1
    return c


def summarize(name: str, req, resp: dict, secs: float) -> dict:
    row = {"id": name, "status": resp["status"], "secs": round(secs, 2)}
    if isinstance(req, dict):
        row["model"] = req.get("model")
        row["stream"] = req.get("stream")
        row["n_messages"] = len(req.get("messages", []))
        row["n_tools"] = len(req.get("tools", []))
        sysp = req.get("system")
        row["n_system_blocks"] = len(sysp) if isinstance(sysp, list) else (1 if sysp else 0)
    msg = resp.get("message") or (resp.get("body") if isinstance(resp.get("body"), dict) else None)
    if isinstance(msg, dict) and "usage" in msg:
        u = msg["usage"]
        row["usage"] = {k: u.get(k) for k in (
            "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}
    return row


def serve(port: int, upstream: str, out: Path, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    client = httpx.Client(timeout=httpx.Timeout(600.0, connect=15.0), http2=False)
    srv = ThreadingHTTPServer((host, port), make_handler(upstream, Recorder(out), client))
    srv.daemon_threads = True
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description="Claude Code 抓包反向代理")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--upstream", default="https://api.anthropic.com",
                    help="真实上游；你用中转站就填中转站地址")
    ap.add_argument("--out", type=Path, default=Path("captures"))
    a = ap.parse_args(argv)
    if a.port == 0:
        sys.exit("port 0 只给测试用")
    srv = serve(a.port, a.upstream, a.out)
    print(f"listening http://127.0.0.1:{a.port} -> {a.upstream}, writing {a.out}/", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
