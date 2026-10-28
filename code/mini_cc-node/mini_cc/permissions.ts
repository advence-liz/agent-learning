/**
 * 工具调用的权限判定。（第 5 章；第 6 章接入 auto 审查员）
 *
 * 判定顺序（先命中先返回）：
 *     1. deny 规则                       → deny
 *     2. extraChecks（扩展钩子）          → 第一个非 null 的结论（第 21 章 plan 模式挂在这里）
 *     3. bypassPermissions 模式           → allow
 *     4. 工具自检 'ask'（高危命令）        → ask（acceptEdits / auto 也得问）
 *     5. 只读工具 / 自检 'allow'          → allow
 *     6. 会话 allow 规则（「不再询问」）    → allow
 *     7. acceptEdits / auto 且是项目内的编辑 → allow
 *     8. auto 模式                        → 交给审查员（第 6 章）
 *     9. 其余                             → ask（问用户）
 */

import { isAbsolute, join } from "node:path";
import { type Args, expandUser, isRelativeTo, realResolve, type Tool } from "./tools/base.ts";

export const DEFAULT = "default";
export const ACCEPT_EDITS = "acceptEdits";
export const AUTO = "auto";
export const PLAN = "plan";
export const BYPASS = "bypassPermissions";
export const MODES = [DEFAULT, ACCEPT_EDITS, AUTO, PLAN, BYPASS];

export class Decision {
  behavior: "allow" | "ask" | "deny";
  reason: string;
  source: string; // rule | check | mode | tool | user | classifier

  constructor(behavior: "allow" | "ask" | "deny", reason: string, source = "mode") {
    this.behavior = behavior;
    this.reason = reason;
    this.source = source;
  }
}

export interface PermissionRequest {
  tool: Tool;
  args: Args;
  summary: string;
  ruleKey: string;
  reason: string;
}

export interface PermissionReply {
  choice: "once" | "always" | "deny";
  feedback: string;
}

export type Check = (tool: Tool, args: Args, pm: PermissionManager) => Decision | null | Promise<Decision | null>;
export type Classifier = (tool: Tool, args: Args) => Decision | Promise<Decision>;

export class PermissionManager {
  cwd: string;
  mode = DEFAULT;
  allowRules = new Set<string>();
  denyRules = new Set<string>();
  // Shift+Tab 循环的顺序（第 21 章加入 plan）
  cycle = [DEFAULT, ACCEPT_EDITS, PLAN, AUTO];
  extraChecks: Check[] = [];
  // 第 6 章：auto 模式下由它判定（审查员要请求模型，所以可以是 async）
  classifier: Classifier | null = null;
  // 模式变化时通知（落盘、UI 刷新）
  onModeChange: Array<(oldMode: string, newMode: string) => void> = [];

  constructor(cwd: string, init: { mode?: string; allowRules?: Iterable<string>; cycle?: string[] } = {}) {
    this.cwd = cwd;
    if (init.mode) this.mode = init.mode;
    if (init.allowRules) this.allowRules = new Set(init.allowRules);
    if (init.cycle) this.cycle = init.cycle;
  }

  setMode(mode: string): void {
    if (!MODES.includes(mode)) throw new RangeError(`unknown mode '${mode}', choose from ${JSON.stringify(MODES)}`);
    const old = this.mode;
    this.mode = mode;
    if (old !== mode) for (const fn of this.onModeChange) fn(old, mode);
  }

  nextMode(): string {
    const i = this.cycle.indexOf(this.mode);
    this.setMode(this.cycle[(i + 1) % this.cycle.length]);
    return this.mode;
  }

  // ------------------------------------------------------------ 判定

  private insideProject(tool: Tool, args: Args): boolean {
    if (!tool.pathArg || !(tool.pathArg in args)) return false;
    const p = expandUser(String(args[tool.pathArg]));
    return isRelativeTo(realResolve(isAbsolute(p) ? p : join(this.cwd, p)), realResolve(this.cwd));
  }

  async decide(tool: Tool, args: Args): Promise<Decision> {
    const key = tool.ruleKey(args);
    if (this.denyRules.has(key) || this.denyRules.has(tool.name)) return new Decision("deny", `matches deny rule ${key}`, "rule");
    for (const check of this.extraChecks) {
      const d = await check(tool, args, this);
      if (d !== null) return d;
    }
    if (this.mode === BYPASS) return new Decision("allow", "bypassPermissions mode", "mode");
    const verdict = tool.selfCheck(args);
    if (verdict === "ask") return new Decision("ask", "high-risk operation", "tool");
    if (tool.readOnly || verdict === "allow") return new Decision("allow", "read-only", "tool");
    if (this.allowRules.has(key) || this.allowRules.has(tool.name)) return new Decision("allow", `session rule ${key}`, "rule");
    // auto 模式包含 acceptEdits 的快速通道：项目内编辑不必劳烦审查员
    if ((this.mode === ACCEPT_EDITS || this.mode === AUTO) && tool.kind === "edit" && this.insideProject(tool, args)) {
      return new Decision("allow", "acceptEdits: edit inside project", "mode");
    }
    if (this.mode === AUTO && this.classifier !== null) return this.classifier(tool, args);
    return new Decision("ask", "needs approval", "mode");
  }

  remember(req: PermissionRequest): void {
    this.allowRules.add(req.ruleKey);
  }
}

export function deniedMessage(feedback = ""): string {
  // 措辞参考 Claude Code：明确告诉模型「没执行」，以及接下来该怎么做
  const base = "The user doesn't want to proceed with this tool use. The tool use was rejected (it was NOT executed).";
  if (feedback) return `${base} To tell you how to proceed, the user said:\n${feedback}`;
  return `${base} STOP what you are doing and wait for the user to tell you how to proceed.`;
}
