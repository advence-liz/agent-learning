"""会话持久化：每个会话一个 JSONL 文件，按项目分目录，只追加。

布局（模仿 Claude Code 的 ~/.claude/projects/<slug>/<session-id>.jsonl）：
    <home>/projects/<slug>/<session_id>.jsonl

每行一条记录：
    {"type": "user"|"assistant", "uuid", "parentUuid", "sessionId", "timestamp", "cwd", "message": {...}, "usage"?: {...}}
其他 type（第 13/14 章的 rewind、compact 会加）读取时默认忽略。
"""

from __future__ import annotations

import json
import re
import uuid as uuidlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .loop import Usage


def project_slug(cwd: Path) -> str:
    # /Users/liz/my.proj → -Users-liz-my-proj（和 Claude Code 一样：非字母数字都换成 -）
    return re.sub(r"[^A-Za-z0-9]", "-", str(cwd.resolve()))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _first_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text" and not b["text"].startswith("<system-reminder>"):
            return b["text"]
    return ""


@dataclass
class SessionInfo:
    id: str
    path: Path
    title: str
    messages: int
    updated: datetime


class Session:
    def __init__(self, store: "SessionStore", session_id: str | None = None):
        self.store = store
        self.id = session_id or str(uuidlib.uuid4())
        self.path = store.dir / f"{self.id}.jsonl"
        self.tasks_path = store.dir / f"{self.id}.tasks.json"  # 第 11 章：任务清单和历史分开存
        self.last_uuid: str | None = None
        if self.path.exists():
            for rec in self.store.read_records(self.path):
                if rec.get("uuid"):
                    self.last_uuid = rec["uuid"]

    def record(self, msg: dict[str, Any], meta: dict[str, Any] | None = None) -> None:
        """Agent.listeners 回调：每条新消息立刻追加一行。文件在第一条消息时才创建。"""
        rec: dict[str, Any] = {
            "type": msg["role"],
            "uuid": str(uuidlib.uuid4()),
            "parentUuid": self.last_uuid,
            "sessionId": self.id,
            "timestamp": _now(),
            "cwd": str(self.store.cwd),
            "message": msg,
        }
        if meta and meta.get("usage"):
            rec["usage"] = meta["usage"]
        self.append_record(rec)
        self.last_uuid = rec["uuid"]

    def append_record(self, rec: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # 一次 write 一整行；O_APPEND 下多进程同时追加也不会交错成半行
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


class SessionStore:
    def __init__(self, home: Path, cwd: Path):
        self.cwd = cwd
        self.dir = home / "projects" / project_slug(cwd)

    def new(self) -> Session:
        return Session(self)

    @staticmethod
    def read_records(path: Path) -> list[dict[str, Any]]:
        recs = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                # 进程在写最后一行时被杀掉，会留下半行：跳过它，前面的都还能用
                continue
        return recs

    def load(self, session_id: str) -> tuple[Session, list[dict[str, Any]], Usage]:
        path = self.dir / f"{session_id}.jsonl"
        if not path.exists():
            raise FileNotFoundError(f"no session {session_id}")
        messages: list[dict[str, Any]] = []
        usage = Usage()
        for rec in self.read_records(path):
            if rec.get("type") in ("user", "assistant") and "message" in rec:
                messages.append(rec["message"])
                if rec.get("usage"):
                    usage.add(rec["usage"])
        return Session(self, session_id), messages, usage

    def list(self) -> list[SessionInfo]:
        infos = []
        for p in self.dir.glob("*.jsonl") if self.dir.exists() else []:
            recs = self.read_records(p)
            msgs = [r for r in recs if r.get("type") in ("user", "assistant")]
            title = next((t for r in msgs if r["type"] == "user" and (t := _first_text(r["message"]["content"]))), "")
            infos.append(SessionInfo(p.stem, p, title.strip().splitlines()[0][:50] if title else "(empty)",
                                     len(msgs), datetime.fromtimestamp(p.stat().st_mtime)))
        return sorted(infos, key=lambda i: i.updated, reverse=True)

    def resolve(self, ref: str) -> str:
        """ref 可以是列表序号（1 开始）或 id 前缀。"""
        infos = self.list()
        if ref.isdigit() and 1 <= int(ref) <= len(infos):
            return infos[int(ref) - 1].id
        hits = [i.id for i in infos if i.id.startswith(ref)]
        if len(hits) != 1:
            raise KeyError(f"{'没有' if not hits else '有多个'}会话匹配 {ref!r}")
        return hits[0]
