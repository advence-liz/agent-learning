"""CLI 外壳：REPL + 斜杠命令注册表。"""

from __future__ import annotations

import argparse
import base64
from pathlib import Path
import json
import difflib
from dataclasses import dataclass, field
from typing import Callable

from .config import Settings
from .loop import Agent
from .model import AnthropicClient, FakeClient, ModelClient
from .auto_mode import AutoReviewer, keyword_reviewer_turn
from .compact import auto_compact_hook, compact
from .mcp_client import Approvals, McpManager, ServerState, load_config, select_servers
from .jobs import JobManager
from .plan_mode import EnterPlanModeTool, ExitPlanModeTool, PlanController, plan_check, plan_mode_provider
from .skills import SkillError, SkillRuntime, SkillTool, load_skills
from .subagent import AgentTool, SubagentRuntime, load_agent_types
from .memory import MemoryStore
from .mentions import FileMentionCompleter, build_user_content, resolve_mentions
from .rewind import Checkpoint, FileHistory, is_prompt, prompt_text
from .session import Session, SessionStore
from .tasks import TaskStore
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
        skills = getattr(app, "skill_rt", None)
        if cmd is None and skills and name[1:] in skills.skills:  # 第 20 章：没有同名内置命令，就当 skill 展开
            return app.run_skill_command(name[1:], arg.strip())
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
        self.agent.ctx.extras["ask_user"] = self.ui.ask_questions  # 第 10 章
        self.agent.permissions.set_mode(settings.permission_mode)
        self.agent.permissions.on_mode_change.append(self._record_mode)
        # 第 6 章：auto 模式的审查员。用独立的 client，和主对话的上下文完全隔离
        self.reviewer = AutoReviewer(reviewer_client or client, lambda: self.agent.messages, str(settings.cwd))
        self.agent.permissions.classifier = self.reviewer
        self.store = SessionStore(settings.home, settings.cwd)
        # 第 12 章：长期记忆。索引放进 system（会话开始时求值一次），Memory 工具从 extras 拿到它
        self.memory = MemoryStore.for_project(settings.home, settings.cwd)
        self.agent.ctx.extras["memory"] = self.memory
        self.agent.context.system_sections.append(self.memory.system_section)
        # 第 13 章：Write/Edit 写盘前给文件拍快照；回退后把用户原话放回输入框
        self.agent.ctx.write_hooks.append(lambda path: self.file_history.before_write(path))
        self.prefill = ""
        # 第 15 章：MCP。连接在 start_mcp() 里做（要先问用户批准项目级 server）；server 的说明进 system
        self.mcp = McpManager(settings.home / "logs")
        self.agent.context.system_sections.append(self.mcp.instructions_section)
        # 第 14 章：每次请求模型前检查上下文是否逼近窗口
        self.agent.before_request.append(auto_compact_hook)
        self._attach(self.store.new())
        # 第 16 章：后台任务。输出文件放 <home>/tasks/<启动时的会话 id>/，文件会一直变，不做「外部修改」提醒
        self.jobs = JobManager(settings.home / "tasks" / self.session.id, self.agent.notify)
        self.agent.ctx.extras["jobs"] = self.jobs
        self.agent.ctx.untracked_dirs.append(self.jobs.dir)
        self.busy = False
        # 第 17 章：sub agent。类型在启动时读一次（工具描述会话内不变，prompt cache 稳定）
        self.subagent_types = load_agent_types(settings.cwd, settings.home)
        self.agent.tools.register(AgentTool(lambda: self.subagent_types))
        self.agent.ctx.extras["subagents"] = SubagentRuntime(self)
        self.subagent_client = lambda description: self.client  # 测试 / 离线演示可以换成单独的剧本
        self.subagent_max_turns = 30
        # 第 20 章：skills。目录进 system（预算：窗口的 1%，按 4 字符/token 换成字符数），正文按需加载
        self.skill_rt = SkillRuntime(load_skills(settings.cwd, settings.home), settings.home / "skills-usage.json")
        self.agent.ctx.extras["skills"] = self.skill_rt
        self.agent.tools.register(SkillTool())
        self.agent.context.system_sections.append(
            lambda: self.skill_rt.system_section(settings.context_window // 100 * 4))
        # 第 21 章：plan 模式 = 规则提醒（provider）+ 权限关卡（extra_checks）+ 交接工具 + 只读 sub agent
        pm = self.agent.permissions
        pm.extra_checks.append(plan_check(lambda: self.plan_file))
        self.agent.context.providers.append(plan_mode_provider(lambda: self.plan_file))
        self.agent.tools.register(EnterPlanModeTool())
        self.agent.tools.register(ExitPlanModeTool())
        self.agent.ctx.extras["plan"] = PlanController(pm, lambda: self.plan_file, self.ui.ask_plan_approval)

    def _attach(self, session: Session) -> None:
        """把 Agent 的「新消息」事件接到当前会话文件上（换会话时先摘掉旧的）。"""
        old = getattr(self, "_recorder", None)
        for fn in (old, self._on_message):
            if fn in self.agent.listeners:
                self.agent.listeners.remove(fn)
        self.session = session
        self._recorder = session.record
        self.agent.listeners.append(self._recorder)
        self.agent.listeners.append(self._on_message)  # 排在落盘之后：要用它刚分配的 uuid
        self.file_history = FileHistory.load(self.settings.home / "file-history" / session.id)
        # 第 11 章：任务清单跟着会话走（/new 换新清单，/resume 载入旧清单）
        self.agent.ctx.extras["tasks"] = TaskStore.load(session.tasks_path)
        # 换会话 = 重新算一次 system：上个会话里新存的记忆从这里开始进上下文
        self.agent.context.invalidate()

    @property
    def plan_file(self) -> Path:
        """每个会话一份计划文件（Claude Code 放在 ~/.claude/plans/）。"""
        return self.settings.home / "plans" / f"{self.session.id}.md"

    def start_mcp(self) -> None:
        """读 .mcp.json → 批准 → 并行连接 → 把工具注册进 ToolRegistry。在第一次请求模型之前调用。"""
        configs = load_config(self.settings.cwd, self.settings.home)
        if not configs:
            return
        approvals = Approvals(self.settings.home / "mcp-approvals.json", str(self.settings.cwd.resolve()))
        start, rejected = select_servers(configs, approvals, self.ui.ask, self.ui.info)
        self.mcp.start(start)
        for cfg in rejected:
            self.mcp.servers[cfg.name] = ServerState(cfg.name, cfg, "disabled")
        for tool in self.mcp.tools():
            self.agent.tools.register(tool)
        self.agent.context.invalidate()  # system 里多了 server instructions
        states = list(self.mcp.servers.values())
        ok = [s for s in states if s.status == "connected"]
        bad = [s.name for s in states if s.status == "failed"]
        self.ui.info(f"MCP：{len(ok)}/{len(states)} 个 server 已连接，{sum(len(s.tools) for s in ok)} 个工具"
                     + (f"；连接失败：{', '.join(bad)}（/mcp 查看原因）" if bad else ""))

    def close(self) -> None:
        self.jobs.stop_all()
        self.mcp.close()

    def run_skill_command(self, name: str, arg: str) -> None:
        """/skill-name args：prompt 型命令。正文展开后作为这一轮的用户消息发给模型（这一条命令是花钱的）。"""
        try:
            body = self.skill_rt.invoke(self.skill_rt.skills[name], arg, self.settings.cwd)
        except SkillError as e:
            self.ui.error(f"skill {name} 加载失败：{e}")
            return
        self.ui.info(f"  ⎿ 已加载 skill {name}（{len(body)} 字符）")
        self._run([{"type": "text", "text": body},
                   {"type": "text", "text": f"<command-name>/{name}</command-name>\n<command-args>{arg}</command-args>"}])

    def wake_if_idle(self) -> bool:
        """空闲时有通知（后台命令结束、sub agent 交报告、监听到事件）：主动开一轮，把通知交给模型。"""
        if self.busy or self.agent.notifications.empty():
            return False
        self._run([])  # 空内容：providers 会把通知作为 <system-reminder> 放进这条 user 消息
        return True

    def _run(self, content) -> None:
        self.busy = True
        try:
            for ev in self.agent.run_turn(content):
                self.ui.render(ev)
        except KeyboardInterrupt:
            # run_turn 的 finally 已经补齐了悬空的 tool_use，这里只负责告诉用户
            self.ui.error("已中断（Ctrl+C），可以继续输入")
        finally:
            self.busy = False

    def _on_message(self, msg: dict, meta: dict) -> None:
        """第 13 章：用户亲手发的每条消息开一个检查点。"""
        if is_prompt(msg) and self.session.last_uuid and not meta.get("compact"):
            self.file_history.begin(self.session.last_uuid, prompt_text(msg))

    def rewind(self, n: int, mode: str = "both") -> tuple[Checkpoint, list[tuple[str, str]]]:
        """回到第 n 个检查点（这条用户消息发出之前）。mode: both | conversation | code。"""
        cp = self.checkpoints()[n - 1]
        changes = []
        if mode in ("both", "code"):
            changes = self.file_history.restore(cp.uuid)
            for path, _ in changes:
                self.agent.ctx.file_state.forget(Path(path))
        if mode in ("both", "conversation"):
            keep = self.session.chain.index(cp.uuid)
            self.agent.load_history(self.agent.messages[:keep], self.agent.usage)  # 原来的前缀，逐字节不变
            self.session.rewind(keep)
            self.file_history.truncate(cp.uuid)
            # 这条分支上模型「读过」什么已经说不清了：和 /resume 一样，从头信任磁盘
            self.agent.ctx.file_state.clear()
            self.prefill = cp.prompt
        return cp, changes

    def checkpoints(self) -> list[Checkpoint]:
        """当前分支上的检查点（压缩、回退之后不在链上的不算）。"""
        return [c for c in self.file_history.checkpoints if c.uuid in self.session.chain]

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
        # 以 / 开头但第一个词里还有 /，是拖进来的绝对路径（第 19 章），不是斜杠命令
        if line.startswith("/") and "/" not in line.split()[0][1:]:
            return self.commands.dispatch(self, line)
        # 第 8 章：@ 引用的文件作为附件放进这条 user 消息
        attachments = resolve_mentions(line, self.agent.ctx)
        for a in attachments:
            self.ui.info(f"  ⎿ 已附加 {a.title}")
        self._run(build_user_content(line, attachments))
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
        ("context", f"{u.last_input} tokens（最近一次请求的输入）/ 窗口 {app.settings.context_window}，"
                    f"超过 {app.settings.context_window - app.settings.auto_compact_buffer} 自动压缩"),
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


@COMMANDS.register("/context", "查看上下文里都放了什么（system 段落、注入的提醒、历史）")
def _context(app: App, arg: str) -> None:
    from .attachments import is_reminder

    rows = []
    for i, b in enumerate(app.agent.context.system_blocks()):
        first = b["text"].splitlines()[0][:40]
        rows.append((f"system[{i}]", f"{len(b['text']):>6} chars  {first}"))
    from .images import estimate_visual_tokens, image_info

    n_rem = n_rem_chars = n_msg_chars = n_img = img_tokens = 0

    def images_in(b):
        if b.get("type") == "image":
            yield b
        elif b.get("type") == "tool_result" and isinstance(b.get("content"), list):
            yield from (c for c in b["content"] if c.get("type") == "image")

    for m in app.agent.messages:
        blocks = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
        for b in blocks:
            for img in images_in(b):  # 第 19 章：图片按 visual token 估算，不按 base64 字符数
                n_img += 1
                info = image_info(base64.b64decode(img["source"].get("data", "")))
                img_tokens += estimate_visual_tokens(info[1], info[2]) if info else 0
            if b.get("type") == "image":
                continue
            if b.get("type") == "tool_result" and isinstance(b.get("content"), list):
                b = {**b, "content": [c for c in b["content"] if c.get("type") != "image"]}
            size = len(json.dumps(b, ensure_ascii=False))
            if is_reminder(b):
                n_rem += 1
                n_rem_chars += size
            else:
                n_msg_chars += size
    rows.append(("reminders", f"{n_rem_chars:>6} chars  {n_rem} 个 <system-reminder> 块"))
    rows.append(("messages", f"{n_msg_chars:>6} chars  {len(app.agent.messages)} 条消息（不含提醒）"))
    if n_img:
        rows.append(("images", f"{img_tokens:>6} tokens（估算）  {n_img} 张图片"))
    rows.append(("last request", f"{app.agent.usage.last_input:>6} tokens"))
    app.ui.table(rows)


@COMMANDS.register("/todos", "查看当前会话的任务清单")
def _todos(app: App, arg: str) -> None:
    app.ui.info(app.agent.ctx.extras["tasks"].render())


@COMMANDS.register("/memory", "查看长期记忆索引；/memory rm <slug> 删除一条")
def _memory(app: App, arg: str) -> None:
    store = app.memory
    if arg.startswith("rm "):
        slug = arg[3:].strip()
        app.ui.info(f"已删除 {slug}" if store.delete(slug) else f"没有 {slug}")
        return
    entries = store.entries()
    app.ui.info(f"记忆目录：{store.dir}（{len(entries)} 条，下个会话开始时进上下文）")
    if entries:
        app.ui.table([(e.slug, f"{e.name} — {e.description}") for e in entries])


@COMMANDS.register("/rewind", "回退对话和/或代码：/rewind 列出检查点；/rewind <n> [both|conversation|code]",
                   aliases=("/checkpoint", "/undo"))
def _rewind(app: App, arg: str) -> None:
    cps = app.checkpoints()
    if not cps:
        app.ui.info("还没有可回退的检查点（每条你发出的消息是一个检查点）")
        return
    if not arg:
        for i, c in enumerate(cps, 1):
            n = len(c.files)
            app.ui.info(f"{i}. {c.prompt.splitlines()[0][:40] if c.prompt else '(空)'}  "
                        f"（{'改了 ' + str(n) + ' 个文件' if n else '未改文件'}）")
        app.ui.info("输入 /rewind <序号> [both|conversation|code] 回到那条消息发出之前（默认 both）")
        return
    num, _, mode = arg.partition(" ")
    mode = mode.strip() or "both"
    if mode not in ("both", "conversation", "code"):
        app.ui.error("模式只能是 both / conversation / code")
        return
    if not num.isdigit() or not 1 <= int(num) <= len(cps):
        app.ui.error(f"没有第 {num} 个检查点（共 {len(cps)} 个）")
        return
    cp, changes = app.rewind(int(num), mode)
    for path, action in changes:
        app.ui.info(f"  ⎿ {'恢复' if action == 'restored' else '删除（这之后才新建的）'} {app.agent.ctx.rel(Path(path))}")
    if mode in ("both", "code") and not changes:
        app.ui.info("  ⎿ 没有可恢复的文件改动（Bash 改的文件不在检查点里）")
    if mode in ("both", "conversation"):
        app.ui.info(f"已回到第 {num} 个检查点之前，对话剩 {len(app.agent.messages)} 条消息")
        app.ui.info(f"原话：{cp.prompt}（已放回输入框，可以改一改再发）")
    else:
        app.ui.info("代码已恢复，对话保持不变")


@COMMANDS.register("/compact", "把当前对话压缩成摘要；/compact <要重点保留什么> 可以引导摘要")
def _compact(app: App, arg: str) -> None:
    if not app.agent.messages:
        app.ui.info("当前没有对话可以压缩")
        return
    for ev in compact(app.agent, "manual", arg):
        app.ui.render(ev)


@COMMANDS.register("/mcp", "查看 MCP server 的连接状态和工具")
def _mcp(app: App, arg: str) -> None:
    if not app.mcp.servers:
        app.ui.info("没有配置 MCP server（项目 .mcp.json 或 ~/.mini_cc/mcp.json）")
        return
    rows = []
    for st in app.mcp.servers.values():
        detail = f"{len(st.tools)} tools" if st.status == "connected" else st.error or "-"
        rows.append((st.name, f"{st.status:<10} {st.config.scope:<8} {detail}"))
        if arg == "-v" and st.status == "connected":
            rows += [("", f"  mcp__{st.name}__{t.name}{'  (read-only)' if t.annotations and t.annotations.read_only_hint else ''}")
                     for t in st.tools]
    app.ui.table(rows)


@COMMANDS.register("/tasks", "查看后台任务；/tasks stop <id> 停止", aliases=("/bashes",))
def _tasks(app: App, arg: str) -> None:
    if arg.startswith("stop "):
        job = app.jobs.stop(arg[5:].strip())
        app.ui.info(f"已停止 {job.id}" if job else f"没有任务 {arg[5:].strip()}")
        return
    if not app.jobs.jobs:
        app.ui.info("没有后台任务")
        return
    app.ui.table([(j.id, f"{j.kind:<8} {j.status:<10} {j.runtime:6.1f}s  {j.description[:50]}")
                  for j in app.jobs.jobs.values()])


@COMMANDS.register("/skills", "列出可用的 skills（/name 手动调用）")
def _skills(app: App, arg: str) -> None:
    rt = app.skill_rt
    if not rt.skills:
        app.ui.info("没有 skill（<home>/skills/<name>/SKILL.md 或 .mini_cc/skills/<name>/SKILL.md）")
        return
    app.ui.table([(f"/{s.name}", f"{s.scope:<8} {'手动' if not s.model_invocable else '自动'}  "
                                 f"调用 {rt.usage.get(s.name, 0)} 次  {s.description[:50]}")
                  for s in sorted(rt.skills.values(), key=lambda s: s.name)])


@COMMANDS.register("/plan", "进入 plan 模式（先规划再动手）；/plan <需求> 进入并直接开始")
def _plan(app: App, arg: str) -> None:
    app.agent.permissions.set_mode("plan")
    app.ui.info(f"已进入 plan 模式：只读探索，计划写到 {app.plan_file}，用 ExitPlanMode 交给你审批")
    if arg:
        app.handle_line(arg)


@COMMANDS.register("/exit", "退出", aliases=("/quit",))
def _exit(app: App, arg: str) -> str:
    return EXIT


# ---------------------------------------------------------------- 入口


class LineReader:
    """管道模式下读 stdin 的线程。get() 等下一行；等待期间反复调用 on_idle（用来送达后台通知）。"""

    def __init__(self, stream) -> None:
        import queue
        import threading

        self._q: "queue.Queue[str | None]" = queue.Queue()

        def pump() -> None:
            while line := stream.readline():
                self._q.put(line)
            self._q.put(None)  # EOF

        threading.Thread(target=pump, name="stdin", daemon=True).start()

    def get(self, on_idle=None, poll: float = 0.2) -> str | None:
        import queue

        while True:
            try:
                return self._q.get(timeout=poll)
            except queue.Empty:
                if on_idle:
                    on_idle()


def repl(app: App) -> None:
    import sys

    if not sys.stdin.isatty():  # 管道输入（演示/脚本化）：不用 prompt_toolkit，逐行读并回显
        # 第 16 章：读线程把 stdin 一行行放进队列，主线程等输入时每 0.2s 看一眼有没有后台通知要送达。
        # 权限弹窗等交互问题也从同一个队列取答案（ui.line_source），不会被读线程抢走
        lines = LineReader(sys.stdin)
        app.ui.line_source = lines.get
        while True:
            line = lines.get(on_idle=app.wake_if_idle)
            if line is None:
                break
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
                for name in app.commands.all_names() + [f"/{n}" for n in app.skill_rt.skills]:
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
    # 第 16 章：等你输入时，后台任务可能结束。看门线程发现「空闲 + 有通知」就让输入框退出，主循环去唤醒模型
    import threading

    WAKE = object()
    stop = threading.Event()

    def watch() -> None:
        while not stop.wait(0.3):
            pt = session.app
            if pt.is_running and not app.busy and not app.agent.notifications.empty():
                pt.loop.call_soon_threadsafe(lambda: pt.is_running and pt.exit(result=WAKE))

    threading.Thread(target=watch, name="wake-watch", daemon=True).start()
    try:
        while True:
            try:
                line = session.prompt("❯ ", default=app.prefill)
            except (EOFError, KeyboardInterrupt):
                break
            if line is WAKE:
                app.wake_if_idle()
                continue
            app.prefill = ""
            if app.handle_line(line) == EXIT:
                break
    finally:
        stop.set()


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
    if getattr(client, "agent_clients", None):  # 离线剧本里给 sub agent 单独写了台词
        app.subagent_client = lambda d: client.agent_clients.get(d, client)
    if isinstance(client, FakeClient):
        client.vars["plan_file"] = lambda: app.plan_file  # 剧本里可以写 {plan_file}
    app.start_mcp()
    if args.resume or args.cont:
        infos = app.store.list()
        if not infos:
            app.ui.error("当前项目没有可恢复的会话")
        else:
            sid = app.store.resolve(args.resume) if args.resume else infos[0].id
            app.ui.info(f"已恢复会话 {sid[:8]}（{app.resume(sid)} 条消息）")
    try:
        if args.prompt:
            app.handle_line(args.prompt)
        else:
            repl(app)
    finally:
        app.close()
    return 0
