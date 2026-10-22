#!/usr/bin/env node
/**
 * 演示用 PreToolUse hook：拦危险 Bash 命令。
 *
 * 协议（与 Claude Code hooks 文档一致）：
 *   - stdin：一个 JSON 对象，含 hook_event_name / tool_name / tool_input / cwd ...
 *   - 三种回应方式：
 *       exit 0 + 空 stdout         → 不表态，走正常权限流程
 *       exit 0 + stdout 是 JSON    → 用 hookSpecificOutput.permissionDecision 表态
 *       exit 2 + stderr            → 阻断，stderr 作为原因回灌给模型
 *   - 其它退出码（含 1）是「非阻断错误」，工具照常执行 —— 想拦必须 exit 2。
 *
 * 本脚本故意同时演示两种拦法：
 *   rm -rf /...      → exit 2（最硬：JSON 也救不回来）
 *   git push --force → JSON deny（带结构化理由）
 *   npm publish      → JSON ask（交给人确认）
 *   python3 ...      → JSON allow + updatedInput（改写参数：强制加 -I 隔离模式）
 *
 * 运行：node hooks_demo/guard_bash.ts < event.json
 */

import { readFileSync } from "node:fs";

export type HookPayload = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [k: string]: unknown;
};

/** 返回 [exitCode, stdout, stderr]。纯函数，方便单测。 */
export function decide(payload: HookPayload): [number, string, string] {
  if (payload.hook_event_name !== "PreToolUse" || payload.tool_name !== "Bash") {
    return [0, "", ""];
  }

  const cmd = String(payload.tool_input?.command ?? "");

  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/.test(cmd) || /\brm\s+-rf\s+~/.test(cmd)) {
    return [2, "", `拒绝：\`${cmd}\` 会删除根目录或家目录。请改成删除具体子目录。`];
  }

  if (/\bgit\s+push\b.*--force(?!-with-lease)/.test(cmd)) {
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "禁止 --force，改用 --force-with-lease",
      },
    };
    return [0, JSON.stringify(out), ""];
  }

  if (/\bnpm\s+publish\b/.test(cmd)) {
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "发包需要人工确认",
      },
    };
    return [0, JSON.stringify(out), ""];
  }

  const m = cmd.match(/^\s*python3\s+(?!-I\b)(.*)$/);
  if (m) {
    const newInput = { ...payload.tool_input, command: `python3 -I ${m[1]}` };
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "已自动加 -I 隔离模式",
        updatedInput: newInput,
      },
    };
    return [0, JSON.stringify(out), ""];
  }

  return [0, "", ""];
}

function main(): void {
  let payload: HookPayload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8")); // fd 0 = stdin
  } catch {
    // 读不懂输入：fail-open（exit 1 = 非阻断错误）。安全敏感场景应改成 exit 2 fail-closed。
    process.stderr.write("guard_bash: stdin 不是 JSON\n");
    process.exitCode = 1;
    return;
  }
  const [code, out, err] = decide(payload);
  if (out) process.stdout.write(out + "\n");
  if (err) process.stderr.write(err + "\n");
  // 用 exitCode 而不是 process.exit()：让 stdout/stderr 写完再退出，管道另一端不会读到半截 JSON
  process.exitCode = code;
}

if (import.meta.main) main();
