/**
 * 补充章「成本控制与模型路由」：给 agent 循环加金额预算，按租户记账。
 *
 * 每开一圈之前问两件事：
 *   1. 已花的 + 下一圈最坏情况 > 硬上限？→ 一次都不再调，直接返回已有结果（stop=budget_hard）；
 *   2. 已花的 ≥ 软上限？→ 再调最后一次、禁用工具（tool_choice=none），让模型收口总结（stop=budget_soft）。
 * 这和「Agent 构建指南」内核一的软预算是同一个思路，只是把「时间」换成了「钱」。
 *
 * 离线运行： node cost_routing/budget.ts
 */

import type Anthropic from "@anthropic-ai/sdk";
import { FakeAnthropic, text, toolUse, type CreateParams, type LLMClient, type Step } from "../fake_llm/index.ts";
import { Budget, CostMeter, normalizeUsage, worstCaseNextUsd, type Tokens } from "./meter.ts";

export const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 4096;
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_logs",
    description: "在构建日志里搜索关键词，返回匹配的行",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

export const wrapUpPrompt = (why: string) =>
  `（系统提示：${why}，本轮到此为止。不要再调用工具，用已经拿到的信息总结：做完了什么、还差什么。）`;

export type StopReason = "end_turn" | "budget_soft" | "budget_hard";
export interface RunResult {
  answer: string;
  stop: StopReason;
  turns: number;
  usd: number;
}

const textOf = (resp: Anthropic.Message) => resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");

export async function runBudgeted(
  client: LLMClient,
  task: string,
  runTool: (name: string, args: unknown) => string,
  opts: { meter: CostMeter; budget: Budget; tenant: string; model?: string; log?: (s: string) => void },
): Promise<RunResult> {
  const { meter, budget, tenant, model = MODEL, log = console.log } = opts;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  let last: Tokens | null = null; // 上一次响应的 Tokens，用来估下一圈最坏花多少
  let lastAnswer = "";
  let pendingInput = 0; // 上一圈追加的工具结果（粗估：按字符数算 token，宁可高估）

  const ask = async (extra: Partial<CreateParams> = {}) => {
    const resp = await client.messages.create({ model, max_tokens: MAX_TOKENS, tools: TOOLS, messages, ...extra });
    const usd = meter.add(model, resp.usage, { tenant });
    last = normalizeUsage(resp.usage);
    log(`  [计费] ${tenant} 本次 $${usd.toFixed(4)}，累计 $${meter.spent(tenant).toFixed(4)}`);
    return resp;
  };

  let turn = 0;
  while (true) {
    const spent = meter.spent(tenant);
    const verdict = budget.check(spent, worstCaseNextUsd(model, last, MAX_TOKENS, pendingInput));
    if (verdict === "hard") {
      log(`⊘ 下一圈最坏情况会超过硬上限 $${budget.hardUsd}，不再调用模型`);
      return { answer: lastAnswer || "（预算用尽，任务未完成）", stop: "budget_hard", turns: turn, usd: spent };
    }
    if (verdict === "soft") {
      log(`⊘ 已花 $${spent.toFixed(4)}，到了软上限 $${budget.softUsd}：禁用工具，再调最后一次收口`);
      const note: Anthropic.TextBlockParam = { type: "text", text: wrapUpPrompt(`已花费 $${spent.toFixed(4)}，到了软上限`) };
      const lastMsg = messages.at(-1)!; // 这里一定是 user：任务本身，或最后一组 tool_result
      if (typeof lastMsg.content === "string") lastMsg.content = [{ type: "text", text: lastMsg.content }];
      lastMsg.content.push(note); // 并进同一条 user 消息，不出现两条连续的 user
      const resp = await ask({ tool_choice: { type: "none" } });
      return { answer: textOf(resp), stop: "budget_soft", turns: turn, usd: meter.spent(tenant) };
    }

    const resp = await ask();
    turn += 1;
    messages.push({ role: "assistant", content: resp.content });
    lastAnswer = textOf(resp) || lastAnswer;
    if (resp.stop_reason !== "tool_use") return { answer: textOf(resp), stop: "end_turn", turns: turn, usd: meter.spent(tenant) };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      log(`⏺ ${b.name}(${JSON.stringify(b.input)})`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: runTool(b.name, b.input) });
    }
    pendingInput = results.reduce((s, r) => s + String(r.content).length, 0);
    messages.push({ role: "user", content: results });
  }
}

export const SUMMARY = "已确认：依赖安装阶段缓存全部未命中，占了大部分耗时。还没查清缓存为什么失效，建议对比两次构建的 lockfile。";

/**
 * 一个想搜 nTools 次的模型：每圈输入涨 growth 个 token（usage 是构造的，没有缓存）。
 * 收到 tool_choice=none 的收口请求时，不管轮到第几步都直接写总结。
 */
export function demoScript(nTools: number, promptTokens = 20_000, growth = 8_000) {
  const step = (i: number) => (params: CreateParams): Step => {
    const inputTokens = promptTokens + i * growth;
    if (params.tool_choice?.type === "none" || i === nTools) return text(SUMMARY, { inputTokens, outputTokens: 150 });
    return toolUse("search_logs", { query: `q${i}` }, { inputTokens, outputTokens: 200 });
  };
  return Array.from({ length: nTools + 1 }, (_, i) => step(i));
}

async function main() {
  const meter = new CostMeter();
  const tool = () => "install deps: 301s (cache 0/38 hits)";
  const budget = new Budget(0.3, 0.8);
  console.log(`[离线 fake 模型] 软上限 $${budget.softUsd}，硬上限 $${budget.hardUsd}（单个租户、单次任务）\n`);
  console.log("—— 租户 team-a：模型一直想再搜一次 ——");
  let r = await runBudgeted(new FakeAnthropic(demoScript(20)), "构建为什么突然变慢了？", tool, { meter, budget, tenant: "team-a" });
  console.log(`  结束原因 ${r.stop}，${r.turns} 圈，花费 $${r.usd.toFixed(4)}\n  回答：${r.answer}\n`);

  console.log("—— 租户 team-b：两圈就答完 ——");
  r = await runBudgeted(new FakeAnthropic(demoScript(1)), "构建为什么突然变慢了？", tool, { meter, budget, tenant: "team-b" });
  console.log(`  结束原因 ${r.stop}，${r.turns} 圈，花费 $${r.usd.toFixed(4)}\n`);

  const byTenant = Object.fromEntries(Object.entries(meter.by("tenant")).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4]));
  console.log("按租户汇总：", byTenant);
}

if (import.meta.main) await main();
