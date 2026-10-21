from __future__ import annotations

import re
import shlex
import subprocess

from .base import Tool, ToolContext, ToolResult

# 只读命令白名单：这些命令（且不带危险参数、不含重定向）可以免审批
READ_ONLY_COMMANDS = {
    "ls", "cat", "head", "tail", "pwd", "echo", "grep", "rg", "wc", "which", "stat", "file", "tree",
    "du", "df", "date", "whoami", "uname", "env", "printenv", "basename", "dirname", "realpath", "sort", "uniq",
}
READ_ONLY_GIT = {"status", "diff", "log", "show", "branch", "rev-parse", "remote", "blame", "ls-files"}
DANGEROUS = [
    re.compile(p) for p in (
        r"\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(/|~|\$HOME|\*)(\s|$)",  # rm -rf / ~ *
        r"\bsudo\b", r"\bmkfs\b", r"\bdd\s+.*of=/dev/", r">\s*/dev/sd", r":\(\)\s*\{.*\};\s*:",  # fork bomb
        r"\bgit\s+push\b.*--force", r"\bcurl\b.*\|\s*(ba)?sh", r"\bchmod\s+-R\s+777\s+/",
    )
]


def split_commands(command: str) -> list[list[str]] | None:
    """按 | && || ; 拆成子命令并分词。含重定向、命令替换等复杂语法时返回 None（看不懂就不放行）。"""
    if any(tok in command for tok in ("`", "$(", ">", "<", "&>", "\n")):
        return None
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars="|&;")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return None
    parts: list[list[str]] = [[]]
    for t in tokens:
        if t in ("|", "||", "&&", ";"):
            parts.append([])
        elif set(t) <= set("|&;"):
            return None  # 后台 & 之类
        else:
            parts[-1].append(t)
    return [p for p in parts if p] or None


def is_read_only(command: str) -> bool:
    parts = split_commands(command)
    if not parts:
        return False
    for argv in parts:
        prog = argv[0]
        if prog == "git":
            if len(argv) < 2 or argv[1] not in READ_ONLY_GIT:
                return False
        elif prog == "find":
            if any(a in ("-exec", "-execdir", "-delete", "-ok") for a in argv):
                return False
        elif prog not in READ_ONLY_COMMANDS:
            return False
    return True


class BashTool(Tool):
    name = "Bash"
    description = "Run a shell command in the project directory and return stdout/stderr."
    input_schema = {
        "type": "object",
        "properties": {
            "command": {"type": "string"},
            "timeout": {"type": "integer", "description": "Seconds, default 30"},
        },
        "required": ["command"],
    }

    def run(self, args, ctx: ToolContext) -> ToolResult:
        timeout = args.get("timeout", 30)
        try:
            proc = subprocess.run(
                args["command"], shell=True, cwd=ctx.cwd, capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            partial = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            return ToolResult(f"{partial.rstrip()}\n[timed out after {timeout}s]".strip(), is_error=True)
        parts = [proc.stdout.rstrip()]
        if proc.stderr.strip():
            parts.append(f"[stderr]\n{proc.stderr.rstrip()}")
        if proc.returncode != 0:
            parts.append(f"[exit code {proc.returncode}]")
        out = "\n".join(p for p in parts if p) or "(no output)"
        return ToolResult(out, is_error=proc.returncode != 0)

    kind = "exec"

    def self_check(self, args) -> str | None:
        cmd = args.get("command", "")
        if any(p.search(cmd) for p in DANGEROUS):
            return "ask"
        if is_read_only(cmd):
            return "allow"
        return None

    def rule_key(self, args) -> str:
        return f"Bash({args.get('command', '')})"

    def summary(self, args) -> str:
        return f"Bash({args.get('command', '')})"
