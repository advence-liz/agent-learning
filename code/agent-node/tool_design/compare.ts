/**
 * 补充章「工具设计」：同一个任务，坏工具集 vs 好工具集，对比 agent 循环的轨迹和上下文开销。
 *
 * 注意：两条轨迹都是 FakeAnthropic 的剧本，模型「怎么反应」是我们写死的，用来演示机制：
 * 坏工具集下模型要猜单位、猜枚举值；好工具集下错误信息直接告诉它怎么改。
 * 真实模型在两套工具下的差异有多大，要用评测集跑出来，不能拿这个剧本当结论。
 * 工具定义和工具结果的字符数则是真实算出来的，与剧本无关。
 *
 * 离线运行： node tool_design/compare.ts
 * 真实运行：把 new FakeAnthropic(...) 换成 new Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { FakeAnthropic, text, toolUse, type LLMClient, type Script } from "../fake_llm/index.ts";
import { dumps, estimateTokens, measureTools, truncateResult } from "./budget.ts";
import {
  BAD_HANDLERS,
  BAD_TOOLS,
  GOOD_HANDLERS,
  GOOD_TOOLS,
  ORDERS,
  USERS,
  resetBackend,
  yuan,
  type Handler,
} from "./toolsets.ts";

export const MODEL = "claude-opus-5-5";
export const TASK = "张伟说上个月底买的耳机有问题，帮他退款。";

export interface Stats {
  answer: string;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  defsChars: number; // 工具定义，每次请求都带
  resultChars: number; // 本次任务所有工具结果加起来
  contextChars: number; // 每次请求里「工具定义 + 历史中全部工具结果」的累加：大结果每轮都会被重新发送
  defsTokens: number;
  resultTokens: number;
  contextTokens: number;
  results: Anthropic.ToolResultBlockParam[];
}

export async function runAgent(
  client: LLMClient,
  task: string,
  tools: Anthropic.Tool[],
  handlers: Record<string, Handler>,
  { maxTurns = 8, log = console.log as (s: string) => void } = {},
): Promise<Stats> {
  const m = measureTools(tools);
  const st: Stats = {
    answer: "", modelCalls: 0, toolCalls: 0, toolErrors: 0,
    defsChars: m.chars, resultChars: 0, contextChars: 0,
    defsTokens: m.tokens, resultTokens: 0, contextTokens: 0, results: [],
  };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  for (let turn = 0; turn < maxTurns; turn++) {
    st.modelCalls++;
    st.contextChars += st.defsChars + st.resultChars;
    st.contextTokens += st.defsTokens + st.resultTokens;
    const resp = await client.messages.create({ model: MODEL, max_tokens: 16000, tools, messages });
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") {
      st.answer = resp.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return st;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      st.toolCalls++;
      log(`⏺ ${b.name}(${dumps(b.input)})`);
      let out: string;
      let err = false;
      try {
        out = handlers[b.name](b.input as Record<string, unknown>);
      } catch (e) {
        // 好工具集抛的 ToolError，消息本身就是写给模型的改法；坏工具集的后端异常则是原文透传
        out = (e as Error).message;
        err = true;
      }
      st.toolErrors += Number(err);
      st.resultChars += out.length;
      st.resultTokens += estimateTokens(out);
      const first = out.split("\n")[0];
      log(`${err ? "✘" : "✔"} ${first.slice(0, 60)}${first.length > 60 ? "…" : ""}  （${out.length} 字符）`);
      const r: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: b.id, content: out, is_error: err };
      results.push(r);
      st.results.push(r);
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error(`超过 ${maxTurns} 轮仍未结束`);
}

// ---------- 两份剧本（离线 fake 模型）----------

export function badScript(): Script {
  const zw = USERS.find((u) => u.name === "张伟")!;
  const order = ORDERS.find((o) => o.number === "ORD-1042")!;
  const refund = { order_id: order.id, amount: 899 }; // 剧本：模型以为单位是元，其实接口要的是分
  return [
    toolUse("api_get_users", {}, { say: "先找到张伟的用户 ID。" }),
    toolUse("api_get_orders", { user_id: zw.id }),
    toolUse("api_post_refunds", { ...refund, reason: "耳机有问题" }),
    toolUse("api_post_refunds", { ...refund, reason: "defective" }, { say: "原因可能要用英文代码，换一个试试。" }),
    toolUse("api_post_refunds", { ...refund, reason: "damaged" }, { say: "再换一个。" }),
    text("已为张伟的耳机订单提交退款，金额 899。"),
  ];
}

export function goodScript(): Script {
  return [
    toolUse("webapp_find_orders", { customer: "张伟", query: "耳机" }),
    toolUse("webapp_refund_order", { order_number: "1042", reason: "damaged" }),
    toolUse("webapp_refund_order", { order_number: "ORD-1042", reason: "damaged" }, { say: "订单号要带 ORD- 前缀。" }),
    text("已为张伟的降噪耳机 Pro（ORD-1042）提交全额退款 ¥899.00，3–5 个工作日原路退回。"),
  ];
}

async function run(name: string, tools: Anthropic.Tool[], handlers: Record<string, Handler>, script: Script) {
  resetBackend();
  console.log(`—— ${name} ——`);
  console.log(`❯ ${TASK}`);
  const st = await runAgent(new FakeAnthropic(script), TASK, tools, handlers);
  console.log(`⏺ ${st.answer}`);
  return st;
}

export function report(bad: Stats, good: Stats): string[] {
  const size = (chars: number, tokens: number) => `${chars} 字符 ≈${tokens} tok`;
  return [
    "指标 | 坏工具集 | 好工具集",
    `模型调用 | ${bad.modelCalls} | ${good.modelCalls}`,
    `工具调用（其中报错） | ${bad.toolCalls}（${bad.toolErrors}） | ${good.toolCalls}（${good.toolErrors}）`,
    `工具定义，每次请求都带 | ${size(bad.defsChars, bad.defsTokens)} | ${size(good.defsChars, good.defsTokens)}`,
    `工具结果合计 | ${size(bad.resultChars, bad.resultTokens)} | ${size(good.resultChars, good.resultTokens)}`,
    `各次请求累计发送 | ${size(bad.contextChars, bad.contextTokens)} | ${size(good.contextChars, good.contextTokens)}`,
  ];
}

if (import.meta.main) {
  const bad = await run("坏工具集：后端接口一比一包装", BAD_TOOLS, BAD_HANDLERS, badScript());
  const o = ORDERS.find((o) => o.number === "ORD-1042")!;
  console.log(`[后端记录] ORD-1042 实付 ${yuan(o.payment.captured_cents)}，实际退了 ${yuan(o.refunds[0].amount_cents)}\n`);
  const good = await run("好工具集：按任务设计", GOOD_TOOLS, GOOD_HANDLERS, goodScript());
  console.log("\n—— 对比（离线 fake 模型；轨迹是剧本，字符数是实算）——");
  console.log(report(bad, good).join("\n"));
  console.log("\n—— 坏工具集第 3 次调用，模型看到的错误 ——");
  console.log(bad.results[2].content);
  console.log("\n—— 好工具集第 2 次调用，模型看到的错误 ——");
  console.log(good.results[1].content);
  console.log("\n—— 兜底截断：api_get_users 的结果截到 300 字符 ——");
  console.log(truncateResult(BAD_HANDLERS.api_get_users({}), 300, "需要的信息如果不在上面，换更具体的查询条件再调一次。"));
}
