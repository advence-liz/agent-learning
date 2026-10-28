"""第 2 章：同一段对话，三种线格式（wire format）。

一段「中性」的对话状态 → 分别序列化成 Anthropic Messages / OpenAI Chat Completions / OpenAI Responses
的请求体，用 httpx2.MockTransport 拦截（不发任何真实请求），打印真正上线的 JSON，再把三种响应解析回统一结构。

离线运行： uv run python -m core.api_formats
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import anthropic
import httpx2 as httpx  # anthropic 1.x 的 HTTP 层是 httpx 的维护分支 httpx2，传给 SDK 的对象必须来自它

# ---------- 中性的对话状态：和任何厂商无关 ----------
SYSTEM = "你是 webapp 前端仓库的助手，回答要短。"
USER = "webapp 的 vitest 超时是多少？"
TOOL = {
    "name": "read_file",
    "description": "读取仓库里的一个文件",
    "schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
}
CALL = {"id": "call_001", "name": "read_file", "args": {"path": "apps/web/vitest.config.ts"}}
RESULT = "testTimeout: 15000"
MAX_TOKENS = 1024
FAKE_KEY = "sk-fake-not-a-real-key"


def anthropic_body(model: str = "claude-opus-5-5") -> dict[str, Any]:
    return {
        "model": model,
        "max_tokens": MAX_TOKENS,          # 必填
        "system": SYSTEM,                  # 顶层字段，不在 messages 里
        "tools": [{"name": TOOL["name"], "description": TOOL["description"], "input_schema": TOOL["schema"]}],
        "messages": [
            {"role": "user", "content": USER},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": CALL["id"], "name": CALL["name"], "input": CALL["args"]}]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": CALL["id"], "content": RESULT}]},
        ],
    }


def chat_completions_body(model: str = "your-openai-model") -> dict[str, Any]:
    return {
        "model": model,
        "max_completion_tokens": MAX_TOKENS,
        "tools": [{"type": "function", "function": {
            "name": TOOL["name"], "description": TOOL["description"], "parameters": TOOL["schema"]}}],
        "messages": [
            {"role": "system", "content": SYSTEM},       # system 是一条消息
            {"role": "user", "content": USER},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": CALL["id"], "type": "function",
                "function": {"name": CALL["name"], "arguments": json.dumps(CALL["args"])}}]},  # 参数是字符串
            {"role": "tool", "tool_call_id": CALL["id"], "content": RESULT},  # 工具结果是独立角色
        ],
    }


def responses_body(model: str = "your-openai-model") -> dict[str, Any]:
    return {
        "model": model,
        "instructions": SYSTEM,
        "max_output_tokens": MAX_TOKENS,
        "store": False,
        "tools": [{"type": "function", "name": TOOL["name"], "description": TOOL["description"],
                   "parameters": TOOL["schema"]}],        # 比 Chat Completions 少一层 function 嵌套
        "input": [                                         # 不叫 messages，叫 input，元素是「item」
            {"role": "user", "content": USER},
            {"type": "function_call", "call_id": CALL["id"], "name": CALL["name"],
             "arguments": json.dumps(CALL["args"])},
            {"type": "function_call_output", "call_id": CALL["id"], "output": RESULT},
        ],
    }


# ---------- 三种响应（拦截器返回的假响应，形状照官方文档） ----------
ANSWER = "超时是 15000ms。"

FAKE_RESPONSES = {
    "/v1/messages": {
        "id": "msg_fake", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
        "content": [{"type": "text", "text": ANSWER}], "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 120, "output_tokens": 12},
    },
    "/v1/chat/completions": {
        "id": "chatcmpl_fake", "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": ANSWER}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 120, "completion_tokens": 12, "total_tokens": 132},
    },
    "/v1/responses": {
        "id": "resp_fake", "object": "response", "status": "completed",
        "output": [{"type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": ANSWER}]}],
        "usage": {"input_tokens": 120, "output_tokens": 12, "total_tokens": 132},
    },
}


@dataclass
class Captured:
    path: str
    headers: dict[str, str]
    body: dict[str, Any]


def make_mock() -> tuple[httpx.MockTransport, list[Captured]]:
    seen: list[Captured] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keep = ("authorization", "x-api-key", "anthropic-version", "content-type")
        seen.append(Captured(request.url.path, {k: v for k, v in request.headers.items() if k in keep},
                             json.loads(request.content)))
        return httpx.Response(200, json=FAKE_RESPONSES[request.url.path])

    return httpx.MockTransport(handler), seen


@dataclass
class Unified:
    text: str
    stop: str
    input_tokens: int
    output_tokens: int


def send_all() -> tuple[dict[str, Unified], list[Captured]]:
    transport, seen = make_mock()
    out: dict[str, Unified] = {}

    # Anthropic：用官方 SDK 发（看 SDK 真正替你加了哪些头），http_client 注入 MockTransport
    client = anthropic.Anthropic(api_key=FAKE_KEY, base_url="https://api.example.invalid",
                                 http_client=httpx.Client(transport=transport), max_retries=0)
    m = client.messages.create(**anthropic_body())
    out["anthropic"] = Unified("".join(b.text for b in m.content if b.type == "text"), m.stop_reason,
                               m.usage.input_tokens, m.usage.output_tokens)

    # OpenAI 两种格式：手写 httpx（本项目不装 openai SDK），鉴权是 Bearer
    http = httpx.Client(transport=transport, base_url="https://api.example.invalid",
                        headers={"Authorization": f"Bearer {FAKE_KEY}"})
    c = http.post("/v1/chat/completions", json=chat_completions_body()).json()
    out["chat_completions"] = Unified(c["choices"][0]["message"]["content"], c["choices"][0]["finish_reason"],
                                      c["usage"]["prompt_tokens"], c["usage"]["completion_tokens"])
    r = http.post("/v1/responses", json=responses_body()).json()
    text = "".join(p["text"] for item in r["output"] if item["type"] == "message"
                   for p in item["content"] if p["type"] == "output_text")
    out["responses"] = Unified(text, r["status"], r["usage"]["input_tokens"], r["usage"]["output_tokens"])
    return out, seen


def _mask(h: dict[str, str]) -> dict[str, str]:
    return {k: (v[:12] + "…" if k in ("authorization", "x-api-key") else v) for k, v in h.items()}


if __name__ == "__main__":
    import sys

    indent = None if "--compact" in sys.argv else 2
    results, seen = send_all()
    for cap in seen:
        print(f"===== POST {cap.path}")
        print("headers:", json.dumps(_mask(cap.headers), ensure_ascii=False))
        print(json.dumps(cap.body, ensure_ascii=False, indent=indent))
    print("===== 三种响应解析回统一结构（离线 MockTransport，无真实请求）")
    for name, u in results.items():
        print(f"{name:17} text={u.text!r} stop={u.stop!r} in={u.input_tokens} out={u.output_tokens}")
