/**
 * Sub Agent（第 17 章）：在一次工具调用的内部，用一个全新的 messages 数组再跑一遍 agent 循环。
 *
 * - 隔离：子 agent 只看到「委派 prompt」，看不到父历史；父 agent 只拿回最终结论（外加一行统计）。
 * - 能力：每种 agent 类型 = system 说明 + 工具子集 + 权限约束。内置 Explore（只读）和 general-purpose，
 *   也可以在 <项目>/.mini_cc/agents/*.md 或 <home>/agents/*.md 里自定义（frontmatter: name / description / tools）。
 * - 前台：跑完才返回，结论作为 tool_result；进度通过 progress 回调实时给人看（不进任何上下文）。
 * - 后台：交给第 16 章的 JobManager（startThread），结束时 <task-notification> 里带上 <result>。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Settings } from "./config.ts";
import { ContextBuilder, dateProvider, instructionsProvider } from "./context.ts";
import type { TurnEnd } from "./events.ts";
import { Agent, type Approver } from "./loop.ts";
import type { Message, ModelClient } from "./model.ts";
import { Decision, PermissionManager } from "./permissions.ts";
import { type Args, Tool, ToolContext, ToolResult } from "./tools/base.ts";
import { ToolRegistry } from "./tools/registry.ts";

// 子 agent 不能用的工具：再派 agent（防止无限递归）、问用户（它没有用户）、父会话自己的状态
export const NEVER_FOR_CHILDREN = new Set(["Agent", "AskUserQuestion", "TaskCreate", "TaskUpdate", "TaskList", "Memory",
  "TaskStop", "Monitor", "Skill", "ExitPlanMode", "EnterPlanMode"]);

export const BASE_PROMPT = `You are a sub agent of mini-cc, started by the main agent to do one self-contained task.
You cannot see the main conversation: everything you know about the task is in the first user message.
Work autonomously with your tools; do not ask questions (nobody will answer). When you are done, reply with
a concise final report for the main agent: findings first, with file paths and line numbers where relevant.
Your final message is the ONLY thing the main agent will see, so include everything it needs and nothing it
does not (no raw file dumps).`;

const EXPLORE_PROMPT = `You are an Explore agent: a fast, read-only code search specialist.
You MUST NOT change anything: no writing or editing files, no commands that modify state. Use Read and
read-only Bash commands (grep, find, ls, git log/show/diff, cat). Search broadly first, then read only what you need.`;

const PLAN_PROMPT = `You are a Plan agent: a read-only software architect. Explore the code that the task touches, then
return a concrete implementation plan: the approach and why, the files to change and what changes in each, risks
and open questions, and how to verify the result. Do not modify anything.`;

const GENERAL_PROMPT = `You are a general-purpose agent: research complex questions, search code and carry out multi-step
tasks, including editing files and running commands when the task asks for it.`;

export class AgentType {
  name: string;
  description: string;
  prompt: string;
  tools: string[] | null; // null = 父 agent 的全部工具（减去 NEVER_FOR_CHILDREN）
  readOnly: boolean;
  loadInstructions: boolean; // 要不要注入 AGENTS.md / CLAUDE.md（Claude Code 的 Explore 不注入）
  effort: string;

  constructor(name: string, description: string, prompt: string, tools: string[] | null = null,
    { readOnly = false, loadInstructions = true, effort = "medium" } = {}) {
    this.name = name;
    this.description = description;
    this.prompt = prompt;
    this.tools = tools;
    this.readOnly = readOnly;
    this.loadInstructions = loadInstructions;
    this.effort = effort;
  }
}

export const BUILTIN = [
  new AgentType("general-purpose", "Research, search code and execute multi-step tasks; can edit files.", GENERAL_PROMPT),
  new AgentType("Plan", "Read-only software architect: designs an implementation approach and returns a step-by-step " +
    "plan with the files to change. Use it in plan mode for non-trivial designs.",
  PLAN_PROMPT, ["Read", "Bash"], { readOnly: true, loadInstructions: false }),
  new AgentType("Explore", "Read-only, fast codebase search: find files, symbols and answer questions about the code.",
    EXPLORE_PROMPT, ["Read", "Bash"], { readOnly: true, loadInstructions: false, effort: "low" }),
];

function frontmatter(text: string): [Record<string, string>, string] {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return [{}, text];
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i >= 0 && line.slice(i + 1)) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return [meta, m[2]];
}

/** 内置 → 用户级 <home>/agents → 项目级 <cwd>/.mini_cc/agents，后面的同名覆盖前面的。 */
export function loadAgentTypes(cwd: string, home: string): Map<string, AgentType> {
  const types = new Map(BUILTIN.map((t) => [t.name, t]));
  for (const d of [join(home, "agents"), join(cwd, ".mini_cc", "agents")]) {
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d).filter((n) => n.endsWith(".md")).sort()) {
      const [meta, body] = frontmatter(readFileSync(join(d, f), "utf8"));
      const name = meta.name || basename(f, ".md");
      const tools = meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : null;
      types.set(name, new AgentType(name, meta.description ?? "", body.trim(), tools));
    }
  }
  return types;
}

/** 只读 agent 的硬约束：排在 bypass 之前（extraChecks），父亲是什么模式都不能写。 */
function readOnlyCheck(tool: Tool, args: Args): Decision | null {
  if (tool.readOnly || tool.selfCheck(args) === "allow") return null;
  return new Decision("deny", "this agent is read-only; it must not modify files or run state-changing commands", "check");
}

// ---------------------------------------------------------------- 跑一个子 agent

export interface SubagentRun {
  text: string;
  toolUses: number;
  requests: number;
  partial: boolean;
  messages: Message[];
}

export interface RunOptions {
  agentId: string;
  approver: Approver | null;
  progress: ((s: string) => void) | null;
  transcript: string | null;
  maxTurns: number;
  signal?: AbortSignal; // Node 版多出的一项：前台子 agent 跟着父亲这一轮的 Ctrl+C 一起取消
}

/** parent 是父 Agent：只借用它的 settings、工具注册表和权限模式，不碰它的 messages。 */
export async function runSubagent(parent: Agent, kind: AgentType, prompt: string, client: ModelClient,
  { agentId, approver, progress, transcript, maxTurns, signal }: RunOptions): Promise<SubagentRun> {
  const allowed = parent.tools.names().map((n) => parent.tools.get(n)!)
    .filter((t) => !NEVER_FOR_CHILDREN.has(t.name) && (kind.tools === null || kind.tools.includes(t.name)));
  const settings = new Settings({ ...parent.settings, maxIterations: maxTurns, effort: kind.effort, autoCompact: false });
  const child = new Agent(client, new ToolRegistry(allowed), settings);
  const providers = [dateProvider(), ...(kind.loadInstructions ? [instructionsProvider(parent.context.home)] : [])];
  child.context = new ContextBuilder(child, parent.context.home, providers, `${BASE_PROMPT}\n\n${kind.prompt}`);
  // 自己的 ToolContext：自己的文件状态表（子 agent 读过的文件，父亲仍然要自己 Read 才能改）、没有 writeHooks
  child.ctx = new ToolContext(parent.ctx.cwd);
  child.ctx.signal = signal;
  child.permissions = new PermissionManager(parent.ctx.cwd, { mode: parent.permissions.mode, allowRules: parent.permissions.allowRules });
  if (kind.readOnly || parent.permissions.mode === "plan") { // 第 21 章：plan 模式下派出的 agent 一律只读
    child.permissions.extraChecks.push(readOnlyCheck);
  }
  child.approver = approver; // 后台 agent 没有 approver：需要审批的调用一律拒绝
  if (transcript !== null) {
    mkdirSync(dirname(transcript), { recursive: true });
    child.listeners.push((msg) => {
      const rec = {
        type: msg.role, isSidechain: true, agentId, agentType: kind.name,
        timestamp: new Date().toISOString().replace("Z", "+00:00"), message: msg,
      };
      appendFileSync(transcript, JSON.stringify(rec) + "\n", "utf8");
    });
  }

  let toolUses = 0;
  let end: TurnEnd | null = null;
  for await (const ev of child.runTurn(prompt)) {
    if (ev.type === "ToolStart") {
      toolUses++;
      progress?.(`${kind.name}: ${ev.summary}`);
    } else if (ev.type === "TurnEnd") {
      end = ev;
    }
  }
  let text = end?.text ? end.text : "";
  const partial = end === null || !["end_turn", "stop_sequence"].includes(end.stopReason);
  if (partial) {
    let last = "";
    for (const m of [...child.messages].reverse()) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const b = m.content.find((x) => x.type === "text");
      if (b) {
        last = b.text;
        break;
      }
    }
    text = `[partial] The sub agent stopped early (${end ? end.stopReason : "unknown"}). ` +
      `Last thing it said:\n${text || last || "(nothing)"}`;
  }
  return { text, toolUses, requests: child.usage.requests, partial, messages: child.messages };
}

// ---------------------------------------------------------------- Agent 工具

export class AgentTool extends Tool {
  override name = "Agent";
  override kind = "agent";
  private types: () => Map<string, AgentType>;

  constructor(types: () => Map<string, AgentType>) {
    super();
    this.types = types;
  }

  /** 描述里列出所有类型（Python 版是 description 属性；这里在生成 schema 时现算）。 */
  describe(): string {
    const listing = [...this.types().values()]
      .map((t) => `- ${t.name}: ${t.description}` + (t.tools ? ` (tools: ${t.tools.join(", ")})` : "")).join("\n");
    return "Launch a sub agent to handle a self-contained task in its own context window. It cannot see this " +
      "conversation, so the prompt must contain everything it needs (paths, constraints, what to return). " +
      "Use it when exploring would pull lots of material into your context but you only need the " +
      "conclusion. Do not use it for a quick single lookup you can do yourself.\n" +
      "Set run_in_background=true to keep working while it runs; you will get a <task-notification> " +
      "with its result.\n\nAvailable agent types:\n" + listing;
  }

  override schema(): Record<string, any> {
    return { name: this.name, description: this.describe(), input_schema: this.inputSchema };
  }

  override inputSchema = {
    type: "object",
    properties: {
      description: { type: "string", description: "3-5 words, shown to the user" },
      prompt: { type: "string", description: "The full, self-contained task" },
      subagent_type: { type: "string", description: "One of the available agent types" },
      run_in_background: { type: "boolean" },
    },
    required: ["description", "prompt", "subagent_type"],
    additionalProperties: false,
  };

  override selfCheck(_args: Args): "allow" {
    return "allow"; // 派 agent 本身不碰任何东西；子 agent 的每个工具调用各自过权限
  }

  override summary(args: Args): string {
    return `Agent(${args.subagent_type}: ${args.description ?? ""})`;
  }

  override async run(args: Args, ctx: ToolContext): Promise<ToolResult> {
    const rt: SubagentRuntime | undefined = ctx.extras.subagents;
    const types = this.types();
    const kind = types.get(args.subagent_type);
    if (rt === undefined) return new ToolResult("Sub agents are not available here.", true);
    if (kind === undefined) {
      return new ToolResult(`Unknown subagent_type '${args.subagent_type}'. Available: ${[...types.keys()].join(", ")}`, true);
    }
    return rt.launch(kind, args, ctx);
  }
}

/** App 需要提供给运行时的那几样东西（避免 subagent.ts 反过来 import cli.ts）。 */
export interface SubagentHost {
  agent: Agent;
  session: { path: string; id: string };
  jobs: import("./jobs.ts").JobManager;
  ui: { info(msg: string): void };
  subagentClient: (description: string) => ModelClient;
  subagentMaxTurns: number;
}

/** App 提供的运行时：拿哪个 client、往哪写 transcript、前台进度给谁看、后台交给谁。 */
export class SubagentRuntime {
  app: SubagentHost;
  count = 0;

  constructor(app: SubagentHost) {
    this.app = app;
  }

  async launch(kind: AgentType, args: Args, ctx: ToolContext): Promise<ToolResult> {
    const app = this.app;
    this.count++;
    const agentId = `a${this.count}`;
    const desc: string = args.description;
    const transcript = join(dirname(app.session.path), app.session.id, "subagents", `agent-${agentId}.jsonl`);
    const common = { agentId, transcript, maxTurns: app.subagentMaxTurns };
    if (args.run_in_background) {
      const job = app.jobs.startThread("agent", "a", desc, async () => {
        const r = await runSubagent(app.agent, kind, args.prompt, app.subagentClient(desc),
          { ...common, approver: null, progress: null });
        const status = r.partial ? "failed" : "completed";
        return [status, `Agent "${desc}" ${status} (${r.toolUses} tool uses)`, r.text];
      }, ctx.toolUseId, agentId);
      return new ToolResult(`Async agent launched successfully.\nagentId: ${job.id}\nThe agent is working in the ` +
        "background. You will be notified automatically when it completes. Continue with " +
        "other work; do not wait or poll for it.");
    }
    const r = await runSubagent(app.agent, kind, args.prompt, app.subagentClient(desc),
      { ...common, approver: app.agent.approver, progress: (s) => app.ui.info(`  ⎿ ${s}`), signal: ctx.signal });
    const uses = `${r.toolUses} tool use${r.toolUses !== 1 ? "s" : ""}`;
    return new ToolResult(`${r.text}\n\n(agent ${agentId} · ${kind.name} · ${uses} · ${r.requests} requests)`);
  }
}
