"""长期记忆（第 12 章）：一个目录 = 一份 MEMORY.md 索引 + 每条记忆一个 markdown 主题文件。

- 写：模型调用 Memory 工具（tools/memory_tool.py），同时写主题文件和索引里的一行。
- 读：会话开始时，索引（截到 200 行 / 25KB）进 system；主题文件不预加载，模型觉得相关再用 Read 读。
- 位置：<home>/projects/<仓库根的 slug>/memory/，同一个仓库的子目录共用一份（和 Claude Code 一样按 git 根算）。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

TYPES = ("user", "feedback", "project", "reference")
MAX_LINES = 200       # 和 Claude Code 文档一致：会话开始只加载索引前 200 行或 25KB
MAX_BYTES = 25_000
WARN_RATIO = 0.9      # 超过上限的 90% 就在保存结果里提醒模型精简
INDEX_LINE = re.compile(r"^- \[(?P<name>.+?)\]\((?P<slug>[^)]+?)\.md\) — (?P<desc>.*)$")

GUIDE = """# Memory
You have a persistent, file-based memory for this project at {dir}. It survives across sessions.
MEMORY.md (below) is the index: one line per memory, each pointing at a topic file in that directory.
Only the index is loaded at session start. Read a topic file when its line looks relevant to the task.

Save a memory with the Memory tool when you learn something that will matter in FUTURE sessions:
- user: who the user is (role, expertise, how they like to collaborate)
- feedback: a correction or a confirmed preference about how to work; include the reason
- project: goals, decisions, constraints or deadlines that are not visible in the code
- reference: where to find things outside the repo (docs, dashboards, tickets)
Do NOT save: anything derivable from the code or git history, anything already in AGENTS.md / CLAUDE.md,
details of the current task only, or secrets. Update an existing memory (same slug) instead of adding a
duplicate, and delete memories that turn out to be wrong. When the user explicitly asks you to remember or
forget something, do it right away.

## MEMORY.md
{index}"""


def slugify(name: str) -> str:
    """文件名：ASCII 部分转小写短横线；含非 ASCII（比如中文）时补一段稳定哈希，避免「提交前缀」「提交规范」撞名。"""
    ascii_part = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if name.isascii():
        return ascii_part or "memory"
    h = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    return f"{ascii_part}-{h}" if ascii_part else f"memory-{h}"


@dataclass
class Entry:
    name: str
    slug: str
    description: str


class MemoryStore:
    def __init__(self, dir: Path):
        self.dir = dir
        self.index_path = dir / "MEMORY.md"

    @classmethod
    def for_project(cls, home: Path, cwd: Path) -> "MemoryStore":
        from .context import git_root
        from .session import project_slug

        return cls(home / "projects" / project_slug(git_root(cwd) or cwd) / "memory")

    # ------------------------------------------------------------ 索引

    def _lines(self) -> list[str]:
        return self.index_path.read_text(encoding="utf-8").splitlines() if self.index_path.exists() else []

    def entries(self) -> list[Entry]:
        return [Entry(m["name"], m["slug"], m["desc"]) for ln in self._lines() if (m := INDEX_LINE.match(ln))]

    def load_index(self) -> str:
        """进上下文的那一份：前 MAX_LINES 行且不超过 MAX_BYTES。超出的部分模型看不见，所以要明说。"""
        lines = self._lines()
        kept, size = [], 0
        for ln in lines[:MAX_LINES]:
            n = len(ln.encode("utf-8")) + 1
            if size + n > MAX_BYTES:
                break
            kept.append(ln)
            size += n
        text = "\n".join(kept)
        if len(kept) < len(lines):
            text += (f"\n\n(MEMORY.md is truncated: {len(lines) - len(kept)} more lines were not loaded. "
                     "Condense the index.)")
        return text

    def _size_note(self) -> str:
        lines = self._lines()
        size = len("\n".join(lines).encode("utf-8"))
        if len(lines) < MAX_LINES * WARN_RATIO and size < MAX_BYTES * WARN_RATIO:
            return ""
        return (f"\nNote: MEMORY.md is at {len(lines)}/{MAX_LINES} lines and {size}/{MAX_BYTES} bytes. "
                "Please condense it: one short line per memory, merge or delete stale entries. "
                "Lines past the limit are NOT loaded into future sessions.")

    def _write_index(self, lines: list[str]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        tmp.replace(self.index_path)

    # ------------------------------------------------------------ 写

    def save(self, type: str, name: str, description: str, body: str, slug: str | None = None) -> tuple[Path, str]:
        if type not in TYPES:
            raise ValueError(f"type must be one of {TYPES}")
        slug = slug or slugify(name)
        name, description = name.strip().replace("\n", " "), description.strip().replace("\n", " ")
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.dir / f"{slug}.md"
        path.write_text(f"---\nname: {name}\ndescription: {description}\ntype: {type}\n---\n{body.strip()}\n",
                        encoding="utf-8")
        line = f"- [{name}]({slug}.md) — {description}"
        lines = self._lines()
        hit = [i for i, ln in enumerate(lines) if f"]({slug}.md)" in ln]
        if hit:
            lines[hit[0]] = line          # 同一个 slug：原地更新那一行，索引里不会重复
        else:
            lines.append(line)
        self._write_index(lines)
        return path, self._size_note()

    def delete(self, slug: str) -> bool:
        path = self.dir / f"{slug}.md"
        lines = self._lines()
        kept = [ln for ln in lines if f"]({slug}.md)" not in ln]
        if not path.exists() and len(kept) == len(lines):
            return False
        path.unlink(missing_ok=True)
        self._write_index(kept)
        return True

    # ------------------------------------------------------------ 进上下文

    def system_section(self) -> str:
        """挂到 ContextBuilder.system_sections：会话开始时求值一次，会话内保持不变（prompt cache 前缀稳定）。"""
        return GUIDE.format(dir=self.dir, index=self.load_index() or "(empty: no memories saved yet)")
