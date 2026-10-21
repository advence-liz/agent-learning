"""文件状态缓存：记住模型「读过哪些文件、读的时候文件长什么样」。

Write / Edit 靠它实现两条规矩：
1. 先读后改：没读过的已存在文件不许改（防止模型凭记忆/幻觉盲改）。
2. 读后未变：读过之后文件被别人（你、formatter、另一个进程）改了，必须重读（防止覆盖别人的修改）。
第 9 章的「文件被外部修改」提醒也读这张表。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


@dataclass
class FileRecord:
    mtime_ns: int
    sha: str
    partial: bool = False  # 只读了一部分（offset/limit）
    text: str | None = None  # 第 9 章：保存模型看到的版本，外部修改时据此算 diff（大文件不存）


class FileStateCache:
    def __init__(self) -> None:
        self._records: dict[Path, FileRecord] = {}

    MAX_KEEP = 200_000  # 超过这么多字符的文件不存原文，外部修改时只提示不给 diff

    def remember(self, path: Path, text: str, partial: bool = False) -> None:
        keep = text if len(text) <= self.MAX_KEEP else None
        self._records[path] = FileRecord(path.stat().st_mtime_ns, digest(text), partial, keep)

    def get(self, path: Path) -> FileRecord | None:
        return self._records.get(path)

    def forget(self, path: Path) -> None:
        self._records.pop(path, None)

    def paths(self) -> list[Path]:
        return list(self._records)

    def is_stale(self, path: Path) -> bool:
        """mtime 变了且内容也变了才算「被改过」（只是 touch 一下不算）。"""
        rec = self._records.get(path)
        if rec is None or not path.exists():
            return rec is not None
        if path.stat().st_mtime_ns == rec.mtime_ns:
            return False
        return digest(read_text(path)) != rec.sha


def read_text(path: Path) -> str:
    # newline="" 保留原始换行符（\r\n 不会被悄悄改成 \n）
    with path.open(encoding="utf-8", newline="") as f:
        return f.read()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(text)


NOT_READ = "File has not been read yet. Read it first before writing to it."
STALE = ("File has been modified since read, either by the user or by a linter. "
         "Read it again before attempting to write it.")


def guard_write(state: FileStateCache, path: Path) -> str | None:
    """已存在文件的写入前检查。返回错误信息，None 表示可以写。"""
    if not path.exists():
        return None
    if state.get(path) is None:
        return NOT_READ
    if state.is_stale(path):
        return STALE
    return None
