"""Skills 渐进式加载（第 20 章）。

三层，按需进上下文：
1. 目录：每个 skill 一行「name: description」，放 system（会话开始时算一次）。总长度超预算时，
   先把最少被调用的 skill 的描述砍掉，只留名字。
2. 正文：模型调 Skill 工具（或你敲 /skill-name）时，渲染 SKILL.md（替换参数、执行 !`cmd`），作为一条
   普通文本追加进上下文，之后一直留着。
3. 附录：references/、scripts/ 里的文件不自动加载，正文里只给路径，模型需要时自己 Read / Bash。

位置：<home>/skills/<name>/SKILL.md（用户级）、<cwd>/.mini_cc/skills/<name>/SKILL.md（项目级，同名覆盖用户级）。
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .tools.base import Tool, ToolContext, ToolResult

MAX_DESCRIPTION = 1536          # 单个 skill 在目录里最多保留的描述长度（Claude Code 文档的数字）
_CMD = re.compile(r"!`([^`]+)`")
_POS = re.compile(r"\$(\d)")


@dataclass
class Skill:
    name: str
    description: str
    dir: Path
    body: str
    scope: str                  # user | project
    model_invocable: bool = True

    @property
    def path(self) -> Path:
        return self.dir / "SKILL.md"


def _frontmatter(text: str) -> tuple[dict[str, str], str]:
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep:
            meta[k.strip()] = v.strip().strip("\"'")
    return meta, m.group(2)


def load_skills(cwd: Path, home: Path) -> dict[str, Skill]:
    out: dict[str, Skill] = {}
    for scope, root in (("user", home / "skills"), ("project", cwd / ".mini_cc" / "skills")):
        for f in sorted(root.glob("*/SKILL.md")) if root.is_dir() else []:
            meta, body = _frontmatter(f.read_text(encoding="utf-8"))
            name = meta.get("name") or f.parent.name
            out[name] = Skill(name, meta.get("description", ""), f.parent, body, scope,
                              meta.get("disable-model-invocation", "").lower() != "true")
    return out


# ---------------------------------------------------------------- 第 1 层：目录


def listing(skills: Iterable[Skill], budget_chars: int, usage: dict[str, int] | None = None) -> str:
    """模型可调用的 skill 目录。超预算时按调用次数从少到多砍描述（名字永远保留）。"""
    usage = usage or {}
    items = sorted((s for s in skills if s.model_invocable), key=lambda s: s.name)
    desc = {s.name: s.description[:MAX_DESCRIPTION] for s in items}
    line = lambda s: f"- {s.name}: {desc[s.name]}" if desc[s.name] else f"- {s.name}"  # noqa: E731
    dropped = 0
    for s in sorted(items, key=lambda s: (usage.get(s.name, 0), s.name)):
        if sum(len(line(x)) + 1 for x in items) <= budget_chars:
            break
        if desc[s.name]:
            desc[s.name] = ""
            dropped += 1
    lines = [line(s) for s in items]
    if dropped:
        lines.append(f"({dropped} descriptions omitted to fit the listing budget; the names are still invocable)")
    return "\n".join(lines)


GUIDE = """# Skills
Skills are packaged instructions for specific tasks. Below is the list of skills you can invoke with the Skill
tool: name and a one-line description of when to use it. When a request matches a skill, invoke it BEFORE
starting the work; its full instructions will be added to the conversation. Do not guess a skill's contents
from its name. Files a skill mentions (references/, scripts/) are not loaded: Read or run them when needed.

{listing}"""


# ---------------------------------------------------------------- 第 2 层：正文


class SkillError(RuntimeError):
    pass


def render_body(skill: Skill, args: str, cwd: Path, timeout: float = 15) -> str:
    """替换参数和目录占位符，执行 !`cmd`（输出替换占位符；任一失败则整个调用失败）。"""
    text = skill.body.replace("${SKILL_DIR}", str(skill.dir))
    had_placeholder = "$ARGUMENTS" in text or bool(_POS.search(text))
    parts = args.split()
    text = text.replace("$ARGUMENTS", args)
    text = _POS.sub(lambda m: parts[int(m[1])] if int(m[1]) < len(parts) else "", text)

    def run(m: re.Match) -> str:
        try:
            p = subprocess.run(m[1], shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            raise SkillError(f"preprocess command `{m[1]}` timed out after {timeout:g}s") from e
        if p.returncode != 0:
            raise SkillError(f"preprocess command `{m[1]}` failed with exit code {p.returncode}: "
                             f"{(p.stderr or p.stdout).strip()[:200]}")
        return p.stdout.strip()

    text = _CMD.sub(run, text)
    if args and not had_placeholder:
        text = text.rstrip("\n") + f"\n\nARGUMENTS: {args}\n"
    return f"Base directory for this skill: {skill.dir}\n\n{text}"


class SkillTool(Tool):
    name = "Skill"
    kind = "skill"
    description = ("Invoke a skill from the # Skills list in the system prompt. Its full instructions are then "
                   "added to the conversation; follow them. Use the exact skill name.")
    input_schema = {
        "type": "object",
        "properties": {
            "skill": {"type": "string", "description": "Skill name from the list"},
            "args": {"type": "string", "description": "Optional arguments"},
        },
        "required": ["skill"],
        "additionalProperties": False,
    }

    def self_check(self, args) -> str | None:
        return "allow"  # 加载说明书本身不碰任何东西（!`cmd` 是 skill 作者写的，和装 skill 一样是信任决定）

    def summary(self, args) -> str:
        return f"Skill({args.get('skill')}{' ' + args['args'] if args.get('args') else ''})"

    def run(self, args, ctx: ToolContext) -> ToolResult:
        rt: SkillRuntime | None = ctx.extras.get("skills")
        if rt is None:
            return ToolResult("Skills are not available here.", True)
        skill = rt.skills.get(args["skill"])
        if skill is None:
            return ToolResult(f"Unknown skill {args['skill']!r}. Available: "
                              f"{', '.join(n for n, s in rt.skills.items() if s.model_invocable)}", True)
        if not skill.model_invocable:
            return ToolResult(f"Skill {skill.name} can be invoked only by the user (as /{skill.name}).", True)
        try:
            body = rt.invoke(skill, args.get("args", ""), ctx.cwd)
        except SkillError as e:
            return ToolResult(f"Skill {skill.name} failed: {e}", True)
        # 正文不放在 tool_result 里，而是作为一条普通文本紧跟在结果后面（同一条 user 消息）
        ctx.followup_blocks.append({"type": "text", "text": body})
        return ToolResult(f"Launching skill: {skill.name}")


class SkillRuntime:
    """会话级状态：可用的 skill、调用次数（决定目录预算里谁先被砍描述）、本会话调用过的正文（压缩后挂回）。"""

    def __init__(self, skills: dict[str, Skill], usage_path: Path):
        self.skills = skills
        self.usage_path = usage_path
        self.usage: dict[str, int] = json.loads(usage_path.read_text()) if usage_path.exists() else {}
        self.invoked: dict[str, str] = {}

    def invoke(self, skill: Skill, args: str, cwd: Path) -> str:
        body = render_body(skill, args, cwd)
        self.invoked[skill.name] = body
        self.usage[skill.name] = self.usage.get(skill.name, 0) + 1
        self.usage_path.parent.mkdir(parents=True, exist_ok=True)
        self.usage_path.write_text(json.dumps(self.usage, ensure_ascii=False))
        return body

    def system_section(self, budget_chars: int) -> str | None:
        text = listing(self.skills.values(), budget_chars, self.usage)
        return GUIDE.format(listing=text) if text else None
