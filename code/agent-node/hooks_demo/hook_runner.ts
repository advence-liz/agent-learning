#!/usr/bin/env node
/**
 * 一个「迷你 hook 调度器」：模拟 Claude Code 在主循环里怎么调用 hook、怎么解读结果。
 *
 * 只实现教学需要的子集（规则来自官方 hooks 文档）：
 *   1. 按 matcher 选中 hook（只支持「精确名 / a|b 列表 / 空=全匹配」）。
 *   2. 把事件 JSON 写进子进程 stdin，收 exit code / stdout / stderr。
 *   3. 解读：
 *      - exit 2           → 阻断类事件被阻断，stderr 是理由；JSON 被忽略
 *      - exit 0 + JSON    → 读 continue / decision / hookSpecificOutput
 *      - exit 0 + 纯文本  → SessionStart / UserPromptSubmit 当作上下文注入，其它事件只进 debug log
 *      - 其它退出码       → 非阻断错误，动作照常进行
 *   多个 hook 命中时，本 demo 取「最严格」的决定（deny > ask > allow）——这是 demo 的选择，
 *   以官方文档的合并规则为准。
 *
 * 用法：node hooks_demo/hook_runner.ts <settings.json> <event-json-file>
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BLOCKABLE = new Set(["PreToolUse", "UserPromptSubmit", "Stop", "SubagentStop"]);
const PLAIN_STDOUT_IS_CONTEXT = new Set(["SessionStart", "UserPromptSubmit"]);
const SEVERITY: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

export type Settings = {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type?: string; command: string }> }>>;
};

export class Verdict {
  blocked = false;
  permission: string | null = null; // allow / ask / deny（PreToolUse）
  reason = "";
  updatedInput: Record<string, unknown> | null = null;
  context: string[] = []; // 要注入给模型的文字
  stopSession = false; // continue:false
  log: string[] = [];
}

export function matches(matcher: string | undefined, name: string): boolean {
  if (!matcher || matcher === "*") return true;
  return matcher.split("|").includes(name);
}

export function runOne(cmd: string, payload: Record<string, unknown>): [number, string, string] {
  const p = spawnSync(cmd, { shell: true, input: JSON.stringify(payload), encoding: "utf8", timeout: 60_000 });
  // 超时 / 起不来时 status 为 null：按非阻断错误（1）处理
  return [p.status ?? 1, (p.stdout ?? "").trim(), (p.stderr ?? "").trim()];
}

export function dispatch(settings: Settings, payload: Record<string, any>): Verdict {
  const event: string = payload.hook_event_name;
  const target: string = payload.tool_name ?? "";
  const v = new Verdict();
  for (const group of settings.hooks?.[event] ?? []) {
    if ((event === "PreToolUse" || event === "PostToolUse") && !matches(group.matcher, target)) continue;
    for (const h of group.hooks) {
      const [code, out, err] = runOne(h.command, payload);
      v.log.push(`${JSON.stringify(h.command)} -> exit=${code}`);
      if (code === 2) {
        if (BLOCKABLE.has(event)) {
          [v.blocked, v.reason] = [true, err];
          if (event === "PreToolUse") v.permission = "deny";
        } else {
          v.log.push(`  (exit 2 在 ${event} 上不阻断；stderr 只给人看)`);
        }
        continue;
      }
      if (code !== 0) {
        v.log.push(`  非阻断错误，忽略：${err}`);
        continue;
      }
      if (!out) continue;
      let data: any;
      try {
        data = JSON.parse(out);
      } catch {
        if (PLAIN_STDOUT_IS_CONTEXT.has(event)) v.context.push(out);
        else v.log.push("  纯文本 stdout，非上下文事件 → 仅进 debug log");
        continue;
      }
      if (data.continue === false) [v.stopSession, v.reason] = [true, data.stopReason ?? ""];
      if (data.decision === "block") [v.blocked, v.reason] = [true, data.reason ?? ""];
      const hso = data.hookSpecificOutput ?? {};
      const pd: string | undefined = hso.permissionDecision;
      if (pd && (v.permission === null || (SEVERITY[pd] ?? 0) > (SEVERITY[v.permission] ?? 0))) {
        v.permission = pd;
        v.reason = hso.permissionDecisionReason ?? "";
        if (pd === "deny") v.blocked = true;
      }
      if ("updatedInput" in hso) v.updatedInput = hso.updatedInput;
      if (hso.additionalContext) v.context.push(hso.additionalContext);
    }
  }
  return v;
}

function main(): void {
  const settings = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const payload = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const { log, ...rest } = dispatch(settings, payload);
  for (const line of log) console.log("·", line);
  console.log(JSON.stringify(rest));
}

if (import.meta.main) main();
