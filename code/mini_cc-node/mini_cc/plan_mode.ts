/**
 * plan 模式（第 21 章）：先只读地探索、把方案写进计划文件，你批准了才动手。
 *
 * plan 模式不是一个开关，而是四样东西配合：
 * 1. 规则提醒（provider）：进入 plan 时注入完整规则，之后每隔几步注入精简版，退出时注入「已退出」。
 *    和其他 provider 一样不记标志位：扫描历史里最近一条 plan 提醒，和当前模式比对。
 * 2. 权限关卡（PermissionManager.extraChecks，排在 bypass 之前）：只读的放行；计划文件可写；
 *    改动状态的命令要问你；其余编辑一律拒绝，拒绝理由里告诉模型该怎么做。
 * 3. 交接工具：ExitPlanMode 读计划文件、弹出审批，批准后切到你选的模式；EnterPlanMode 让模型主动进入。
 * 4. 只读的 sub agent：Plan / Explore；plan 模式下派出的任何 sub agent 都是只读的。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Attachment, isReminder } from "./attachments.ts";
import type { InjectState, Provider } from "./context.ts";
import { ACCEPT_EDITS, type Check, DEFAULT, Decision, PLAN, type PermissionManager } from "./permissions.ts";
import { type Args, expandUser, realResolve, Tool, type ToolContext, ToolResult } from "./tools/base.ts";

export const FULL_HEADER = "# Plan mode is active";
export const SPARSE_HEADER = "# Plan mode still active";
export const EXIT_HEADER = "# Exited plan mode";
export const SPARSE_EVERY = 5; // 距离上一条 plan 提醒多少次模型请求后，再提醒一次精简版

const FULL_TEXT = (header: string, plan: string) => `${header}
The user wants a plan before any change is made. Until they approve it you MUST NOT edit files, run commands that
change state (installs, writes, git commits, migrations), or otherwise modify the system. This overrides other
instructions. The only file you may create or edit is the plan file: ${plan}

Workflow:
1. Understand: read the relevant code with Read and read-only Bash (grep, find, git log). For wide searches, launch
   Explore agents (several in parallel if the areas are independent) so your context stays small.
2. Clarify: if a decision would change the approach (scope, API shape, trade-offs), ask with AskUserQuestion.
   Do not ask about things you can decide with a sensible default.
3. Design: for non-trivial work, a Plan agent can draft an approach; check it against the code yourself.
4. Write the plan file: the goal in one or two sentences, the approach, the files to change and how, what you
   deliberately leave out, and how you will verify it (tests to run, behaviour to check). Concise and concrete.
5. Call ExitPlanMode. It shows the plan file to the user and waits for approval. Do not ask "is this plan OK?"
   in plain text; ExitPlanMode is how you ask.`;

const SPARSE_TEXT = (header: string, plan: string) =>
  `${header}: read-only except the plan file (${plan}). Follow the workflow given earlier and call ` +
  "ExitPlanMode when the plan is ready.";
const EXIT_TEXT = (header: string, plan: string) =>
  `${header}\nYou have exited plan mode. You can now make edits, run tools and take actions. ` +
  `The approved plan is in ${plan}; refer back to it while implementing.`;

// ---------------------------------------------------------------- 1. 规则提醒

function planReminderKind(text: string): "full" | "sparse" | "exit" | null {
  for (const [kind, header] of [["full", FULL_HEADER], ["sparse", SPARSE_HEADER], ["exit", EXIT_HEADER]] as const) {
    if (text.includes(header)) return kind;
  }
  return null;
}

export function planModeProvider(planFile: () => string): Provider {
  return (st: InjectState) => {
    const mode = st.agent.permissions.mode;
    let last: string | null = null;
    let gap = 0;
    for (const m of [...st.messages].reverse()) { // 最近一条 plan 提醒，以及它之后有几次模型请求
      if (m.role === "assistant") {
        gap++;
        continue;
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      const kinds = blocks.filter(isReminder).map((b) => planReminderKind(b.text)).filter((k) => k !== null);
      if (kinds.length) {
        last = kinds.at(-1)!;
        break;
      }
    }
    const plan = planFile();
    if (mode === PLAN) {
      if (last === null || last === "exit") return new Attachment("plan_mode", "plan 模式规则（完整）", FULL_TEXT(FULL_HEADER, plan));
      if (gap >= SPARSE_EVERY) return new Attachment("plan_mode", "plan 模式提醒", SPARSE_TEXT(SPARSE_HEADER, plan));
      return null;
    }
    if (last === "full" || last === "sparse") return new Attachment("plan_mode", "已退出 plan 模式", EXIT_TEXT(EXIT_HEADER, plan));
    return null;
  };
}

// ---------------------------------------------------------------- 2. 权限关卡

export function planCheck(planFile: () => string): Check {
  return (tool: Tool, args: Args, pm: PermissionManager): Decision | null => {
    if (pm.mode !== PLAN) return null;
    if (tool.name === "ExitPlanMode" || tool.name === "EnterPlanMode" || tool.readOnly) {
      return null; // 交给后面的判定链（只读的会被放行）
    }
    const plan = planFile();
    if (tool.kind === "edit" && tool.pathArg && args[tool.pathArg]) {
      const p = expandUser(String(args[tool.pathArg]));
      const target = realResolve(isAbsolute(p) ? p : join(pm.cwd, p));
      if (target === realResolve(plan)) return new Decision("allow", "plan mode: writing the plan file", "check");
    }
    if (tool.selfCheck(args) === "allow") {
      return null; // 只读命令、维护 agent 自己的状态（任务清单、记忆……）
    }
    if (tool.kind === "exec" || tool.kind === "mcp") return new Decision("ask", "plan mode: this is not read-only", "check");
    return new Decision("deny", `plan mode is active; only the plan file ${plan} may be written. Finish the plan ` +
      "and call ExitPlanMode to ask the user for approval", "check");
  };
}

// ---------------------------------------------------------------- 3. 交接工具

export class ExitPlanModeTool extends Tool {
  override name = "ExitPlanMode";
  override kind = "plan";
  override description = "Present the plan in the plan file to the user for approval and leave plan mode if they approve. " +
    "Call it only in plan mode, after you have written the plan file. The user may approve (you then " +
    "implement the plan) or send you back to keep planning with feedback.";
  override inputSchema = { type: "object", properties: {}, additionalProperties: false };

  override selfCheck(_args: Args): "allow" {
    return "allow"; // 它自己就是一次审批，不用再套一层权限弹窗
  }

  override summary(_args: Args): string {
    return "ExitPlanMode()";
  }

  override async run(_args: Args, ctx: ToolContext): Promise<ToolResult> {
    const planCtl: PlanController | undefined = ctx.extras.plan;
    if (planCtl === undefined || planCtl.mode() !== PLAN) return new ToolResult("You are not in plan mode.", true);
    const path = planCtl.planFile();
    const plan = existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8").trim() : "";
    if (!plan) return new ToolResult(`No plan found. Write your plan to ${path} first, then call ExitPlanMode.`, true);
    const [choice, feedback] = await planCtl.approve(plan);
    if (choice === "auto" || choice === "manual") {
      planCtl.setMode(choice === "auto" ? ACCEPT_EDITS : DEFAULT);
      // 措辞参考 Claude Code 的原文（二进制里的字符串）
      return new ToolResult("User has approved your plan. You can now start coding. Start with updating your todo " +
        `list if applicable. Your plan has been saved to: ${path} You can refer back to it if ` +
        `needed during implementation.\n\n## Approved Plan:\n${plan}`);
    }
    return new ToolResult("The user reviewed the plan and wants you to keep planning (still in plan mode). " +
      (feedback ? `Their feedback:\n${feedback}` : "Ask what to change if it is unclear."));
  }
}

export class EnterPlanModeTool extends Tool {
  override name = "EnterPlanMode";
  override kind = "plan";
  override description = "Switch to plan mode before a large or ambiguous change: explore read-only, write a plan, and get " +
    "the user's approval before editing. Use it when the task touches many files or the right " +
    "approach is unclear. Do not use it for small, clear changes.";
  override inputSchema = { type: "object", properties: {}, additionalProperties: false };

  override selfCheck(_args: Args): "allow" {
    return "allow"; // 进入 plan 只会让自己受更多限制
  }

  override summary(_args: Args): string {
    return "EnterPlanMode()";
  }

  override run(_args: Args, ctx: ToolContext): ToolResult {
    const planCtl: PlanController | undefined = ctx.extras.plan;
    if (planCtl === undefined) return new ToolResult("Plan mode is not available here.", true);
    if (planCtl.mode() === PLAN) return new ToolResult("Already in plan mode.");
    planCtl.setMode(PLAN);
    return new ToolResult("Entered plan mode. Explore and design first; write your plan to the plan file and call " +
      "ExitPlanMode for approval before making any change.");
  }
}

export type PlanChoice = "auto" | "manual" | "keep";

/** App 提供给工具的那一小块能力：当前模式、切换模式、计划文件位置、审批界面。 */
export class PlanController {
  private pm: PermissionManager;
  planFile: () => string;
  approve: (plan: string) => Promise<[PlanChoice, string]>;

  constructor(pm: PermissionManager, planFile: () => string, approve: (plan: string) => Promise<[PlanChoice, string]>) {
    this.pm = pm;
    this.planFile = planFile;
    this.approve = approve;
  }

  mode(): string {
    return this.pm.mode;
  }

  setMode(mode: string): void {
    this.pm.setMode(mode);
  }
}
