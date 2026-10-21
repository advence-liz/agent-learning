"""CLI 外壳：REPL + 斜杠命令注册表。"""

from __future__ import annotations

import argparse
import difflib
from dataclasses import dataclass, field
from typing import Callable

from .config import Settings
from .loop import Agent
from .model import AnthropicClient, FakeClient, ModelClient
from .auto_mode import AutoReviewer, keyword_reviewer_turn
from .mentions import FileMentionCompleter, build_user_content, resolve_mentions
from .session import Session, SessionStore
from .tools import ToolRegistry, default_tools
from .ui import BufferUI, ConsoleUI

EXIT = "exit"
Handler = Callable[["App", str], "str | None"]


@dataclass
class Command:
    name: str
    help: str
    handler: Handler
    aliases: tuple[str, ...] = ()


@dataclass
class CommandRegistry:
    commands: dict[str, Command] = field(default_factory=dict)
    _alias: dict[str, str] = field(default_factory=dict)

    def register(self, name: str, help: str, aliases: tuple[str, ...] = ()) -> Callable[[Handler], Handler]:
        def deco(fn: Handler) -> Handler:
            self.commands[name] = Command(name, help, fn, aliases)
            for a in aliases:
                self._alias[a] = name
            return fn

        return deco

    def lookup(self, name: str) -> Command | None:
        return self.commands.get(self._alias.get(name, name))

    def all_names(self) -> list[str]:
        return sorted([*self.commands, *self._alias])

    def dispatch(self, app: "App", line: str) -> str | None:
        name, _, arg = line.strip().partition(" ")
        cmd = self.lookup(name)
        if cmd is None:
            close = difflib.get_close_matches(name, self.all_names(), n=1)
            hint = f"，你是不是想输入 {close[0]}？" if close else "，输入 /help 查看全部命令"
            app.ui.error(f"未知命令 {name}{hint}")
            return None
        return cmd.handler(app, arg.strip())


# 全局默认注册表：各章节往这里 @COMMANDS.register(...) 加命令
COMMANDS = CommandRegistry()


class App:
    """把 Agent、UI、命令表粘在一起。测试直接 new App 然后调 handle_line()。"""

    def __init__(self, settings: Settings, client: ModelClient, ui: BufferUI | None = None,
                 commands: CommandRegistry = COMMANDS, reviewer_client: ModelClient | None = None):
        self.settings = settings
        self.client = client
        self.ui = ui or ConsoleUI()
        self.commands = commands
        self.agent = Agent(client, ToolRegistry(default_tools()), settings)
        self.agent.approver = self.ui.ask_permission
        self.agent.permissions.set_mode(settings.permission_mode)
        self.agent.permissions.on_mode_change.append(self._record_mode)
        # 第 6 章：auto 模式的审查员。用独立的 client，和主对话的上下文完全隔离
        self.reviewer = AutoReviewer(reviewer_client or client, lambda: self.agent.messages, str(settings.cwd))
        self.agent.permissions.classifier = self.reviewer
        self.store = SessionStore(settings.home, settings.cwd)
        self._attach(self.store.new())

    def _attach(self, session: Session) -> None:
        """把 Agent 的「新消息」事件接到当前会话文件上（换会话时先摘掉旧的）。"""
        old = getattr(self, "_recorder", None)
        if old in self.agent.listeners:
            self.agent.listeners.remove(old)
        self.session = session
        self._recorder = session.record
        self.agent.listeners.append(self._recorder)

    def _record_mode(self, old: str, new: str) -> None:
        # 和 Claude Code 一样把模式变化记进会话文件（读取时被忽略，只作审计）
        self.session.append_record({"type": "permission-mode", "permissionMode": new, "sessionId": self.session.id})

    def new_session(self) -> None:
        self.agent.reset()
        self._attach(self.store.new())

    def resume(self, session_id: str) -> int:
        session, messages, usage = self.store.load(session_id)
        self._attach(session)  # 先接上文件，load_history 里补的修复记录才会写进这个会话
        self.agent.load_history(messages, usage)
        return len(messages)

    def handle_line(self, line: str) -> str | None:
        line = line.strip()
        if not line:
            return None
        if line.startswith("/"):
            return self.commands.dispatch(self, line)
        # 第 8 章：@ 引用的文件作为附件放进这条 user 消息
        attachments = resolve_mentions(line, self.agent.ctx)
        for a in attachments:
            self.ui.info(f"  ⎿ 已附加 {a.title}")
        content = build_user_content(line, attachments)
        try:
            for ev in self.agent.run_turn(content):
                self.ui.render(ev)
        except KeyboardInterrupt:
            # run_turn 的 finally 已经补齐了悬空的 tool_use，这里只负责告诉用户
            self.ui.error("已中断（Ctrl+C），可以继续输入")
        return None


# ---------------------------------------------------------------- 内置命令


@COMMANDS.register("/help", "显示所有命令")
def _help(app: App, arg: str) -> None:
    rows = []
    for c in sorted(app.commands.commands.values(), key=lambda c: c.name):
        alias = f"（别名 {', '.join(c.aliases)}）" if c.aliases else ""
        rows.append((c.name, c.help + alias))
    app.ui.table(rows)


@COMMANDS.register("/new", "开启新会话，清空对话历史", aliases=("/clear",))
def _new(app: App, arg: str) -> None:
    app.new_session()
    app.ui.info(f"已开启新会话 {app.session.id[:8]}（旧会话仍在磁盘上，可用 /resume 找回）")


@COMMANDS.register("/status", "查看模型、消息数与 token 消耗")
def _status(app: App, arg: str) -> None:
    u = app.agent.usage
    app.ui.table([
        ("model", app.settings.model),
        ("effort", app.settings.effort),
        ("cwd", str(app.settings.cwd)),
        ("session", f"{app.session.id}"),
        ("mode", app.agent.permissions.mode),
        ("allow", ", ".join(sorted(app.agent.permissions.allow_rules)) or "-"),
        ("reviewer", f"{app.reviewer.calls} calls"),
        ("messages", str(len(app.agent.messages))),
        ("context", f"{u.last_input} tokens（最近一次请求的输入）"),
        ("total", f"in {u.input_tokens} / out {u.output_tokens} / {u.requests} requests"),
    ])


@COMMANDS.register("/model", "查看或切换模型：/model claude-sonnet-5-5")
def _model(app: App, arg: str) -> None:
    if arg:
        app.settings.model = arg
        if hasattr(app.client, "model"):
            app.client.model = arg
    app.ui.info(f"当前模型：{app.settings.model}")


@COMMANDS.register("/resume", "列出本项目的历史会话；/resume <序号|id 前缀> 恢复")
def _resume(app: App, arg: str) -> None:
    if not arg:
        infos = [i for i in app.store.list() if i.id != app.session.id]
        if not infos:
            app.ui.info("当前项目还没有历史会话")
            return
        app.ui.table([(f"{n}. {i.id[:8]}", f"{i.updated:%m-%d %H:%M}  {i.messages:>3} msgs  {i.title}")
                      for n, i in enumerate(infos, 1)])
        app.ui.info("输入 /resume <序号> 恢复")
        return
    try:
        sid = app.store.resolve(arg)
    except KeyError as e:
        app.ui.error(str(e.args[0]))
        return
    n = app.resume(sid)
    app.ui.info(f"已恢复会话 {sid[:8]}（{n} 条消息），继续聊吧")


@COMMANDS.register("/mode", "查看或切换权限模式：/mode acceptEdits（REPL 里也可按 Shift+Tab 循环切换）")
def _mode(app: App, arg: str) -> None:
    pm = app.agent.permissions
    if arg:
        try:
            pm.set_mode(arg)
        except ValueError as e:
            app.ui.error(str(e))
            return
    app.ui.info(f"权限模式：{pm.mode}（循环顺序：{' → '.join(pm.cycle)}）")


@COMMANDS.register("/exit", "退出", aliases=("/quit",))
def _exit(app: App, arg: str) -> str:
    return EXIT


# ---------------------------------------------------------------- 入口


def repl(app: App) -> None:
    import sys

    if not sys.stdin.isatty():  # 管道输入（演示/脚本化）：不用 prompt_toolkit，逐行读并回显
        while line := sys.stdin.readline():  # 用 readline 而不是 for 迭代：权限弹窗的 input() 要和它共用缓冲
            app.ui.info(f"❯ {line.rstrip()}")
            if app.handle_line(line) == EXIT:
                break
        return
    from prompt_toolkit import PromptSession
    from prompt_toolkit.completion import Completer, Completion, merge_completers
    from prompt_toolkit.key_binding import KeyBindings

    class CommandCompleter(Completer):
        """只在行首补全斜杠命令。"""

        def get_completions(self, document, complete_event):
            text = document.text_before_cursor
            if text.startswith("/") and " " not in text:
                for name in app.commands.all_names():
                    if name.startswith(text):
                        yield Completion(name, start_position=-len(text))

    kb = KeyBindings()

    @kb.add("s-tab")
    def _cycle(event) -> None:  # Shift+Tab：循环切换权限模式，和 Claude Code 一样
        app.agent.permissions.next_mode()
        event.app.invalidate()

    session = PromptSession(
        completer=merge_completers([CommandCompleter(), FileMentionCompleter(app.settings.cwd)]),
        complete_while_typing=True,
        key_bindings=kb,
        bottom_toolbar=lambda: f" ▶▶ {app.agent.permissions.mode}（Shift+Tab 切换）",
    )
    app.ui.info(f"mini-cc · {app.settings.model} · {app.settings.cwd}（/help 查看命令）")
    while True:
        try:
            line = session.prompt("❯ ")
        except (EOFError, KeyboardInterrupt):
            break
        if app.handle_line(line) == EXIT:
            break


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mini_cc")
    parser.add_argument("--model", default=None)
    parser.add_argument("-p", "--print", dest="prompt", help="非交互：跑一轮就退出")
    parser.add_argument("--fake", metavar="SCRIPT.json", help="离线 fake 模型：按脚本回放，不发任何 API 请求")
    parser.add_argument("--permission-mode", choices=["default", "acceptEdits", "auto", "plan", "bypassPermissions"])
    parser.add_argument("-r", "--resume", metavar="ID", help="恢复指定会话（序号或 id 前缀）")
    parser.add_argument("-c", "--continue", dest="cont", action="store_true", help="恢复本项目最近一次会话")
    args = parser.parse_args(argv)
    settings = Settings()
    if args.model:
        settings.model = args.model
    if args.permission_mode:
        settings.permission_mode = args.permission_mode
    if args.fake:
        client: ModelClient = FakeClient.from_json(args.fake)
        reviewer: ModelClient = FakeClient(responder=keyword_reviewer_turn)  # 离线的关键词审查员
    else:
        client = AnthropicClient(settings.model, fallbacks=settings.fallbacks)
        reviewer = AnthropicClient(settings.model, fallbacks=settings.fallbacks)
    app = App(settings, client, reviewer_client=reviewer)
    if args.resume or args.cont:
        infos = app.store.list()
        if not infos:
            app.ui.error("当前项目没有可恢复的会话")
        else:
            sid = app.store.resolve(args.resume) if args.resume else infos[0].id
            app.ui.info(f"已恢复会话 {sid[:8]}（{app.resume(sid)} 条消息）")
    if args.prompt:
        app.handle_line(args.prompt)
        return 0
    repl(app)
    return 0
