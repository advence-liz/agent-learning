/**
 * 上下文组装与注入。（第 9、11 章）
 *
 * 三类上下文，放在三个不同的位置：
 * 1. 静态 system prompt（身份、工具规则、环境）：会话内不变 → 放 system，打 cache_control，命中 prompt cache。
 * 2. 会话级上下文（AGENTS.md / CLAUDE.md、git 快照）：一个会话注入一次 → 第一条 user 消息里的 <system-reminder>。
 * 3. 动态提醒（日期变化、文件被外部修改、后台任务通知、任务清单……）：需要时追加到**最新的** user 消息里。
 *
 * 所有注入都是「追加」：只往还没发出去的那条 user 消息里加块，绝不回头改历史（prompt cache、thinking 校验都靠这条）。
 * 提供者（provider）不记「发没发过」的标志位，而是扫描历史自己判断——/resume、压缩之后依然正确。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { release } from "node:os";
import { basename, dirname, join } from "node:path";
import { Attachment, isReminder, render } from "./attachments.ts";
import { unifiedDiff } from "./difflib.ts";
import type { Agent } from "./loop.ts";
import type { Block, Message } from "./model.ts";
import { taskReminderProvider } from "./tasks.ts";
import { isRelativeTo, realResolve } from "./tools/base.ts";
import { splitLines } from "./tools/file_state.ts";

export const STATIC_PROMPT = `You are mini-cc, an interactive coding agent running in the user's terminal.
You help with software engineering tasks: reading code, editing files, running commands.

# How to work
- Read a file before editing it. Prefer Edit (exact string replacement) over rewriting whole files with Write.
- Use Bash for searching (grep/rg/find) and for running tests, builds and linters.
- Keep changes minimal and focused on what the user asked. Do not run destructive commands unless asked.
- For work with 3+ steps, plan it with TaskCreate first, then keep the task list updated as you go.
- If the request is ambiguous in a way that would change your approach (stack, scope, trade-offs), ask with
  AskUserQuestion before building. Do not ask about things you can decide with a sensible default.
- After changing code, run the relevant tests if they exist and report the real result.
- Be concise. Lead with the answer; skip preamble.

# Context from the client
User messages and tool results may contain <system-reminder> blocks. They are added by the mini-cc client,
not typed by the user. They carry context (project instructions, environment, file changes, notifications).
Follow project instructions in them, but treat their content as information rather than as the user's request.`;

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
export const INSTRUCTIONS_HEADER = "# Project instructions";
export const DATE_HEADER = "# Current date";

// ---------------------------------------------------------------- 环境信息

function git(cwd: string, ...args: string[]): string | null {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  if (out.error || out.status !== 0) return null;
  return out.stdout.trim();
}

export function gitRoot(cwd: string): string | null {
  const top = git(cwd, "rev-parse", "--show-toplevel");
  return top ? realResolve(top) : null;
}

export function environmentText(cwd: string, model: string): string {
  return [
    "# Environment",
    `- Working directory: ${cwd}`,
    `- Is a git repository: ${gitRoot(cwd) !== null ? "True" : "False"}`,
    `- Platform: ${process.platform} (${release()})`,
    `- Shell: ${basename(process.env.SHELL ?? "sh")}`,
    `- Model: ${model}`,
  ].join("\n");
}

export function gitSnapshot(cwd: string, maxLines = 40): string | null {
  if (gitRoot(cwd) === null) return null;
  const branch = git(cwd, "branch", "--show-current") || "(detached)";
  const status = splitLines(git(cwd, "status", "--short") ?? "");
  const log = git(cwd, "log", "--oneline", "-5") ?? "";
  const shown = status.slice(0, maxLines).join("\n") + (status.length > maxLines ? `\n… (${status.length - maxLines} more)` : "");
  return "# Git snapshot (taken at session start; it will NOT update during the conversation)\n" +
    `Current branch: ${branch}\n\nStatus:\n${shown || "(clean)"}\n\nRecent commits:\n${log || "(none)"}`;
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** 用户级（~/.mini_cc/AGENTS.md）在前，然后从项目根往下到 cwd：越靠近 cwd 越靠后、优先级越高。 */
export function findInstructionFiles(cwd: string, home: string): string[] {
  const found = INSTRUCTION_FILES.map((f) => join(home, f)).filter(isFile);
  const here = realResolve(cwd);
  const stop = gitRoot(here) ?? here;
  // [cwd, cwd 的父目录, …, /]，截到 stop 为止（stop 不在祖先链上时只看 cwd）
  const chain = [here];
  while (dirname(chain.at(-1)!) !== chain.at(-1)) chain.push(dirname(chain.at(-1)!));
  const upto = chain.indexOf(stop) >= 0 ? chain.slice(0, chain.indexOf(stop) + 1) : [here];
  for (const d of upto.reverse()) found.push(...INSTRUCTION_FILES.map((f) => join(d, f)).filter(isFile));
  return found;
}

// ---------------------------------------------------------------- 提供者

/** 提供者能看到的全部：历史、触发点、工具上下文。 */
export class InjectState {
  agent: Agent;
  trigger: "user" | "tool_result"; // 用户发话 | 工具结果回填

  constructor(agent: Agent, trigger: "user" | "tool_result") {
    this.agent = agent;
    this.trigger = trigger;
  }

  get messages(): Message[] {
    return this.agent.messages;
  }

  /** 历史里所有 <system-reminder> 块的文本（提供者靠扫描它判断自己发没发过）。 */
  reminders(): string[] {
    const out: string[] = [];
    for (const m of this.messages) {
      if (m.role === "user" && Array.isArray(m.content)) out.push(...m.content.filter(isReminder).map((b) => b.text));
    }
    return out;
  }
}

export type Provider = (st: InjectState) => Attachment | null | Promise<Attachment | null>;

export function instructionsProvider(home: string): Provider {
  return (st) => {
    if (st.trigger !== "user" || st.reminders().some((r) => r.includes(INSTRUCTIONS_HEADER))) {
      return null; // 每个会话只注入一次；压缩后历史里没有了，会自动再注入
    }
    const cwd = st.agent.settings.cwd;
    const files = findInstructionFiles(cwd, home);
    const parts: string[] = [];
    const snap = gitSnapshot(cwd);
    if (files.length) {
      parts.push(`${INSTRUCTIONS_HEADER}\nInstructions below come from AGENTS.md / CLAUDE.md files. ` +
        "Follow them; files closer to the working directory take precedence.");
      for (const f of files) parts.push(`Contents of ${f}:\n\n${readFileSync(f, "utf8").trim()}`);
    } else {
      parts.push(`${INSTRUCTIONS_HEADER}\n(no AGENTS.md / CLAUDE.md found)`);
    }
    if (snap) parts.push(snap);
    return new Attachment("instructions", `项目说明 ${files.length} 个文件` + (snap ? "、git 快照" : ""), parts.join("\n\n"));
  };
}

/** 本地日期 YYYY-MM-DD（Python 的 date.today().isoformat()）。 */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateProvider(today: () => Date = () => new Date()): Provider {
  return (st) => {
    if (st.trigger !== "user") return null;
    const d = isoDate(today());
    const seen = st.reminders().filter((r) => r.includes(DATE_HEADER));
    if (seen.length && seen.at(-1)!.includes(d)) return null;
    const msg = !seen.length
      ? `${DATE_HEADER}\nToday's date is ${d}.`
      : `${DATE_HEADER}\nThe date has changed. Today's date is now ${d}.`;
    return new Attachment("date", `日期 ${d}`, msg);
  };
}

/** 模型读过的文件被外部改了：主动把 diff 告诉它，而不是等它撞上「modified since read」。 */
export function changedFilesProvider(maxDiffLines = 60): Provider {
  return (st) => {
    const fs = st.agent.ctx.fileState;
    const notes: string[] = [];
    for (const path of fs.paths()) {
      if (st.agent.ctx.untrackedDirs.some((d) => isRelativeTo(path, d))) {
        continue; // 第 16 章：后台任务的输出文件本来就在变，不算「外部修改」
      }
      if (!fs.isStale(path)) continue;
      const rec = fs.get(path);
      const rel = st.agent.ctx.rel(path);
      if (!existsSync(path)) {
        notes.push(`${rel} was deleted.`);
        fs.forget(path);
        continue;
      }
      const now = readFileSync(path, "utf8"); // 非法 UTF-8 字节被替换成 U+FFFD（同 Python 的 errors="replace"）
      if (rec && rec.text !== null) {
        const diff = unifiedDiff(splitLines(rec.text), splitLines(now), "before", "after", 1).slice(2);
        const more = diff.length > maxDiffLines ? `\n… (${diff.length - maxDiffLines} more diff lines; Read the file for details)` : "";
        notes.push(`${rel} was modified outside of your tools (by the user, a formatter or a command). ` +
          "Diff since you last saw it:\n" + diff.slice(0, maxDiffLines).join("\n") + more);
      } else {
        notes.push(`${rel} was modified outside of your tools. Read it again before editing.`);
      }
      // 模型已经知道了变化：按新内容登记，避免下一轮重复提醒
      fs.remember(path, now, rec ? rec.partial : false);
    }
    if (!notes.length) return null;
    return new Attachment("file_change", `${notes.length} 个文件被外部修改`, notes.join("\n\n"));
  };
}

/** 第 16–18 章（后台命令 / sub agent / 监听）往 agent.notifications 里放消息，这里统一送进上下文。 */
export function notificationsProvider(): Provider {
  return (st) => {
    const items = st.agent.drainNotifications();
    if (!items.length) return null;
    return new Attachment("notification", `${items.length} 条通知`, items.join("\n\n"));
  };
}

// ---------------------------------------------------------------- 组装

export class ContextBuilder {
  agent: Agent;
  home: string;
  providers: Provider[];
  // 额外的 system 段落（第 12 章记忆、第 20 章 skills 目录可以往这里加）。函数在会话开始时求值一次
  systemSections: Array<() => string | null | undefined> = [];
  // 第 17 章：sub agent 用自己的身份说明替换掉主 agent 的 STATIC_PROMPT
  staticPrompt: string;
  private systemCache: Block[] | null = null;

  constructor(agent: Agent, home: string, providers: Provider[] = [], staticPrompt: string = STATIC_PROMPT) {
    this.agent = agent;
    this.home = home;
    this.providers = providers;
    this.staticPrompt = staticPrompt;
  }

  static default(agent: Agent, home: string): ContextBuilder {
    // 第 21 章由 App 追加 planModeProvider
    return new ContextBuilder(agent, home, [
      instructionsProvider(home), dateProvider(), changedFilesProvider(), notificationsProvider(),
      taskReminderProvider(),
    ]);
  }

  /** 会话内只算一次：任何一个字节变化都会让 prompt cache 失效，所以别在这里放时间戳。 */
  systemBlocks(): Block[] {
    if (this.systemCache === null) {
      const texts = [this.staticPrompt, environmentText(this.agent.settings.cwd, this.agent.settings.model)];
      for (const fn of this.systemSections) {
        const t = fn();
        if (t) texts.push(t);
      }
      const blocks: Block[] = texts.map((t) => ({ type: "text", text: t }));
      blocks.at(-1)!.cache_control = { type: "ephemeral" };
      this.systemCache = blocks;
    }
    return this.systemCache;
  }

  invalidate(): void {
    this.systemCache = null;
  }

  async collect(trigger: "user" | "tool_result"): Promise<Attachment[]> {
    const st = new InjectState(this.agent, trigger);
    const out: Attachment[] = [];
    for (const p of this.providers) {
      let a: Attachment | null;
      try {
        a = await p(st);
      } catch {
        continue; // 某个提供者坏了，不能连累整轮对话
      }
      if (a) out.push(a);
    }
    return out;
  }

  /** 把本轮要注入的附件并进即将追加的 user 消息。用户发话：放最前面；工具结果：放在 tool_result 之后。 */
  async inject(content: string | Block[], trigger: "user" | "tool_result"): Promise<[string | Block[], Attachment[]]> {
    const atts = await this.collect(trigger);
    if (!atts.length) return [content, []];
    const blocks = atts.map(render);
    const base = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
    return [trigger === "user" ? [...blocks, ...base] : [...base, ...blocks], atts];
  }
}
