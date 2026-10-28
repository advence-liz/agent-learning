"""附件：客户端主动塞进上下文的东西（@ 文件、环境信息、提醒……）。

统一渲染成 <system-reminder> 包裹的文本块，追加在 user 消息里。第 8 章用于 @ 文件，第 9 章推广到所有注入。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Attachment:
    kind: str    # file | directory | env | instructions | reminder | image | ...
    title: str   # 给人看的一行，比如 "@config.py（5 行）"
    text: str    # 给模型看的正文
    blocks: list[dict] = field(default_factory=list)  # 第 19 章：紧跟在说明后面的非文本块（图片）


def render(att: Attachment) -> dict:
    return {"type": "text", "text": f"<system-reminder>\n{att.text}\n</system-reminder>"}


def is_reminder(block: dict) -> bool:
    return block.get("type") == "text" and block.get("text", "").startswith("<system-reminder>")
