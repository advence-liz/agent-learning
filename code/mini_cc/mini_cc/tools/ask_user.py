"""AskUserQuestion：模型拿不准、而决定权在用户手里时，反过来问用户。

和权限弹窗一样，工具执行时循环停在这里同步等待 UI 返回答案；答案作为普通的 tool_result 回给模型。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .base import Tool, ToolContext, ToolResult


@dataclass
class Question:
    question: str
    header: str
    options: list[dict[str, str]]
    multi_select: bool = False


@dataclass
class Answer:
    question: str
    choices: list[str] = field(default_factory=list)  # 选中的 label，或者用户自己输入的文本
    skipped: bool = False


DESCRIPTION = """Ask the user 1-4 multiple-choice questions when you are blocked on a decision that is genuinely
the user's to make (tech stack, scope, naming, trade-offs) and cannot be resolved from the request, the code,
or sensible defaults. Ask all open questions in ONE call instead of one at a time.
- Each question has a short header (<=12 chars), 2-4 options with a label and a one-line description.
- Set multiSelect: true when several options can apply together.
- Put the recommended option first and add "(Recommended)" to its label.
- Do not add an "Other" option: the user can always type a custom answer.
Do not use this tool to ask for permission to proceed or to confirm a plan you could just execute."""


class AskUserQuestionTool(Tool):
    name = "AskUserQuestion"
    read_only = True   # 不碰文件系统；问用户本身不需要再经过权限审批
    kind = "meta"
    description = DESCRIPTION
    input_schema = {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array", "minItems": 1, "maxItems": 4,
                "items": {
                    "type": "object",
                    "properties": {
                        "question": {"type": "string"},
                        "header": {"type": "string"},
                        "multiSelect": {"type": "boolean"},
                        "options": {
                            "type": "array", "minItems": 2, "maxItems": 4,
                            "items": {
                                "type": "object",
                                "properties": {"label": {"type": "string"}, "description": {"type": "string"}},
                                "required": ["label"],
                            },
                        },
                    },
                    "required": ["question", "header", "options"],
                },
            }
        },
        "required": ["questions"],
        "additionalProperties": False,
    }

    def summary(self, args) -> str:
        qs = args.get("questions") or []
        return f"AskUserQuestion({len(qs)} 个问题：{' / '.join(q.get('header', '?') for q in qs)})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        asker = ctx.extras.get("ask_user")
        if asker is None:
            return ToolResult("The user is not available to answer questions in this mode. "
                              "Proceed with sensible defaults and state your assumptions explicitly.", True)
        questions = [Question(q["question"], q["header"], q["options"], q.get("multiSelect", False))
                     for q in args["questions"]]
        answers: list[Answer] = asker(questions)
        if all(a.skipped for a in answers):
            return ToolResult("User declined to answer questions. Ask what they want instead of guessing, "
                              "or proceed only with clearly reversible defaults.")
        parts = []
        for a in answers:
            if a.skipped:
                parts.append(f'"{a.question}"=(no answer)')
            else:
                parts.append(f'"{a.question}"="{", ".join(a.choices)}"')
        # 措辞参考 Claude Code：先列出答案，再提示模型据此继续
        return ToolResult("Your questions have been answered: " + ", ".join(parts)
                          + ". You can now continue with these answers in mind.")


def parse_answer(raw: str, q: Question) -> Answer | None:
    """把用户输入解析成答案。'1' / '1,3'（多选）/ 文本（Other）/ 空（跳过）。返回 None 表示输入无效。"""
    raw = raw.strip()
    if not raw:
        return Answer(q.question, skipped=True)
    parts = [p.strip() for p in raw.replace("，", ",").split(",")]
    if all(p.isdigit() for p in parts):
        idx = [int(p) for p in parts]
        if not q.multi_select and len(idx) > 1:
            return None
        if not all(1 <= i <= len(q.options) for i in idx):
            return None
        return Answer(q.question, [q.options[i - 1]["label"] for i in idx])
    return Answer(q.question, [raw])  # 不是序号：当作「其他」，用户自己写的答案


def render_question(q: Question, n: int, total: int) -> list[str]:
    lines = [f"[{q.header}] ({n}/{total}) {q.question}" + ("（可多选，用逗号分隔）" if q.multi_select else "")]
    for i, o in enumerate(q.options, 1):
        desc = f" — {o['description']}" if o.get("description") else ""
        lines.append(f"  {i}. {o['label']}{desc}")
    lines.append("  或直接输入你自己的答案；回车跳过")
    return lines
