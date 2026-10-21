"""任务清单：把「计划」从对话历史里拿出来，变成一份独立、持久、看得见的状态。

- 存储：每个会话一个 JSON 文件（<session>.tasks.json），和对话历史分开——压缩历史不会丢计划。
- 工具：TaskCreate / TaskUpdate / TaskList（tools/task_tools.py），模型自己维护清单。
- 提醒：模型很久没碰清单、而清单还没做完时，注入一条提醒（context 的 provider 机制）。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

STATUSES = ("pending", "in_progress", "completed")
MARK = {"pending": "☐", "in_progress": "◼", "completed": "☒"}


@dataclass
class Task:
    id: str
    subject: str
    description: str = ""
    active_form: str = ""  # 进行时的说法，UI 显示「正在…」
    status: str = "pending"


@dataclass
class TaskStore:
    path: Path | None = None
    tasks: list[Task] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | None) -> "TaskStore":
        store = cls(path)
        if path and path.exists():
            store.tasks = [Task(**t) for t in json.loads(path.read_text(encoding="utf-8"))]
        return store

    def save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(t) for t in self.tasks], ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)  # 先写临时文件再改名：崩溃时不会留下半个 JSON

    def create(self, subject: str, description: str = "", active_form: str = "") -> Task:
        t = Task(str(len(self.tasks) + 1), subject, description, active_form)
        self.tasks.append(t)
        self.save()
        return t

    def get(self, task_id: str) -> Task | None:
        return next((t for t in self.tasks if t.id == str(task_id)), None)

    def update(self, task_id: str, **changes: str) -> Task:
        t = self.get(task_id)
        if t is None:
            raise KeyError(task_id)
        for k, v in changes.items():
            if v is not None:
                setattr(t, k, v)
        self.save()
        return t

    def unfinished(self) -> list[Task]:
        return [t for t in self.tasks if t.status != "completed"]

    def render(self) -> str:
        if not self.tasks:
            return "(no tasks)"
        lines = []
        for t in self.tasks:
            extra = f"  ← {t.active_form}" if t.status == "in_progress" and t.active_form else ""
            lines.append(f"{MARK[t.status]} #{t.id} {t.subject}{extra}")
        done = sum(t.status == "completed" for t in self.tasks)
        return "\n".join(lines) + f"\n({done}/{len(self.tasks)} completed)"


TASK_TOOLS = {"TaskCreate", "TaskUpdate", "TaskList"}
REMINDER_HEADER = "# Task list reminder"


def task_reminder_provider(every: int = 6):
    """清单没做完，而模型已经 `every` 次请求没碰过清单（或者历史里根本看不到清单，比如压缩之后）→ 提醒。

    和其他 provider 一样不记标志位：从历史里数「最近一次碰清单/最近一次提醒」之后过了几条 assistant 消息。
    """

    def provide(st):
        from .attachments import Attachment, is_reminder

        store = st.agent.ctx.extras.get("tasks")
        if store is None or not store.unfinished():
            return None
        gap, seen = 0, False
        for m in reversed(st.messages):
            content = m["content"] if isinstance(m["content"], list) else []
            if m["role"] == "assistant":
                if any(b.get("type") == "tool_use" and b.get("name") in TASK_TOOLS for b in content):
                    seen = True
                    break
                gap += 1
            elif any(is_reminder(b) and REMINDER_HEADER in b["text"] for b in content):
                seen = True
                break
        if seen and gap < every:
            return None
        why = (f"You have not updated the task list in the last {gap} steps." if seen
               else "This is the current task list for this session (it may not be visible earlier in the conversation).")
        return Attachment("tasks", f"任务提醒（{len(store.unfinished())} 项未完成）",
                          f"{REMINDER_HEADER}\n{why} Keep it accurate: mark the task you are working on in_progress "
                          f"and mark finished tasks completed right away. Do not stop while tasks remain unless you "
                          f"are blocked.\n\n{store.render()}")

    return provide
