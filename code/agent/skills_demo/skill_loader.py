#!/usr/bin/env python3
"""渐进式披露（progressive disclosure）的最小实现。

三层，按需逐层进入上下文：
  L1 listing   —— 每个 skill 只有 name + description，常驻（会话开始就注入）
  L2 SKILL.md  —— 被调用时，渲染后的正文作为一条消息追加到对话末尾
  L3 支持文件  —— 正文里只放路径，模型自己决定要不要 Read

和官方文档对齐的规则：
  - 每条 description（含 when_to_use）在 listing 里截断到 1536 字符；
  - listing 总预算 = 上下文窗口的 1%，超了先砍「最少用」的 description，只留名字；
  - disable-model-invocation: true 的 skill 不进 listing（模型看不到，只能用户 /name）；
  - $ARGUMENTS / $N / ${CLAUDE_SKILL_DIR} 替换；!`cmd` 在发给模型前先执行、输出替换占位；
  - 没有占位符接收参数时，末尾追加 "ARGUMENTS: <value>"。
"""

from __future__ import annotations

import re
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

DESC_CAP = 1536


@dataclass
class Skill:
    name: str
    description: str
    meta: dict
    body: str
    dir: Path


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """极简 YAML：`key: value` 单行，外加 `key: >-` / `key: |` 的缩进续行（真实实现是完整 YAML）。"""
    if not text.startswith("---\n"):
        return {}, text  # 首行不是 --- → 整个文件当正文
    end = text.index("\n---", 4)
    meta: dict[str, str] = {}
    key = None
    for line in text[4:end].splitlines():
        if line.startswith((" ", "\t")) and key:
            meta[key] = (meta[key] + " " + line.strip()).strip()
        elif ":" in line:
            k, v = line.split(":", 1)
            key, v = k.strip(), v.strip()
            meta[key] = "" if v in {">", ">-", "|", "|-"} else v.strip('"')
    return meta, text[end + 4:].lstrip("\n")


def load_skills(root: Path) -> dict[str, Skill]:
    out = {}
    for p in sorted(root.glob("*/SKILL.md")):
        meta, body = parse_frontmatter(p.read_text(encoding="utf-8"))
        name = meta.get("name", p.parent.name)
        desc = (meta.get("description", "") + " " + meta.get("when_to_use", "")).strip()
        out[name] = Skill(name, desc, meta, body, p.parent)
    return out


def build_listing(skills: dict[str, Skill], context_window_tokens: int, usage: dict[str, int] | None = None,
                  chars_per_token: int = 4) -> str:
    """L1：拼出常驻的 skill 清单。预算按字符算（1% 上下文 × 每 token 约 4 字符，粗估）。"""
    budget = int(context_window_tokens * 0.01 * chars_per_token)
    usage = usage or {}
    visible = [s for s in skills.values() if s.meta.get("disable-model-invocation") != "true"]
    entries = {s.name: s.description[:DESC_CAP] for s in visible}

    def render() -> str:
        return "\n".join(f"- {n}: {d}" if d else f"- {n}" for n, d in entries.items())

    for name in sorted(entries, key=lambda n: usage.get(n, 0)):  # 最少用的先被砍
        if len(render()) <= budget:
            break
        entries[name] = ""
    return render()


def render_body(skill: Skill, arguments: str) -> str:
    """L2：调用时才渲染正文。"""
    args = shlex.split(arguments) if arguments else []
    body = skill.body
    used = False

    def sub_n(m):
        nonlocal used
        used = True
        i = int(m.group(1))
        return args[i] if i < len(args) else ""

    if "$ARGUMENTS" in body:
        used = True
        body = body.replace("$ARGUMENTS", arguments)
    body = re.sub(r"\$(\d+)", sub_n, body)
    body = body.replace("${CLAUDE_SKILL_DIR}", str(skill.dir))

    def run_cmd(m):
        r = subprocess.run(m.group(1), shell=True, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"skill 预处理命令失败，整个调用中止：{m.group(1)}")
        return r.stdout.strip()

    body = re.sub(r"(?m)(?<!\S)!`([^`]+)`", run_cmd, body)
    if arguments and not used:
        body += f"\n\nARGUMENTS: {arguments}"
    return f"Base directory for this skill: {skill.dir}\n\n{body}"


def invoke(messages: list[dict], skills: dict[str, Skill], name: str, arguments: str = "") -> None:
    """把渲染结果**追加**到对话末尾（不改前面任何内容 → prompt cache 前缀不动）。"""
    messages.append({"role": "user", "content": render_body(skills[name], arguments)})


if __name__ == "__main__":
    root = Path(__file__).parent / "skills"
    skills = load_skills(root)
    print("== L1 listing（常驻）==")
    print(build_listing(skills, context_window_tokens=200_000))
    print("\n== L1 listing，上下文只有 1.5k token 时（预算 60 字符）==")
    print(build_listing(skills, context_window_tokens=1_500))
    msgs: list[dict] = []
    invoke(msgs, skills, "pr-summary", "develop")
    print("\n== L2 调用 /pr-summary develop 后追加的消息 ==")
    print(msgs[-1]["content"].replace(str(root), "<skills_demo/skills>"))
