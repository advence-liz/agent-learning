"""第 1 章：最小聊天机器人。记忆 = messages 数组；人设 = system prompt。

真实运行：  uv run python -m chatbot.bot            （需 ANTHROPIC_API_KEY，可选 ANTHROPIC_BASE_URL）
离线演示：  uv run python -m chatbot.bot --fake
"""

from __future__ import annotations

import sys
from typing import Any

MODEL = "claude-opus-5-5"


class Chatbot:
    def __init__(self, client: Any, system: str = "你是一个简洁的中文助手。", max_tokens: int = 2048):
        self.client = client
        self.system = system
        self.max_tokens = max_tokens
        self.messages: list[dict[str, Any]] = []  # ← 这就是「记忆」的全部

    def send(self, user_text: str) -> str:
        self.messages.append({"role": "user", "content": user_text})
        resp = self.client.messages.create(
            model=MODEL,
            max_tokens=self.max_tokens,
            system=self.system,          # 人设：每次请求都重新发一遍
            messages=self.messages,      # 历史：每次请求都完整发一遍
        )
        reply = "".join(b.text for b in resp.content if b.type == "text")
        # 把 assistant 回复也写回数组，下一轮模型才「记得」自己说过什么
        self.messages.append({"role": "assistant", "content": resp.content})
        self.last_usage = resp.usage
        return reply

    def reset(self, system: str | None = None) -> None:
        self.messages.clear()
        if system is not None:
            self.system = system


def repl(bot: Chatbot, lines: list[str] | None = None) -> None:
    """命令：/reset 清空记忆；/system <文本> 换人设并清空记忆；/quit 退出。"""
    src = iter(lines) if lines is not None else iter(lambda: input("❯ "), None)
    for line in src:
        if lines is not None:
            print(f"❯ {line}")
        if line == "/quit":
            break
        if line == "/reset":
            bot.reset()
            print("（记忆已清空）")
            continue
        if line.startswith("/system "):
            bot.reset(system=line.removeprefix("/system "))
            print(f"（人设已切换为：{bot.system}）")
            continue
        reply = bot.send(line)
        u = bot.last_usage
        print(f"⏺ {reply}   [in={u.input_tokens} out={u.output_tokens} 历史条数={len(bot.messages)}]")


if __name__ == "__main__":
    from fake_llm import make_client, text

    if "--fake" in sys.argv:
        client = make_client([
            text("你好小林！有什么可以帮你？", input_tokens=30),
            text("你叫小林，是前端工程师。", input_tokens=62),
            text("喵～本猫不认识你，你是谁喵？", input_tokens=28),
        ])
        repl(Chatbot(client), [
            "你好，我叫小林，是前端工程师",
            "我叫什么？",
            "/system 你是一只傲娇的猫，句尾带喵",
            "我叫什么？",
        ])
    else:
        repl(Chatbot(make_client()))
