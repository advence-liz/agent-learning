"""第 1 章：Agent = 模型 + 一个 while 循环 + 一张工具表。

离线运行： uv run python -m core.agent_loop
真实运行：把 FakeAnthropic(...) 换成 anthropic.Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。
"""

from __future__ import annotations

from typing import Any, Callable

MODEL = "claude-opus-5-5"


def run_agent(client, task: str, tools: list[dict], handlers: dict[str, Callable[..., str]],
              *, system: str = "", max_turns: int = 10, log: Callable[[str], None] = print) -> str:
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    for _ in range(max_turns):
        resp = client.messages.create(model=MODEL, max_tokens=16000, system=system,
                                      tools=tools, messages=messages)
        messages.append({"role": "assistant", "content": resp.content})  # 原样追加，别只留文字
        if resp.stop_reason != "tool_use":  # 模型不再要工具 → 这一轮就是最终回答
            return "".join(b.text for b in resp.content if b.type == "text")
        results = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            log(f"⏺ {block.name}({block.input})")
            try:
                out, err = handlers[block.name](**block.input), False
            except Exception as e:  # 工具失败也要回给模型，而不是让循环崩掉
                out, err = f"{type(e).__name__}: {e}", True
            log(f"✔ {out[:80]}")
            results.append({"type": "tool_result", "tool_use_id": block.id,
                            "content": out, "is_error": err})
        messages.append({"role": "user", "content": results})  # 所有结果放进同一条 user 消息
    raise RuntimeError(f"超过 {max_turns} 轮仍未结束")


# ---------- 离线演示：一个假的 webapp 仓库 + 一个 fake 模型 ----------

FAKE_REPO = {
    "apps/web/vitest.config.ts": "export default defineConfig({ test: { environment: 'jsdom', testTimeout: 15000 } })",
}

TOOLS = [{
    "name": "read_file",
    "description": "读取仓库里一个文本文件的全部内容。",
    "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
}]


def read_file(path: str) -> str:
    if path not in FAKE_REPO:
        raise FileNotFoundError(path)
    return FAKE_REPO[path]


def demo() -> tuple[str, Any]:
    from fake_llm import FakeAnthropic, text, tool_use

    client = FakeAnthropic([
        tool_use("read_file", {"path": "apps/web/vitest.config.ts"}, say="我先看一下配置文件。"),
        text("webapp 的 vitest 单测超时是 15000ms（15 秒），环境是 jsdom。"),
    ])
    task = "webapp 的 vitest 单测超时设的是多少？"
    print(f"❯ {task}")
    answer = run_agent(client, task, TOOLS, {"read_file": read_file})
    print(f"⏺ {answer}")
    return answer, client


if __name__ == "__main__":
    _, client = demo()
    print(f"\n[离线 fake 模型] 共请求模型 {len(client.calls)} 次；"
          f"第 2 次请求里 messages 的角色序列：{[m['role'] for m in client.calls[1]['messages']]}")
