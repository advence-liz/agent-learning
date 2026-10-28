#!/usr/bin/env node
/**
 * /goal 的骨架：「干活的模型」+「验收的模型」两个角色，用 Stop 时机串成循环。
 *
 * 官方文档（code.claude.com/docs/en/goal）给出的行为：
 *   - /goal 是一个 session 级的 prompt 型 Stop hook 的包装；
 *   - 每轮结束，把「条件 + 到目前为止的对话」发给 small fast model（默认 Haiku 档）；
 *   - 返回三种判定之一并附简短理由：not yet met / met / impossible；
 *   - not yet met → 理由作为下一轮的指引，继续干；met / impossible → 清除目标；
 *   - 评审模型不调工具，只能看对话里已经出现的证据；
 *   - 有后台任务在跑时，本轮跳过评审；
 *   - 连续若干轮没有任何工具调用（只在「回嘴」）→ 停循环、警告、目标保留。
 *
 * 本文件只复刻这套控制流，「连续几轮无进展」的阈值取 3 是 demo 值（文档只说 several turns）。
 * 真实评审调用见 makeLlmJudge()；单测和 demo 全部用离线 fake，不发网络请求。
 *
 * 离线运行：node goal_demo/goal_loop.ts
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "../fake_llm/index.ts";

export const NO_PROGRESS_LIMIT = 3; // demo 值

export type Turn = { text: string; toolCalls: number; backgroundRunning?: boolean };

export type Verdict = { status: "not_met" | "met" | "impossible"; reason: string };

export type Msg = { role: "user" | "assistant"; content: string };

// 真实评审要发网络请求，所以 Judge / Worker 都允许返回 Promise
export type Judge = (condition: string, transcript: Msg[]) => Verdict | Promise<Verdict>;

export type Worker = (directive: string, transcript: Msg[]) => Turn | Promise<Turn>;

export const JUDGE_SYSTEM =
  "你是验收员。只依据对话里已经出现的证据判断条件是否满足，不要假设对话里没出现的事。" +
  "输出 JSON：status 取 not_met/met/impossible，reason 一句话说明还差什么或为什么满足。";

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["not_met", "met", "impossible"] },
    reason: { type: "string" },
  },
  required: ["status", "reason"],
  additionalProperties: false,
};

export function renderForJudge(condition: string, transcript: Msg[]): string {
  const convo = transcript.map((m) => `[${m.role}] ${m.content}`).join("\n");
  return `<condition>\n${condition}\n</condition>\n<conversation>\n${convo}\n</conversation>`;
}

/**
 * 真实评审：一次无工具的单轮调用 + 结构化输出。client 为 new Anthropic()。
 *
 * 支持 ANTHROPIC_BASE_URL（SDK 自动读取）。本仓库的测试只注入 fake client。
 */
export function makeLlmJudge(client: LLMClient): Judge {
  const model = process.env.GOAL_JUDGE_MODEL ?? "claude-haiku-5-5";

  return async (condition, transcript) => {
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMA } },
      messages: [{ role: "user", content: renderForJudge(condition, transcript) }],
    });
    const text = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text")!.text;
    const data = JSON.parse(text);
    return { status: data.status, reason: data.reason };
  };
}

export type GoalResult = {
  outcome: "achieved" | "impossible" | "stalled" | "max_turns";
  turns: number;
  evaluations: number;
  log: string[];
};

export async function runGoal(
  condition: string,
  worker: Worker,
  judge: Judge,
  { maxTurns = 20 }: { maxTurns?: number } = {},
): Promise<GoalResult> {
  const transcript: Msg[] = [{ role: "user", content: condition }]; // 设目标即以条件为指令开第一轮
  let directive = condition;
  let noProgress = 0;
  let evals = 0;
  const log: string[] = [];
  for (let i = 1; i <= maxTurns; i++) {
    const turn = await worker(directive, transcript);
    transcript.push({ role: "assistant", content: turn.text });
    noProgress = turn.toolCalls ? 0 : noProgress + 1;
    if (turn.backgroundRunning) {
      log.push(`turn ${i}: 后台任务未结束 → 跳过评审`);
      directive = "（后台任务完成通知）";
      continue;
    }
    if (noProgress >= NO_PROGRESS_LIMIT) {
      log.push(`turn ${i}: 连续 ${noProgress} 轮无工具调用 → 停循环，目标保留`);
      return { outcome: "stalled", turns: i, evaluations: evals, log };
    }
    const v = await judge(condition, transcript);
    evals += 1;
    log.push(`turn ${i}: judge=${v.status} reason=${v.reason}`);
    if (v.status === "met") return { outcome: "achieved", turns: i, evaluations: evals, log };
    if (v.status === "impossible") return { outcome: "impossible", turns: i, evaluations: evals, log };
    // not_met：理由作为下一轮指令回灌 —— 和 Stop hook 的 decision:block + reason 是同一个形状
    directive = v.reason;
    transcript.push({ role: "user", content: `[goal evaluator] ${v.reason}` });
  }
  return { outcome: "max_turns", turns: maxTurns, evaluations: evals, log };
}

// ---------------- 离线 fake ----------------

export function scriptedWorker(turns: Turn[]): Worker {
  const it = turns[Symbol.iterator]();
  return () => {
    const { value, done } = it.next();
    if (done) throw new Error("scriptedWorker: 剧本已用完");
    return value;
  };
}

/** fake 评审：只看对话里有没有 '0 failed' 和 'lint clean' 两个证据。 */
export const keywordJudge: Judge = (condition, transcript) => {
  const text = transcript
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n");
  const missing = ["0 failed", "lint clean"].filter((k) => !text.includes(k));
  if (text.includes("无法访问")) return { status: "impossible", reason: "测试依赖的服务无法访问，条件不可能达成" };
  if (missing.length) return { status: "not_met", reason: `对话里还没出现证据：${missing.join(", ")}` };
  return { status: "met", reason: "测试与 lint 证据都已出现" };
};

if (import.meta.main) {
  const worker = scriptedWorker([
    { text: "改了 auth.ts，跑测试：3 passed, 2 failed", toolCalls: 3 },
    { text: "后台起了 e2e，等结果", toolCalls: 1, backgroundRunning: true },
    { text: "修了两个用例：5 passed, 0 failed", toolCalls: 4 },
    { text: "跑 lint：lint clean", toolCalls: 1 },
  ]);
  const r = await runGoal("test/auth 全部通过且 lint clean", worker, keywordJudge);
  console.log(r.log.join("\n"));
  console.log(`outcome=${r.outcome} turns=${r.turns} evaluations=${r.evaluations}`);
}
