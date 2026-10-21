"""@ 引用文件：输入时补全路径，提交时把文件内容作为附件塞进这条 user 消息。"""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path
from typing import Iterable

from .attachments import Attachment, render
from .tools.base import ToolContext
from .tools.file_state import read_text
from .tools.read import MAX_LINES, number_lines

# @ 前面必须是开头或空白（避免误伤邮箱 a@b.com）；路径可以用引号包住带空格的名字
# 中文标点也视为路径结束（「看看 @a.py，然后」）
MENTION = re.compile(r'(?:^|(?<=\s))@("[^"]+"|[^\s"，。；：！？（）、]+)')
TRAILING = ",.;:!?)，。；：！？）"
IGNORED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".mypy_cache",
                ".pytest_cache", ".next", ".turbo", "coverage"}


def find_mentions(text: str) -> list[str]:
    out = []
    for m in MENTION.finditer(text):
        raw = m.group(1)
        raw = raw[1:-1] if raw.startswith('"') else raw.rstrip(TRAILING)
        if raw and raw not in out:
            out.append(raw)
    return out


def _file_attachment(path: Path, ref: str, ctx: ToolContext, max_lines: int) -> Attachment | None:
    raw = path.read_bytes()
    if b"\x00" in raw[:8000]:
        return Attachment("file", f"@{ref}（二进制，已跳过）", f"The user mentioned @{ref}, a binary file (not shown).")
    text = read_text(path)
    lines = text.splitlines()
    shown = lines[:max_lines]
    # 内容进了上下文 = 模型「读过」了：登记文件状态，模型可以直接 Edit，不用再 Read 一遍
    ctx.file_state.remember(path, text, partial=len(shown) < len(lines))
    more = (f"\n\n[showing first {len(shown)} of {len(lines)} lines; use Read with offset to see more]"
            if len(shown) < len(lines) else "")
    body = number_lines(shown, 1) if shown else "(file is empty)"
    return Attachment("file", f"@{ref}（{len(lines)} 行）",
                      f"The user mentioned @{ref}. Contents of {ctx.rel(path)} (same format as the Read tool):\n"
                      f"{body}{more}")


def _dir_attachment(path: Path, ref: str, ctx: ToolContext, limit: int = 200) -> Attachment:
    entries = sorted(p.name + ("/" if p.is_dir() else "") for p in path.iterdir() if p.name not in IGNORED_DIRS)
    listing = "\n".join(entries[:limit]) + (f"\n… ({len(entries) - limit} more)" if len(entries) > limit else "")
    return Attachment("directory", f"@{ref}（目录，{len(entries)} 项）",
                      f"The user mentioned the directory @{ref}. Its entries:\n{listing}")


def resolve_mentions(text: str, ctx: ToolContext, max_lines: int = MAX_LINES) -> list[Attachment]:
    atts = []
    for ref in find_mentions(text):
        path = ctx.resolve(ref)
        if path.is_file():
            att = _file_attachment(path, ref, ctx, max_lines)
        elif path.is_dir():
            att = _dir_attachment(path, ref, ctx)
        else:
            continue  # 不是路径（比如 @someone），原样留在文本里
        if att:
            atts.append(att)
    return atts


def build_user_content(text: str, attachments: list[Attachment]) -> str | list[dict]:
    """附件在前、用户原话在后：长资料放前面、问题放最后，是 Anthropic 长上下文提示的建议顺序。"""
    if not attachments:
        return text
    return [render(a) for a in attachments] + [{"type": "text", "text": text}]


# ---------------------------------------------------------------- 输入补全


def list_project_files(cwd: Path, limit: int = 20000) -> list[str]:
    """优先 git ls-files（尊重 .gitignore，快）；不是 git 仓库就自己走目录树。"""
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=cwd,
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0:
            files = [f for f in out.stdout.splitlines() if f]
            dirs = sorted({str(Path(f).parent) + "/" for f in files if "/" in f})
            return (files + dirs)[:limit]
    except (OSError, subprocess.TimeoutExpired):
        pass
    found: list[str] = []
    for root, dirnames, filenames in os.walk(cwd):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and not d.startswith("."))
        rel = Path(root).relative_to(cwd)
        if str(rel) != ".":
            found.append(f"{rel}/")
        found.extend(str(rel / f) if str(rel) != "." else f for f in sorted(filenames))
        if len(found) >= limit:
            break
    return found[:limit]


def fuzzy_score(query: str, candidate: str) -> int | None:
    """子序列匹配：query 的字符按顺序出现在 candidate 里就算命中。分数越小越好。"""
    q, c = query.lower(), candidate.lower()
    if not q:
        return len(c)
    pos, gaps, last = 0, 0, -1
    for ch in q:
        i = c.find(ch, pos)
        if i < 0:
            return None
        gaps += i - last - 1
        last, pos = i, i + 1
    name = c.rsplit("/", 1)[-1]
    bonus = -50 if q in name else (-20 if q in c else 0)  # 文件名直接包含 query 的排前面
    return gaps + len(c) // 10 + bonus


def rank(query: str, files: Iterable[str], limit: int = 20) -> list[str]:
    scored = [(s, f) for f in files if (s := fuzzy_score(query, f)) is not None]
    return [f for _, f in sorted(scored)[:limit]]


try:
    from prompt_toolkit.completion import Completer, Completion
except ImportError:  # pragma: no cover
    Completer = object  # type: ignore[assignment,misc]


class FileMentionCompleter(Completer):  # type: ignore[misc]
    """光标前的那个词以 @ 开头时，列出模糊匹配的项目文件。文件列表缓存 5 秒。"""

    def __init__(self, cwd: Path, ttl: float = 5.0):
        self.cwd, self.ttl = cwd, ttl
        self._cache: tuple[float, list[str]] = (0.0, [])

    def files(self) -> list[str]:
        ts, files = self._cache
        if time.monotonic() - ts > self.ttl:
            files = list_project_files(self.cwd)
            self._cache = (time.monotonic(), files)
        return files

    def get_completions(self, document, complete_event):
        word = document.text_before_cursor.split(" ")[-1]
        if not word.startswith("@"):
            return
        query = word[1:]
        for f in rank(query, self.files()):
            shown = f'"{f}"' if " " in f else f
            yield Completion(f"@{shown}", start_position=-len(word), display=f)
