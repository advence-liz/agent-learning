"""/rewind（第 13 章）：每条用户提示词一个检查点，Write/Edit 写文件前先备份「这一轮开始前」的版本。

布局（模仿 Claude Code 的 ~/.claude/file-history/<session>/<hash>@v<n>）：
    <home>/file-history/<session_id>/index.json      检查点列表
    <home>/file-history/<session_id>/<hash>@v<n>     某个文件的一份备份

只跟踪经过 ToolContext.before_write 的写入（Write / Edit）。Bash 改的文件、你在编辑器里改的文件都不在里面。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .attachments import is_reminder


@dataclass
class Checkpoint:
    uuid: str                       # 这条用户消息在会话文件里的 uuid
    prompt: str                     # 用户原话（列表里给人看，回退后放回输入框）
    # 路径 → 备份文件名；None 表示这一轮第一次写它之前，文件还不存在（回退 = 删除）
    files: dict[str, str | None] = field(default_factory=dict)


class FileHistory:
    def __init__(self, dir: Path):
        self.dir = dir
        self.checkpoints: list[Checkpoint] = []

    @classmethod
    def load(cls, dir: Path) -> "FileHistory":
        h = cls(dir)
        index = dir / "index.json"
        if index.exists():
            h.checkpoints = [Checkpoint(**c) for c in json.loads(index.read_text(encoding="utf-8"))]
        return h

    def save(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.dir / "index.tmp"
        tmp.write_text(json.dumps([asdict(c) for c in self.checkpoints], ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.dir / "index.json")

    # ------------------------------------------------------------ 记录

    def begin(self, uuid: str, prompt: str) -> None:
        self.checkpoints.append(Checkpoint(uuid, prompt))
        self.save()

    def before_write(self, path: Path) -> None:
        """ToolContext.write_hooks 回调。每个检查点里每个文件只备份一次：要的是「这一轮开始前」的版本。"""
        if not self.checkpoints:
            return
        cp, key = self.checkpoints[-1], str(path)
        if key in cp.files:
            return
        if path.exists():
            version = 1 + sum(key in c.files for c in self.checkpoints[:-1])
            name = f"{hashlib.sha256(key.encode()).hexdigest()[:16]}@v{version}"
            self.dir.mkdir(parents=True, exist_ok=True)
            (self.dir / name).write_bytes(path.read_bytes())
            cp.files[key] = name
        else:
            cp.files[key] = None
        self.save()

    # ------------------------------------------------------------ 回退

    def index_of(self, uuid: str) -> int:
        return next(i for i, c in enumerate(self.checkpoints) if c.uuid == uuid)

    def changed_since(self, uuid: str) -> list[str]:
        seen: dict[str, None] = {}
        for c in self.checkpoints[self.index_of(uuid):]:
            seen.update(dict.fromkeys(c.files))
        return list(seen)

    def restore(self, uuid: str) -> list[tuple[str, str]]:
        """把这个检查点之后改过的文件恢复到检查点开始时的样子。

        对每个文件，取「检查点之后第一次写它之前」的那份备份：从检查点开始到那次写入之间没有被跟踪的写入，
        所以它就是检查点开始时的内容（Bash / 外部修改除外）。
        """
        changes = []
        for key in self.changed_since(uuid):
            first = next(c for c in self.checkpoints[self.index_of(uuid):] if key in c.files)
            backup, path = first.files[key], Path(key)
            if backup is None:
                if path.exists():
                    path.unlink()
                    changes.append((key, "deleted"))
            else:
                data = (self.dir / backup).read_bytes()
                if not path.exists() or path.read_bytes() != data:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                    changes.append((key, "restored"))
        return changes

    def truncate(self, uuid: str) -> None:
        """对话回退到这个检查点之前：它和它之后的检查点都属于被丢弃的分支。备份文件留在磁盘上，不删。"""
        self.checkpoints = self.checkpoints[: self.index_of(uuid)]
        self.save()


# ---------------------------------------------------------------- 哪些 user 消息算「提示词」


def is_prompt(msg: dict[str, Any]) -> bool:
    """用户亲手发的消息才是检查点：工具结果、纯提醒（后台通知唤醒）不算。"""
    if msg["role"] != "user":
        return False
    c = msg["content"]
    if isinstance(c, str):
        return True
    if any(b.get("type") == "tool_result" for b in c):
        return False
    return any(b.get("type") == "text" and not is_reminder(b) for b in c)


def prompt_text(msg: dict[str, Any]) -> str:
    c = msg["content"]
    if isinstance(c, str):
        return c
    texts = [b["text"] for b in c if b.get("type") == "text" and not is_reminder(b)]
    return texts[-1] if texts else ""
