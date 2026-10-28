"""合成「工单路由」数据：用户的一句话 → {"route": ..., "priority": ...}。

训练集和测试集用**不同的句子主干**（每类留出 2 句只出现在测试集），
所以测试准确率衡量的是"学会了规则"，而不是"背下了句子"。
"""

from __future__ import annotations

import json
import random

ROUTES = ["account", "billing", "bug", "feature", "unknown"]
PRIORITIES = ["high", "medium", "low"]

STEMS = {
    "account": [
        "I can't log in to my account", "I need to reset my password", "how do I change the email on my profile",
        "my account got locked after too many attempts", "the two-factor code never arrives",
        "please delete my account", "I want to merge two accounts", "my username shows someone else's name",
    ],
    "billing": [
        "I was charged twice this month", "I'd like a refund for last month", "the invoice shows the wrong amount",
        "how do I update my credit card", "I cancelled but you still billed me", "the price went up without notice",
        "I need a VAT invoice for my company", "my payment keeps getting declined",
    ],
    "bug": [
        "the app crashes when I open a photo", "export to PDF produces a blank file", "sync is stuck at 99%",
        "search returns nothing even for exact titles", "the save button does nothing in Safari",
        "calendar reminders fire a few minutes late", "the video plays twice at the same time",
        "the page goes white after I upload a file",
    ],
    "feature": [
        "please add dark mode", "it would be great to support Markdown export", "can you build a Linux app",
        "I'd love keyboard shortcuts", "add a way to share folders with my team",
        "please support Google Calendar integration", "could you add tags to notes", "let me pin important notes",
    ],
    "unknown": [
        "what's the weather like today", "hello there", "who won the game last night", "tell me a joke",
        "is this a real person", "asdfgh qwerty", "what is the meaning of life", "do you like pizza",
    ],
}
HELD_OUT = 2  # 每类最后 2 句只用于测试

MODIFIERS = {
    "high": ["This is urgent!", "I need this fixed ASAP.", "Our whole team is blocked.", "Please help immediately."],
    "low": ["No rush.", "Whenever you get a chance.", "Just a suggestion.", "Not a big deal."],
    "medium": ["", "Thanks.", "Please take a look."],
}
OPENERS = ["", "Hi, ", "Hey team, ", "Hello, "]

SYSTEM = ('Route the support ticket. Reply with JSON only: {"route": one of account|billing|bug|feature|unknown, '
          '"priority": one of high|medium|low}.')


def target_json(route: str, priority: str) -> str:
    return json.dumps({"route": route, "priority": priority})


def make_split(n: int, split: str, seed: int) -> list[dict]:
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        route = rng.choice(ROUTES)
        stems = STEMS[route][:-HELD_OUT] if split == "train" else STEMS[route][-HELD_OUT:]
        priority = rng.choice(PRIORITIES)
        mod = rng.choice(MODIFIERS[priority])
        text = f"{rng.choice(OPENERS)}{rng.choice(stems)}. {mod}".strip()
        out.append({"text": text, "route": route, "priority": priority})
    return out


def messages(text: str) -> list[dict]:
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}]


def parse(output: str) -> dict | None:
    try:
        obj = json.loads(output.strip())
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or obj.get("route") not in ROUTES or obj.get("priority") not in PRIORITIES:
        return None
    return obj
