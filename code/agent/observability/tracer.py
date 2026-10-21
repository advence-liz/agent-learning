"""第 8 章：给第 2 章的 Coding Agent 加 trace —— 不改 agent 一行代码，只包两层。

  invoke_agent            ← 根 span：整个任务
   ├─ chat claude-opus-5-5   ← 每次 messages.create：耗时 + token + stop_reason
   ├─ execute_tool read_file ← 每次工具执行：耗时 + 参数 + 是否出错
   └─ ...

导出格式是 OTLP/JSON（OpenTelemetry 的线上格式），属性名沿用 GenAI 语义约定（gen_ai.*）。
离线演示： uv run python -m observability.tracer
"""

from __future__ import annotations

import contextvars
import json
import os
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator


@dataclass
class Span:
    name: str
    trace_id: str
    span_id: str
    parent_id: str | None
    kind: int = 1  # 1=INTERNAL 3=CLIENT（OTLP 枚举值）
    start_ns: int = 0
    end_ns: int = 0
    attrs: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def ms(self) -> float:
        return (self.end_ns - self.start_ns) / 1e6


class Tracer:
    def __init__(self, service: str = "mini-coding-agent"):
        self.service = service
        self.spans: list[Span] = []
        self._current: contextvars.ContextVar[Span | None] = contextvars.ContextVar("span", default=None)
        self._trace_id = os.urandom(16).hex()

    @contextmanager
    def span(self, name: str, kind: int = 1, **attrs: Any) -> Iterator[Span]:
        parent = self._current.get()
        s = Span(name, self._trace_id, os.urandom(8).hex(), parent.span_id if parent else None, kind,
                 time.time_ns(), attrs=dict(attrs))
        token = self._current.set(s)
        try:
            yield s
        except Exception as e:
            s.error = f"{type(e).__name__}: {e}"
            raise
        finally:
            s.end_ns = time.time_ns()
            self._current.reset(token)
            self.spans.append(s)

    # ---------- 导出 ----------
    def to_otlp(self) -> dict[str, Any]:
        def kv(d: dict[str, Any]) -> list[dict[str, Any]]:
            out = []
            for k, v in d.items():
                if isinstance(v, bool):
                    val = {"boolValue": v}
                elif isinstance(v, int):
                    val = {"intValue": str(v)}  # OTLP/JSON 里 int64 用字符串
                elif isinstance(v, float):
                    val = {"doubleValue": v}
                elif isinstance(v, (list, tuple)):
                    val = {"arrayValue": {"values": [{"stringValue": str(x)} for x in v]}}
                else:
                    val = {"stringValue": str(v)}
                out.append({"key": k, "value": val})
            return out

        spans = []
        for s in sorted(self.spans, key=lambda s: s.start_ns):
            d: dict[str, Any] = {
                "traceId": s.trace_id, "spanId": s.span_id, "name": s.name, "kind": s.kind,
                "startTimeUnixNano": str(s.start_ns), "endTimeUnixNano": str(s.end_ns),
                "attributes": kv(s.attrs),
                "status": {"code": 2, "message": s.error} if s.error else {"code": 1},
            }
            if s.parent_id:
                d["parentSpanId"] = s.parent_id
            spans.append(d)
        return {"resourceSpans": [{
            "resource": {"attributes": kv({"service.name": self.service})},
            "scopeSpans": [{"scope": {"name": "agentlab.tracer", "version": "0.1"}, "spans": spans}],
        }]}

    def print_tree(self) -> None:
        children: dict[str | None, list[Span]] = defaultdict(list)
        for s in sorted(self.spans, key=lambda s: s.start_ns):
            children[s.parent_id].append(s)

        def walk(pid: str | None, depth: int) -> None:
            for s in children[pid]:
                a = s.attrs
                extra = ""
                if "gen_ai.usage.input_tokens" in a:
                    extra = f"in={a['gen_ai.usage.input_tokens']} out={a['gen_ai.usage.output_tokens']} stop={a['gen_ai.response.finish_reasons'][0]}"
                elif "gen_ai.tool.name" in a:
                    extra = f"ERROR {s.error[:40]}…" if s.error else "ok"
                elif "agent.turns" in a:
                    extra = f"turns={a['agent.turns']} total_in={a['agent.usage.input_tokens']} total_out={a['agent.usage.output_tokens']}"
                print(f"{'  ' * depth}{s.name:<{34 - 2 * depth}} {s.ms:7.1f} ms  {extra}")
                walk(s.span_id, depth + 1)

        walk(None, 0)


# ---------- 两层包装：模型调用 & 工具调用 ----------
class TracedClient:
    """包住任意有 .messages.create 的 client（真的 anthropic.Anthropic 或 FakeAnthropic）。"""

    def __init__(self, inner: Any, tracer: Tracer):
        self.inner, self.tracer = inner, tracer
        self.messages = self
        self.pending_tool_ids: dict[str, deque[str]] = defaultdict(deque)  # 给工具 span 关联 tool_use_id
        self.turn = 0
        self.total_in = self.total_out = 0

    def create(self, **kw: Any) -> Any:
        self.turn += 1
        with self.tracer.span(f"chat {kw['model']}", kind=3, **{
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "anthropic",
            "gen_ai.request.model": kw["model"],
            "gen_ai.request.max_tokens": kw.get("max_tokens", 0),
            "agent.turn": self.turn,
            "agent.request.messages": len(kw["messages"]),  # 上下文在膨胀：每轮多 2 条
        }) as s:
            resp = self.inner.messages.create(**kw)
            u = resp.usage
            s.attrs.update({
                "gen_ai.response.id": resp.id,
                "gen_ai.response.model": resp.model,
                "gen_ai.response.finish_reasons": [resp.stop_reason],
                "gen_ai.usage.input_tokens": u.input_tokens,
                "gen_ai.usage.output_tokens": u.output_tokens,
            })
            self.total_in += u.input_tokens
            self.total_out += u.output_tokens
            for b in resp.content:
                if b.type == "tool_use":
                    self.pending_tool_ids[b.name].append(b.id)
            return resp


def traced_tools(tools: dict[str, Callable[..., str]], tracer: Tracer, client: TracedClient) -> dict[str, Callable[..., str]]:
    def wrap(name: str, fn: Callable[..., str]) -> Callable[..., str]:
        def inner(**kwargs: Any) -> str:
            ids = client.pending_tool_ids[name]
            with tracer.span(f"execute_tool {name}", **{
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": name,
                "gen_ai.tool.call.id": ids.popleft() if ids else "",
                "gen_ai.tool.call.arguments": json.dumps(kwargs, ensure_ascii=False)[:500],
            }) as s:
                out = fn(**kwargs)
                s.attrs["tool.result.chars"] = len(out)
                return out
        return inner

    return {n: wrap(n, f) for n, f in tools.items()}


def run_traced(client: Any, task: str, cwd: Path, tracer: Tracer, **kw: Any) -> str:
    from coding_agent.agent import make_tools, run_agent

    tc = TracedClient(client, tracer)
    with tracer.span("invoke_agent coding_agent", **{"gen_ai.operation.name": "invoke_agent", "agent.task": task}) as root:
        out = run_agent(tc, task, cwd, tools=traced_tools(make_tools(cwd), tracer, tc), **kw)
        root.attrs.update({"agent.turns": tc.turn, "agent.usage.input_tokens": tc.total_in,
                           "agent.usage.output_tokens": tc.total_out})
    return out


if __name__ == "__main__":
    import tempfile

    from coding_agent import demo
    from fake_llm import FakeAnthropic, text, tool_use

    script = [  # 让 input_tokens 随轮次增长，模拟真实上下文膨胀
        tool_use("run_command", {"command": "python test_calc.py"}, input_tokens=820, output_tokens=45),
        tool_use("read_file", {"path": "calc.py"}, input_tokens=1010, output_tokens=30),
        tool_use("read_file", {"path": "missing.py"}, input_tokens=1090, output_tokens=28),
        tool_use("write_file", {"path": "calc.py", "content": demo.FIXED}, input_tokens=1160, output_tokens=60),
        tool_use("run_command", {"command": "python test_calc.py"}, input_tokens=1250, output_tokens=40),
        text("修好了：a - b → a + b，测试通过。", input_tokens=1330, output_tokens=35),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        demo.setup(d)
        tracer = Tracer()
        run_traced(FakeAnthropic(script, latency=0.08), "修好测试", d, tracer, log=lambda s: None)
    tracer.print_tree()
    out = Path(__file__).parent / "trace.json"
    out.write_text(json.dumps(tracer.to_otlp(), ensure_ascii=False, indent=2))
    first_chat = next(s for s in tracer.to_otlp()["resourceSpans"][0]["scopeSpans"][0]["spans"] if s["name"].startswith("chat"))
    print(f"\n已写出 {out.name}（{len(tracer.spans)} 个 span）。其中第一个 chat span：")
    attrs = {a["key"]: next(iter(a["value"].values())) for a in first_chat.pop("attributes")}
    print(json.dumps({**first_chat, "attributes(展平显示)": attrs}, ensure_ascii=False, indent=2))
