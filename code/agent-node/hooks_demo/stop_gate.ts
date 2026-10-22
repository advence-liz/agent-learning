#!/usr/bin/env node
/**
 * 演示用 Stop hook：「没看到测试通过的证据就不许停」。
 *
 * Stop 事件的 stdin 带 transcript_path 和 stop_hook_active。
 *   - stop_hook_active == true 表示「这次 Stop 本身就是被某个 Stop hook 拦回去之后再次触发的」，
 *     官方建议此时直接放行，避免死循环（Claude Code 另有连续 8 次的硬上限）。
 *   - 拦截方式：stdout 输出 {"decision": "block", "reason": "..."}，reason 会作为下一步指令喂回模型。
 *
 * 这里用一个极简规则：transcript 最后 N 行里要出现测试通过的字样
 * （node --test 输出「ℹ pass 3」，pytest 输出「3 passed」，两种都认）。
 * 真实 transcript 是 jsonl，每行一条记录；本 demo 只做字符串搜索。
 *
 * 运行：node hooks_demo/stop_gate.ts < event.json
 */

import { existsSync, readFileSync } from "node:fs";

const PASSED = /ℹ pass [1-9]|\d+ passed/;

export function decide(payload: { stop_hook_active?: boolean; transcript_path?: string }): Record<string, string> | null {
  if (payload.stop_hook_active) return null; // 已经拦过一次，放行
  const tp = payload.transcript_path;
  let tail = "";
  if (tp && existsSync(tp)) {
    tail = readFileSync(tp, "utf8").split(/\r?\n/).slice(-50).join("\n");
  }
  if (PASSED.test(tail)) return null;
  return {
    decision: "block",
    reason: "还没看到测试通过的输出。请运行 `npm test` 并把结果贴出来再结束。",
  };
}

function main(): void {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const out = decide(payload);
  if (out) process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = 0;
}

if (import.meta.main) main();
