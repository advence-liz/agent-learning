#!/usr/bin/env node
/**
 * CLI 外壳：REPL + 斜杠命令注册表。（第 1 章起；第 4–6、8–21 章各加命令 / 接线）
 *
 * 真模型：  node mini_cc/cli.ts                       （读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）
 * 离线：    node mini_cc/cli.ts --fake examples/ch05.json   （按剧本回放，不发任何请求）
 */

import { createInterface as createLineReader } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isReminder } from "./attachments.ts";
import { AutoReviewer, keywordReviewerTurn } from "./auto_mode.ts";
import { autoCompactHook, compact } from "./compact.ts";
import { Settings } from "./config.ts";
import { getCloseMatches } from "./difflib.ts";
import { estimateVisualTokens, imageInfo } from "./images.ts";
import { JobManager } from "./jobs.ts";
import { Agent } from "./loop.ts";
import { buildUserContent, FileMentionCompleter, resolveMentions } from "./mentions.ts";
import { AnthropicClient, type Block, FakeClient, type Message, type ModelClient } from "./model.ts";
import { Approvals, McpManager, loadConfig, selectServers, ServerState } from "./mcp_client.ts";
import { MemoryStore } from "./memory.ts";
import { MODES } from "./permissions.ts";
import { EnterPlanModeTool, ExitPlanModeTool, planCheck, PlanController, planModeProvider } from "./plan_mode.ts";
import { type Change, type Checkpoint, FileHistory, isPrompt, promptText } from "./rewind.ts";
import { type Session, SessionStore } from "./session.ts";
import { SkillError, SkillRuntime, SkillTool, loadSkills } from "./skills.ts";
import { AgentTool, type AgentType, loadAgentTypes, SubagentRuntime } from "./subagent.ts";
import { TaskStore } from "./tasks.ts";
import { realResolve } from "./tools/base.ts";
import { defaultTools, ToolRegistry } from "./tools/index.ts";
import { BufferUI, ConsoleUI, type LineSource } from "./ui.ts";

export const EXIT = "exit";
export type Handler = (app: App, arg: string) => string | null | void | Promise<string | null | void>;

export interface Command {
  name: string;
  help: string;
  handler: Handler;
  aliases: string[];
}

export class CommandRegistry {
  commands = new Map<string, Command>();
  private alias = new Map<string, string>();

  /** 注册一个命令（Python 版是装饰器 @COMMANDS.register(...)）。 */
  register(name: string, help: string, handler: Handler, aliases: string[] = []): Handler {
    this.commands.set(name, { name, help, handler, aliases });
    for (const a of aliases) this.alias.set(a, name);
    return handler;
  }

  lookup(name: string): Command | undefined {
    return this.commands.get(this.alias.get(name) ?? name);
  }

  allNames(): string[] {
    return [...this.commands.keys(), ...this.alias.keys()].sort();
  }

  async dispatch(app: App, line: string): Promise<string | null> {
    const trimmed = line.trim();
    const sp = trimmed.indexOf(" ");
    const [name, arg] = sp < 0 ? [trimmed, ""] : [trimmed.slice(0, sp), trimmed.slice(sp + 1)];
    const cmd = this.lookup(name);
    const skills = app.skillRt;
    if (cmd === undefined && skills?.skills.has(name.slice(1))) { // 第 20 章：没有同名内置命令，就当 skill 展开
      await app.runSkillCommand(name.slice(1), arg.trim());
      return null;
    }
    if (cmd === undefined) {
      const close = getCloseMatches(name, this.allNames(), 1);
      const hint = close.length ? `，你是不是想输入 ${close[0]}？` : "，输入 /help 查看全部命令";
      app.ui.error(`未知命令 ${name}${hint}`);
      return null;
    }
    return (await cmd.handler(app, arg.trim())) ?? null;
  }
}

// 全局默认注册表：各章节往这里 COMMANDS.register(...) 加命令
export const COMMANDS = new CommandRegistry();

/** UI 需要提供的全部能力：BufferUI（测试）和 ConsoleUI（终端）都满足。 */
export type UI = BufferUI;

export class App {
  settings: Settings;
  client: ModelClient;
  ui: UI;
  commands: CommandRegistry;
  agent: Agent;
  reviewer: AutoReviewer;
  store: SessionStore;
  session!: Session;
  memory: MemoryStore;
  fileHistory!: FileHistory;
  prefill = ""; // 第 13 章：回退后放回输入框的原话
  mcp: McpManager;
  // 第 16 章：后台任务；busy = 正在跑一轮（空闲时才能主动唤醒模型）
  jobs: JobManager;
  busy = false;
  // 第 17 章：sub agent
  subagentTypes: Map<string, AgentType>;
  subagentClient: (description: string) => ModelClient;
  subagentMaxTurns = 30;
  // 第 20 章：skills
  skillRt: SkillRuntime;
  private recorder: ((msg: any, meta: any) => void) | null = null;
  private abort: AbortController | null = null;

  constructor(settings: Settings, client: ModelClient,
    { ui, commands = COMMANDS, reviewerClient }: { ui?: UI; commands?: CommandRegistry; reviewerClient?: ModelClient } = {}) {
    this.settings = settings;
    this.client = client;
    this.ui = ui ?? new ConsoleUI();
    this.commands = commands;
    this.agent = new Agent(client, new ToolRegistry(defaultTools()), settings);
    this.agent.approver = (req) => this.ui.askPermission(req);
    this.agent.ctx.extras.ask_user = (qs: any) => this.ui.askQuestions(qs); // 第 10 章
    this.agent.permissions.setMode(settings.permissionMode);
    this.agent.permissions.onModeChange.push((o, n) => this.recordMode(o, n));
    // 第 6 章：auto 模式的审查员。用独立的 client，和主对话的上下文完全隔离
    this.reviewer = new AutoReviewer(reviewerClient ?? client, () => this.agent.messages, settings.cwd);
    this.agent.permissions.classifier = (tool, args) => this.reviewer.review(tool, args);
    this.store = new SessionStore(settings.home, settings.cwd);
    // 第 12 章：长期记忆。索引放进 system（会话开始时求值一次），Memory 工具从 extras 拿到它
    this.memory = MemoryStore.forProject(settings.home, settings.cwd);
    this.agent.ctx.extras.memory = this.memory;
    this.agent.context.systemSections.push(() => this.memory.systemSection());
    // 第 13 章：Write/Edit 写盘前给文件拍快照；回退后把用户原话放回输入框（this.prefill）
    this.agent.ctx.writeHooks.push((path) => this.fileHistory.beforeWrite(path));
    // 第 15 章：MCP。连接在 startMcp() 里做（要先问用户批准项目级 server）；server 的说明进 system
    this.mcp = new McpManager(join(settings.home, "logs"));
    this.agent.context.systemSections.push(() => this.mcp.instructionsSection());
    // 第 14 章：每次请求模型前检查上下文是否逼近窗口
    this.agent.beforeRequest.push(autoCompactHook);
    this.attach(this.store.new());
    // 第 16 章：后台任务。输出文件放 <home>/tasks/<启动时的会话 id>/，文件会一直变，不做「外部修改」提醒
    this.jobs = new JobManager(join(settings.home, "tasks", this.session.id), (t) => this.agent.notify(t));
    this.agent.ctx.extras.jobs = this.jobs;
    this.agent.ctx.untrackedDirs.push(this.jobs.dir);
    // 第 17 章：sub agent。类型在启动时读一次（工具描述会话内不变，prompt cache 稳定）
    this.subagentTypes = loadAgentTypes(settings.cwd, settings.home);
    this.agent.tools.register(new AgentTool(() => this.subagentTypes));
    this.agent.ctx.extras.subagents = new SubagentRuntime(this);
    this.subagentClient = () => this.client; // 测试 / 离线演示可以换成单独的剧本
    // 第 20 章：skills。目录进 system（预算：窗口的 1%，按 4 字符/token 换成字符数），正文按需加载
    this.skillRt = new SkillRuntime(loadSkills(settings.cwd, settings.home), join(settings.home, "skills-usage.json"));
    this.agent.ctx.extras.skills = this.skillRt;
    this.agent.tools.register(new SkillTool());
    this.agent.context.systemSections.push(() => this.skillRt.systemSection(Math.floor(settings.contextWindow / 100) * 4));
    // 第 21 章：plan 模式 = 规则提醒（provider）+ 权限关卡（extraChecks）+ 交接工具 + 只读 sub agent
    const pm = this.agent.permissions;
    pm.extraChecks.push(planCheck(() => this.planFile));
    this.agent.context.providers.push(planModeProvider(() => this.planFile));
    this.agent.tools.register(new EnterPlanModeTool());
    this.agent.tools.register(new ExitPlanModeTool());
    this.agent.ctx.extras.plan = new PlanController(pm, () => this.planFile, (plan) => this.ui.askPlanApproval(plan));
  }

  /** 每个会话一份计划文件（Claude Code 放在 ~/.claude/plans/）。 */
  get planFile(): string {
    return join(this.settings.home, "plans", `${this.session.id}.md`);
  }

  /** 把 Agent 的「新消息」事件接到当前会话文件上（换会话时先摘掉旧的）。 */
  private attach(session: Session): void {
    const ls = this.agent.listeners;
    for (const fn of [this.recorder, this.onMessage]) if (fn && ls.includes(fn)) ls.splice(ls.indexOf(fn), 1);
    this.session = session;
    this.recorder = (msg, meta) => session.record(msg, meta);
    ls.push(this.recorder);
    ls.push(this.onMessage); // 排在落盘之后：要用它刚分配的 uuid
    this.fileHistory = FileHistory.load(join(this.settings.home, "file-history", session.id));
    // 第 11 章：任务清单跟着会话走（/new 换新清单，/resume 载入旧清单）
    this.agent.ctx.extras.tasks = TaskStore.load(session.tasksPath);
    // 换会话 = 重新算一次 system：上个会话里新存的记忆从这里开始进上下文
    this.agent.context.invalidate();
  }

  /** 第 13 章：用户亲手发的每条消息开一个检查点。 */
  private onMessage = (msg: Message, meta: Record<string, any>): void => {
    if (isPrompt(msg) && this.session.lastUuid && !meta.compact) {
      this.fileHistory.begin(this.session.lastUuid, promptText(msg));
    }
  };

  /** 回到第 n 个检查点（这条用户消息发出之前）。mode: both | conversation | code。 */
  rewind(n: number, mode: "both" | "conversation" | "code" = "both"): [Checkpoint, Change[]] {
    const cp = this.checkpoints()[n - 1];
    let changes: Change[] = [];
    if (mode === "both" || mode === "code") {
      changes = this.fileHistory.restore(cp.uuid);
      for (const [path] of changes) this.agent.ctx.fileState.forget(path);
    }
    if (mode === "both" || mode === "conversation") {
      const keep = this.session.chain.indexOf(cp.uuid);
      this.agent.loadHistory(this.agent.messages.slice(0, keep), this.agent.usage); // 原来的前缀，逐字节不变
      this.session.rewind(keep);
      this.fileHistory.truncate(cp.uuid);
      // 这条分支上模型「读过」什么已经说不清了：和 /resume 一样，从头信任磁盘
      this.agent.ctx.fileState.clear();
      this.prefill = cp.prompt;
    }
    return [cp, changes];
  }

  /** 当前分支上的检查点（压缩、回退之后不在链上的不算）。 */
  checkpoints(): Checkpoint[] {
    return this.fileHistory.checkpoints.filter((c) => this.session.chain.includes(c.uuid));
  }

  /** 读 .mcp.json → 批准 → 并行连接 → 把工具注册进 ToolRegistry。在第一次请求模型之前调用。 */
  async startMcp(): Promise<void> {
    const configs = loadConfig(this.settings.cwd, this.settings.home);
    if (!configs.size) return;
    const approvals = new Approvals(join(this.settings.home, "mcp-approvals.json"), realResolve(this.settings.cwd));
    const [start, rejected] = await selectServers(configs, approvals, (p) => this.ui.ask(p), (m) => this.ui.info(m));
    await this.mcp.start(start);
    for (const cfg of rejected) this.mcp.servers.set(cfg.name, new ServerState(cfg.name, cfg, "disabled"));
    for (const tool of this.mcp.tools()) this.agent.tools.register(tool);
    this.agent.context.invalidate(); // system 里多了 server instructions
    const states = [...this.mcp.servers.values()];
    const ok = states.filter((s) => s.status === "connected");
    const bad = states.filter((s) => s.status === "failed").map((s) => s.name);
    this.ui.info(`MCP：${ok.length}/${states.length} 个 server 已连接，${ok.reduce((n, s) => n + s.tools.length, 0)} 个工具` +
      (bad.length ? `；连接失败：${bad.join(", ")}（/mcp 查看原因）` : ""));
  }

  /** 收尾：停掉后台任务（第 16 章），关掉 MCP 连接。 */
  async close(): Promise<void> {
    await this.jobs.stopAll();
    await this.mcp.close();
  }

  /** /skill-name args：prompt 型命令。正文展开后作为这一轮的用户消息发给模型（这一条命令是花钱的）。 */
  async runSkillCommand(name: string, arg: string): Promise<void> {
    let body: string;
    try {
      body = await this.skillRt.invoke(this.skillRt.skills.get(name)!, arg, this.settings.cwd);
    } catch (e) {
      if (!(e instanceof SkillError)) throw e;
      this.ui.error(`skill ${name} 加载失败：${e.message}`);
      return;
    }
    this.ui.info(`  ⎿ 已加载 skill ${name}（${body.length} 字符）`);
    await this.run([{ type: "text", text: body },
      { type: "text", text: `<command-name>/${name}</command-name>\n<command-args>${arg}</command-args>` }]);
  }

  /** 空闲时有通知（后台命令结束、sub agent 交报告、监听到事件）：主动开一轮，把通知交给模型。 */
  async wakeIfIdle(): Promise<boolean> {
    if (this.busy || !this.agent.notifications.length) return false;
    await this.run([]); // 空内容：providers 会把通知作为 <system-reminder> 放进这条 user 消息
    return true;
  }

  /** Ctrl+C：取消当前这一轮（正在跑的 Bash 会被杀掉）。没有在跑的轮次时返回 false。 */
  interrupt(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  private async run(content: string | Block[]): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    this.agent.ctx.signal = ac.signal;
    this.busy = true;
    try {
      for await (const ev of this.agent.runTurn(content)) {
        this.ui.render(ev);
        // break 会调用生成器的 return()：runTurn 的 finally 补齐悬空的 tool_use，这里只负责告诉用户
        if (ac.signal.aborted) break;
      }
      if (ac.signal.aborted) this.ui.error("已中断（Ctrl+C），可以继续输入");
    } finally {
      this.abort = null;
      this.agent.ctx.signal = undefined;
      this.busy = false;
    }
  }

  private recordMode(_old: string, mode: string): void {
    // 和 Claude Code 一样把模式变化记进会话文件（读取时被忽略，只作审计）
    this.session.appendRecord({ type: "permission-mode", permissionMode: mode, sessionId: this.session.id });
  }

  newSession(): void {
    this.agent.reset();
    this.attach(this.store.new());
  }

  resume(sessionId: string): number {
    const [session, messages, usage] = this.store.load(sessionId);
    this.attach(session); // 先接上文件，loadHistory 里补的修复记录才会写进这个会话
    this.agent.loadHistory(messages, usage);
    return messages.length;
  }

  async handleLine(line: string): Promise<string | null> {
    line = line.trim();
    if (!line) return null;
    // 以 / 开头但第一个词里还有 /，是拖进来的绝对路径（第 19 章），不是斜杠命令
    if (line.startsWith("/") && !line.split(/\s+/)[0].slice(1).includes("/")) return this.commands.dispatch(this, line);
    // 第 8 章：@ 引用的文件作为附件放进这条 user 消息
    const attachments = resolveMentions(line, this.agent.ctx);
    for (const a of attachments) this.ui.info(`  ⎿ 已附加 ${a.title}`);
    await this.run(buildUserContent(line, attachments));
    return null;
  }
}

// ---------------------------------------------------------------- 内置命令

COMMANDS.register("/help", "显示所有命令", (app) => {
  const rows: Array<[string, string]> = [...app.commands.commands.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((c) => [c.name, c.help + (c.aliases.length ? `（别名 ${c.aliases.join(", ")}）` : "")]);
  app.ui.table(rows);
});

COMMANDS.register("/new", "开启新会话，清空对话历史", (app) => {
  app.newSession();
  app.ui.info(`已开启新会话 ${app.session.id.slice(0, 8)}（旧会话仍在磁盘上，可用 /resume 找回）`);
}, ["/clear"]);

COMMANDS.register("/status", "查看模型、消息数与 token 消耗", (app) => {
  const u = app.agent.usage;
  const pm = app.agent.permissions;
  app.ui.table([
    ["model", app.settings.model],
    ["effort", app.settings.effort],
    ["cwd", app.settings.cwd],
    ["session", app.session.id],
    ["mode", pm.mode],
    ["allow", [...pm.allowRules].sort().join(", ") || "-"],
    ["reviewer", `${app.reviewer.calls} calls`],
    ["messages", String(app.agent.messages.length)],
    ["context", `${u.lastInput} tokens（最近一次请求的输入）/ 窗口 ${app.settings.contextWindow}，` +
      `超过 ${app.settings.contextWindow - app.settings.autoCompactBuffer} 自动压缩`],
    ["total", `in ${u.inputTokens} / out ${u.outputTokens} / ${u.requests} requests`],
  ]);
});

COMMANDS.register("/model", "查看或切换模型：/model claude-sonnet-5-5", (app, arg) => {
  if (arg) {
    app.settings.model = arg;
    app.client.model = arg;
  }
  app.ui.info(`当前模型：${app.settings.model}`);
});

const pad2 = (n: number) => String(n).padStart(2, "0");

COMMANDS.register("/resume", "列出本项目的历史会话；/resume <序号|id 前缀> 恢复", (app, arg) => {
  if (!arg) {
    const infos = app.store.list().filter((i) => i.id !== app.session.id);
    if (!infos.length) {
      app.ui.info("当前项目还没有历史会话");
      return;
    }
    app.ui.table(infos.map((i, n) => {
      const d = i.updated;
      const when = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      return [`${n + 1}. ${i.id.slice(0, 8)}`, `${when}  ${String(i.messages).padStart(3)} msgs  ${i.title}`];
    }));
    app.ui.info("输入 /resume <序号> 恢复");
    return;
  }
  let sid: string;
  try {
    sid = app.store.resolve(arg);
  } catch (e) {
    app.ui.error((e as Error).message);
    return;
  }
  const n = app.resume(sid);
  app.ui.info(`已恢复会话 ${sid.slice(0, 8)}（${n} 条消息），继续聊吧`);
});

COMMANDS.register("/mode", "查看或切换权限模式：/mode acceptEdits（REPL 里也可按 Shift+Tab 循环切换）", (app, arg) => {
  const pm = app.agent.permissions;
  if (arg) {
    try {
      pm.setMode(arg);
    } catch (e) {
      app.ui.error((e as Error).message);
      return;
    }
  }
  app.ui.info(`权限模式：${pm.mode}（循环顺序：${pm.cycle.join(" → ")}）`);
});

COMMANDS.register("/context", "查看上下文里都放了什么（system 段落、注入的提醒、历史）", (app) => {
  const rows: Array<[string, string]> = [];
  app.agent.context.systemBlocks().forEach((b, i) => {
    const first = b.text.split("\n")[0].slice(0, 40);
    rows.push([`system[${i}]`, `${String(b.text.length).padStart(6)} chars  ${first}`]);
  });
  let nRem = 0, nRemChars = 0, nMsgChars = 0, nImg = 0, imgTokens = 0;
  const imagesIn = (b: Block): Block[] => {
    if (b.type === "image") return [b];
    if (b.type === "tool_result" && Array.isArray(b.content)) return b.content.filter((c: Block) => c.type === "image");
    return [];
  };
  for (const m of app.agent.messages) {
    const blocks: Block[] = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    for (let b of blocks) {
      for (const img of imagesIn(b)) { // 第 19 章：图片按 visual token 估算，不按 base64 字符数
        nImg++;
        const info = imageInfo(Buffer.from(img.source?.data ?? "", "base64"));
        imgTokens += info ? estimateVisualTokens(info[1], info[2]) : 0;
      }
      if (b.type === "image") continue;
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        b = { ...b, content: b.content.filter((c: Block) => c.type !== "image") };
      }
      const size = JSON.stringify(b).length;
      if (isReminder(b)) {
        nRem++;
        nRemChars += size;
      } else {
        nMsgChars += size;
      }
    }
  }
  rows.push(["reminders", `${String(nRemChars).padStart(6)} chars  ${nRem} 个 <system-reminder> 块`]);
  rows.push(["messages", `${String(nMsgChars).padStart(6)} chars  ${app.agent.messages.length} 条消息（不含提醒）`]);
  if (nImg) rows.push(["images", `${String(imgTokens).padStart(6)} tokens（估算）  ${nImg} 张图片`]);
  rows.push(["last request", `${String(app.agent.usage.lastInput).padStart(6)} tokens`]);
  app.ui.table(rows);
});

COMMANDS.register("/todos", "查看当前会话的任务清单", (app) => {
  app.ui.info((app.agent.ctx.extras.tasks as TaskStore).render());
});

COMMANDS.register("/memory", "查看长期记忆索引；/memory rm <slug> 删除一条", (app, arg) => {
  const store = app.memory;
  if (arg.startsWith("rm ")) {
    const slug = arg.slice(3).trim();
    app.ui.info(store.delete(slug) ? `已删除 ${slug}` : `没有 ${slug}`);
    return;
  }
  const entries = store.entries();
  app.ui.info(`记忆目录：${store.dir}（${entries.length} 条，下个会话开始时进上下文）`);
  if (entries.length) app.ui.table(entries.map((e) => [e.slug, `${e.name} — ${e.description}`]));
});

COMMANDS.register("/rewind", "回退对话和/或代码：/rewind 列出检查点；/rewind <n> [both|conversation|code]", (app, arg) => {
  const cps = app.checkpoints();
  if (!cps.length) {
    app.ui.info("还没有可回退的检查点（每条你发出的消息是一个检查点）");
    return;
  }
  if (!arg) {
    cps.forEach((c, i) => {
      const n = Object.keys(c.files).length;
      app.ui.info(`${i + 1}. ${c.prompt ? c.prompt.split("\n")[0].slice(0, 40) : "(空)"}  ` +
        `（${n ? `改了 ${n} 个文件` : "未改文件"}）`);
    });
    app.ui.info("输入 /rewind <序号> [both|conversation|code] 回到那条消息发出之前（默认 both）");
    return;
  }
  const sp = arg.indexOf(" ");
  const num = sp < 0 ? arg : arg.slice(0, sp);
  const mode = (sp < 0 ? "" : arg.slice(sp + 1).trim()) || "both";
  if (mode !== "both" && mode !== "conversation" && mode !== "code") {
    app.ui.error("模式只能是 both / conversation / code");
    return;
  }
  if (!/^\d+$/.test(num) || Number(num) < 1 || Number(num) > cps.length) {
    app.ui.error(`没有第 ${num} 个检查点（共 ${cps.length} 个）`);
    return;
  }
  const [cp, changes] = app.rewind(Number(num), mode);
  for (const [path, action] of changes) {
    app.ui.info(`  ⎿ ${action === "restored" ? "恢复" : "删除（这之后才新建的）"} ${app.agent.ctx.rel(path)}`);
  }
  if (mode !== "conversation" && !changes.length) app.ui.info("  ⎿ 没有可恢复的文件改动（Bash 改的文件不在检查点里）");
  if (mode !== "code") {
    app.ui.info(`已回到第 ${num} 个检查点之前，对话剩 ${app.agent.messages.length} 条消息`);
    app.ui.info(`原话：${cp.prompt}（已放回输入框，可以改一改再发）`);
  } else {
    app.ui.info("代码已恢复，对话保持不变");
  }
}, ["/checkpoint", "/undo"]);

COMMANDS.register("/compact", "把当前对话压缩成摘要；/compact <要重点保留什么> 可以引导摘要", async (app, arg) => {
  if (!app.agent.messages.length) {
    app.ui.info("当前没有对话可以压缩");
    return;
  }
  for await (const ev of compact(app.agent, "manual", arg)) app.ui.render(ev);
});

COMMANDS.register("/mcp", "查看 MCP server 的连接状态和工具", (app, arg) => {
  if (!app.mcp.servers.size) {
    app.ui.info("没有配置 MCP server（项目 .mcp.json 或 ~/.mini_cc/mcp.json）");
    return;
  }
  const rows: Array<[string, string]> = [];
  for (const st of app.mcp.servers.values()) {
    const detail = st.status === "connected" ? `${st.tools.length} tools` : st.error || "-";
    rows.push([st.name, `${st.status.padEnd(10)} ${st.config.scope.padEnd(8)} ${detail}`]);
    if (arg === "-v" && st.status === "connected") {
      for (const t of st.tools) rows.push(["", `  mcp__${st.name}__${t.name}${t.annotations?.readOnlyHint ? "  (read-only)" : ""}`]);
    }
  }
  app.ui.table(rows);
});

COMMANDS.register("/tasks", "查看后台任务；/tasks stop <id> 停止", async (app, arg) => {
  if (arg.startsWith("stop ")) {
    const id = arg.slice(5).trim();
    const job = await app.jobs.stop(id);
    app.ui.info(job ? `已停止 ${job.id}` : `没有任务 ${id}`);
    return;
  }
  if (!app.jobs.jobs.size) {
    app.ui.info("没有后台任务");
    return;
  }
  app.ui.table([...app.jobs.jobs.values()].map((j) =>
    [j.id, `${j.kind.padEnd(8)} ${j.status.padEnd(10)} ${j.runtime.toFixed(1).padStart(6)}s  ${j.description.slice(0, 50)}`]));
}, ["/bashes"]);

COMMANDS.register("/skills", "列出可用的 skills（/name 手动调用）", (app) => {
  const rt = app.skillRt;
  if (!rt.skills.size) {
    app.ui.info("没有 skill（<home>/skills/<name>/SKILL.md 或 .mini_cc/skills/<name>/SKILL.md）");
    return;
  }
  app.ui.table([...rt.skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((s) =>
    [`/${s.name}`, `${s.scope.padEnd(8)} ${!s.modelInvocable ? "手动" : "自动"}  ` +
      `调用 ${rt.usage[s.name] ?? 0} 次  ${s.description.slice(0, 50)}`]));
});

COMMANDS.register("/plan", "进入 plan 模式（先规划再动手）；/plan <需求> 进入并直接开始", async (app, arg) => {
  app.agent.permissions.setMode("plan");
  app.ui.info(`已进入 plan 模式：只读探索，计划写到 ${app.planFile}，用 ExitPlanMode 交给你审批`);
  if (arg) await app.handleLine(arg);
});

COMMANDS.register("/exit", "退出", () => EXIT, ["/quit"]);

// ---------------------------------------------------------------- 入口

/**
 * 管道模式下读 stdin：get() 等下一行，EOF 时返回 null。REPL 和交互问题（权限弹窗等）共用这一个队列。
 * 第 16 章：get(onIdle) 等待期间每 poll 秒调用一次 onIdle（用来送达后台通知）。
 */
export class LineReader {
  private buffered: Array<string | null> = [];
  private waiting: Array<(line: string | null) => void> = [];
  private wakers: Array<() => void> = []; // get(onIdle) 在等：有新行进缓冲区时叫醒它

  constructor(input: NodeJS.ReadableStream) {
    const rl = createLineReader({ input, terminal: false });
    const put = (line: string | null) => {
      const w = this.waiting.shift();
      if (w) return w(line);
      this.buffered.push(line);
      for (const wake of this.wakers.splice(0)) wake();
    };
    rl.on("line", put);
    rl.on("close", () => put(null)); // EOF
  }

  private next(): Promise<string | null> {
    if (this.buffered.length) {
      const line = this.buffered.shift()!;
      if (line === null) this.buffered.unshift(null); // EOF 之后一直是 EOF
      return Promise.resolve(line);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async get(onIdle?: () => unknown, poll = 0.2): Promise<string | null> {
    if (!onIdle) return this.next();
    for (;;) {
      if (this.buffered.length) return this.next();
      let timer: NodeJS.Timeout | undefined;
      const arrived = await new Promise<boolean>((resolve) => {
        this.wakers.push(() => resolve(true));
        timer = setTimeout(() => resolve(false), poll * 1000);
      });
      clearTimeout(timer);
      if (!arrived) {
        this.wakers.length = 0;
        await onIdle();
      }
    }
  }
}

/** 启动时、进入 REPL 之前要做的事（连 MCP、恢复会话）。它可能要问用户，所以在输入源接好之后才调用。 */
type Setup = () => Promise<void>;

/** 管道输入（演示/脚本化）：逐行读并回显，交互问题的答案也从同一个队列取。 */
async function pipeRepl(app: App, lines: LineReader, setup: Setup, once?: string): Promise<void> {
  const ui = app.ui as ConsoleUI;
  ui.lineSource = async (prompt) => {
    process.stdout.write(prompt);
    const line = await lines.get();
    process.stdout.write(`${line ?? ""}\n`); // 把读到的答案回显出来，记录才看得懂
    return line;
  };
  await setup();
  if (once !== undefined) {
    await app.handleLine(once);
    return;
  }
  for (;;) {
    // 第 16 章：等输入时每 0.2s 看一眼有没有后台通知要送达（权限弹窗等交互问题也从同一个队列取答案）
    const line = await lines.get(() => app.wakeIfIdle());
    if (line === null) break;
    app.ui.info(`❯ ${line.trimEnd()}`);
    if ((await app.handleLine(line)) === EXIT) break;
  }
}

/** readline 内部处理按键的方法（Symbol(_ttyWrite)）。拿到它才能在 Tab 补全之前截下 Shift+Tab。 */
function ttyWriteSymbol(rl: Interface): symbol | undefined {
  for (let p = Object.getPrototypeOf(rl); p; p = Object.getPrototypeOf(p)) {
    const s = Object.getOwnPropertySymbols(p).find((x) => x.description === "_ttyWrite");
    if (s) return s;
  }
  return undefined;
}

/** 终端模式：node:readline（Python 版用 prompt_toolkit）。Tab 补全命令和 @ 文件，Shift+Tab 切换权限模式。 */
async function ttyRepl(app: App, setup: Setup, once?: string): Promise<void> {
  const files = new FileMentionCompleter(app.settings.cwd);
  const completer = (line: string): [string[], string] => {
    if (line.startsWith("/") && !line.includes(" ")) { // 只在行首补全斜杠命令（第 20 章起包括 skill）
      const names = [...app.commands.allNames(), ...[...app.skillRt.skills.keys()].map((n) => `/${n}`)];
      return [names.filter((n) => n.startsWith(line)), line];
    }
    const word = line.split(" ").at(-1)!;
    return [files.getCompletions(line).map((c) => c.text), word];
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout, completer, terminal: true });
  const ui = app.ui as ConsoleUI;
  ui.lineSource = (prompt) => rl.question(prompt);
  const promptLabel = () => (app.agent.permissions.mode === "default" ? "❯ " : `[${app.agent.permissions.mode}] ❯ `);
  // Shift+Tab：循环切换权限模式，和 Claude Code 一样。readline 默认把它当 Tab 去补全，所以在它之前截下来。
  // （没有 prompt_toolkit 的底部状态栏，模式显示在提示符前面）
  const sym = ttyWriteSymbol(rl);
  if (sym) {
    const orig = (rl as any)[sym];
    (rl as any)[sym] = function (s: string, key: { name?: string; shift?: boolean }) {
      if (key?.name === "tab" && key.shift) {
        app.agent.permissions.nextMode();
        rl.setPrompt(promptLabel());
        rl.prompt(true);
        return;
      }
      return orig.call(this, s, key);
    };
  }
  // Ctrl+C：有一轮在跑就取消它；空闲时退出（同 Python 版在输入框里按 Ctrl+C）
  let closed = false;
  rl.on("SIGINT", () => {
    if (!app.interrupt()) rl.close();
  });
  rl.on("close", () => (closed = true));
  let watch: NodeJS.Timeout | undefined;
  try {
    await setup();
    if (once !== undefined) {
      await app.handleLine(once);
      return;
    }
    app.ui.info(`mini-cc · ${app.settings.model} · ${app.settings.cwd}（/help 查看命令）`);
    // 第 16 章：等你输入时，后台任务可能结束。定时检查「空闲 + 有通知」就取消输入框，主循环去唤醒模型
    let waiting: AbortController | null = null; // 只有主输入框可以被取消；轮次里的交互问题不受影响
    watch = setInterval(() => {
      if (waiting && !app.busy && app.agent.notifications.length) waiting.abort();
    }, 300);
    while (!closed) {
      let line: string;
      const ac = new AbortController();
      try {
        waiting = ac;
        const q = rl.question(promptLabel(), { signal: ac.signal });
        // 第 13 章：/rewind 之后把原话放回输入框（readline 没有 default 参数，往输入行里写一遍等价）
        if (app.prefill) rl.write(app.prefill);
        app.prefill = "";
        line = await q;
      } catch {
        if (ac.signal.aborted && !closed) {
          process.stdout.write("\n");
          await app.wakeIfIdle();
          continue;
        }
        break; // Ctrl+D / Ctrl+C 关掉了输入
      } finally {
        waiting = null;
      }
      if ((await app.handleLine(line)) === EXIT) break;
    }
  } finally {
    clearInterval(watch);
    rl.close();
  }
}

const USAGE = `usage: mini_cc [-h] [--model MODEL] [-p PROMPT] [--fake SCRIPT.json]
               [--permission-mode {${MODES.join(",")}}] [-r ID] [-c]

options:
  -h, --help            show this help message and exit
  --model MODEL
  -p, --print PROMPT    非交互：跑一轮就退出
  --fake SCRIPT.json    离线 fake 模型：按脚本回放，不发任何 API 请求
  --permission-mode {${MODES.join(",")}}
  -r, --resume ID       恢复指定会话（序号或 id 前缀）
  -c, --continue        恢复本项目最近一次会话
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        model: { type: "string" },
        print: { type: "string", short: "p" }, // 非交互：跑一轮就退出
        fake: { type: "string" }, // 离线 fake 模型：按脚本回放，不发任何 API 请求
        "permission-mode": { type: "string" },
        resume: { type: "string", short: "r" }, // 恢复指定会话（序号或 id 前缀）
        continue: { type: "boolean", short: "c" }, // 恢复本项目最近一次会话
      },
    });
  } catch (e) {
    process.stderr.write(`${USAGE.split("\n\n")[0]}\nmini_cc: error: ${(e as Error).message}\n`);
    return 2;
  }
  const args = parsed.values;
  if (args.help) {
    process.stdout.write(USAGE); // 同 Python 版 argparse 的 --help
    return 0;
  }
  const settings = new Settings();
  if (args.model) settings.model = args.model;
  if (args["permission-mode"]) {
    if (!MODES.includes(args["permission-mode"])) {
      process.stderr.write(`mini_cc: error: --permission-mode must be one of ${MODES.join(", ")}\n`);
      return 2;
    }
    settings.permissionMode = args["permission-mode"];
  }
  let client: ModelClient, reviewer: ModelClient;
  if (args.fake) {
    client = FakeClient.fromJson(args.fake);
    reviewer = new FakeClient([], { responder: keywordReviewerTurn }); // 离线的关键词审查员
  } else {
    client = new AnthropicClient(settings.model, { fallbacks: settings.fallbacks });
    reviewer = new AnthropicClient(settings.model, { fallbacks: settings.fallbacks });
  }
  const app = new App(settings, client, { reviewerClient: reviewer });
  if (client instanceof FakeClient) {
    const agents = client.agentClients;
    if (Object.keys(agents).length) app.subagentClient = (d) => agents[d] ?? client; // 离线剧本里给 sub agent 单独写了台词
    client.vars.plan_file = () => app.planFile; // 剧本里可以写 {plan_file}
  }
  const setup = async () => {
    await app.startMcp(); // 第 15 章
    if (args.resume || args.continue) {
      const infos = app.store.list();
      if (!infos.length) app.ui.error("当前项目没有可恢复的会话");
      else {
        const sid = args.resume ? app.store.resolve(args.resume) : infos[0].id;
        app.ui.info(`已恢复会话 ${sid.slice(0, 8)}（${app.resume(sid)} 条消息）`);
      }
    }
  };
  try {
    if (process.stdin.isTTY) await ttyRepl(app, setup, args.print);
    else {
      await pipeRepl(app, new LineReader(process.stdin), setup, args.print);
      process.stdin.destroy(); // 提前 /exit 时管道里可能还有没读完的输入，不必等它
    }
  } finally {
    await app.close();
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
