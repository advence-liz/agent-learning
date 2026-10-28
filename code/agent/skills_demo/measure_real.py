#!/usr/bin/env python3
"""只读统计 ~/.claude/skills：常驻层（frontmatter）和按需层（正文 + 支持文件）各有多大。

只打印数字，不打印任何 skill 内容。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from skill_loader import DESC_CAP, load_skills  # noqa: E402

root = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / ".claude" / "skills"
skills = load_skills(root)
desc_chars = sum(min(len(s.description), DESC_CAP) for s in skills.values())
body_chars = sum(len(s.body) for s in skills.values())
extra = 0
for s in skills.values():
    for f in s.dir.rglob("*"):
        if f.is_file() and f.name != "SKILL.md" and f.suffix in {".md", ".py", ".sh", ".js", ".txt", ".json"}:
            extra += f.stat().st_size
over_cap = sum(1 for s in skills.values() if len(s.description) > DESC_CAP)
manual_only = sum(1 for s in skills.values() if s.meta.get("disable-model-invocation") == "true")
print(f"skills: {len(skills)}  (disable-model-invocation: {manual_only}, description 超 {DESC_CAP} 字符: {over_cap})")
print(f"L1 常驻 description 合计: {desc_chars:>9,} 字符")
print(f"L2 SKILL.md 正文合计:     {body_chars:>9,} 字符  ({body_chars / max(desc_chars, 1):.0f}x)")
print(f"L3 支持文件合计:          {extra:>9,} 字节")
