/**
 * 补充章「Agent 构建指南」内核一：循环最难的是什么时候停。
 *
 * 在第 1 章的 runAgent 上加三件事：
 *   1. 撞迭代上限 → 不抛错，再调一次模型（tool_choice=none）让它收口总结；
 *   2. 软预算到点 → 只拦「再开一圈」，已经在跑的这圈照常做完；
 *   3. 被打断 → 没执行的工具调用补一条 is_error 的 tool_result，历史保持「每个 tool_use 都有回音」。
 * 结束原因放进返回值，调用方据此决定界面怎么显示。
 *
 * 离线运行： node loop_guard/guarded_loop.ts
 * 真实运行：把 new FakeAnthropic(...) 换成 new Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { FakeAnthropic, text, toolUse, type LLMClient } from "../fake_llm/index.ts";

export const MODEL = "claude-opus-5-5";

export type Handler = (args: any) => string | Promise<string>;
export type StopReason = "end_turn" | "max_iterations" | "soft_budget" | "interrupted";

export interface RunResult {
  answer: string;
  stop: StopReason;
  turns: number; // 本次调用里开了几圈带工具的请求（不含收口那一次）
}

export const WRAP_UP = (why: string) =>
  `（系统提示：${why}，本轮到此为止。不要再调用工具，用已经拿到的信息总结：做完了什么、还差什么、下一步建议。）`;
export const ABORTED = "用户已打断，这个工具调用没有执行。";

const textOf = (resp: Anthropic.Message) => resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");

/** 在历史末尾追加一段用户文字：最后一条已是 user（比如一组 tool_result）就并进去，不新开一条。 */
export function addUserText(messages: Anthropic.MessageParam[], s: string): void {
  const last = messages.at(-1);
  if (last?.role !== "user") {
    messages.push({ role: "user", content: s });
    return;
  }
  if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
  last.content.push({ type: "text", text: s }); // tool_result 在前、文字在后
}

/** 模拟接口的校验：每个 tool_use 都要在紧随其后的 user 消息里有同 id 的 tool_result。返回缺回音的 id。 */
export function danglingToolUses(messages: Anthropic.MessageParam[]): string[] {
  const missing: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const next = messages[i + 1];
    const answered = new Set(
      next && typeof next.content !== "string"
        ? next.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []))
        : [],
    );
    for (const b of m.content) if (b.type === "tool_use" && !answered.has(b.id)) missing.push(b.id);
  });
  return missing;
}

export async function runGuarded(
  client: LLMClient,
  messages: Anthropic.MessageParam[], // 会被原地追加；调用方先放好这一轮的用户输入
  tools: Anthropic.Tool[],
  handlers: Record<string, Handler>,
  {
    maxTurns = 10,
    softBudgetMs = Infinity,
    signal,
    now = Date.now,
    log = console.log,
  }: { maxTurns?: number; softBudgetMs?: number; signal?: AbortSignal; now?: () => number; log?: (s: string) => void } = {},
): Promise<RunResult> {
  const start = now();
  const ask = (extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}) =>
    client.messages.create({ model: MODEL, max_tokens: 16000, tools, messages, ...extra });

  const wrapUp = async (stop: StopReason, why: string, turns: number): Promise<RunResult> => {
    addUserText(messages, WRAP_UP(why));
    // 工具定义保留（历史里有 tool_use），用 tool_choice=none 禁止再调
    const resp = await ask({ tool_choice: { type: "none" } });
    messages.push({ role: "assistant", content: resp.content });
    return { answer: textOf(resp), stop, turns };
  };

  for (let turn = 0; ; turn++) {
    if (turn >= maxTurns) return wrapUp("max_iterations", `已达到迭代上限 ${maxTurns} 圈`, turn);
    if (now() - start >= softBudgetMs) return wrapUp("soft_budget", "已用完本轮的时间预算", turn);

    const resp = await ask();
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") return { answer: textOf(resp), stop: "end_turn", turns: turn + 1 };

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      if (signal?.aborted) {
        // 打断后不再执行，但仍要给这个 tool_use 一个回音，否则下一次请求会被接口拒绝
        log(`⊘ ${block.name} 未执行`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: ABORTED, is_error: true });
        continue;
      }
      log(`⏺ ${block.name}(${JSON.stringify(block.input)})`);
      let out: string, isError: boolean;
      try {
        [out, isError] = [await handlers[block.name](block.input), false];
      } catch (e) {
        [out, isError] = [`${(e as Error).name}: ${(e as Error).message}`, true];
      }
      log(`✔ ${out.slice(0, 80)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: out, is_error: isError });
    }
    messages.push({ role: "user", content: results });
    if (signal?.aborted) return { answer: "", stop: "interrupted", turns: turn + 1 };
  }
}

// ---------- 离线演示 ----------

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_logs",
    description: "按关键词搜索构建日志，返回命中的几行。",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "run_tests",
    description: "运行测试并返回摘要。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "deploy_preview",
    description: "把当前分支部署到预览环境。",
    input_schema: { type: "object", properties: {} },
  },
];

/** 场景一：模型一直想再搜一次，撞上 3 圈上限后收口。 */
export async function demoMaxIterations(): Promise<[RunResult, FakeAnthropic]> {
  const client = new FakeAnthropic([
    toolUse("search_logs", { query: "slow" }, { say: "先搜一下构建日志。" }),
    toolUse("search_logs", { query: "cache miss" }),
    toolUse("search_logs", { query: "dependency install" }),
    text("已确认：依赖安装阶段缓存全部未命中，占了大部分耗时。还没查清缓存为什么失效，建议下一步对比两次构建的 lockfile。"),
  ]);
  const hits: Record<string, string> = {
    slow: "build took 412s (baseline 95s)",
    "cache miss": "restore cache: 0/38 hits",
    "dependency install": "install deps: 301s",
  };
  const task = "构建为什么突然变慢了？";
  console.log(`❯ ${task}`);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const r = await runGuarded(client, messages, TOOLS, { search_logs: ({ query }) => hits[query] ?? "无命中" }, { maxTurns: 3 });
  console.log(`⏺ ${r.answer}`);
  console.log(`  [结束原因 ${r.stop}，${r.turns} 圈]`);
  return [r, client];
}

/** 场景二：同一圈里两个工具，第一个跑到一半用户按了打断；之后用户补一句话继续。 */
export async function demoInterrupt(): Promise<[RunResult, RunResult, Anthropic.MessageParam[], FakeAnthropic]> {
  const client = new FakeAnthropic([
    {
      content: [
        { type: "text", text: "先跑测试，再部署预览。" },
        { type: "tool_use", id: "toolu_run", name: "run_tests", input: {} },
        { type: "tool_use", id: "toolu_deploy", name: "deploy_preview", input: {} },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 50, output_tokens: 40 },
    },
    text("好的，不部署。测试结果：120 个通过，0 个失败。"),
  ]);
  const ctrl = new AbortController();
  const handlers: Record<string, Handler> = {
    run_tests: () => {
      ctrl.abort(); // 模拟：测试跑着的时候用户按了打断
      return "120 passed, 0 failed";
    },
    deploy_preview: () => "deployed to preview",
  };
  const task = "跑一下测试然后部署预览";
  console.log(`❯ ${task}`);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const first = await runGuarded(client, messages, TOOLS, handlers, { signal: ctrl.signal });
  console.log(`  [结束原因 ${first.stop}；缺回音的 tool_use：${JSON.stringify(danglingToolUses(messages))}]`);
  console.log(`  [如果打断时直接退出、不写这条 tool_result 消息：${JSON.stringify(danglingToolUses(messages.slice(0, -1)))}]`);

  const followUp = "先别部署，告诉我测试结果就行";
  console.log(`❯ ${followUp}`);
  addUserText(messages, followUp);
  const second = await runGuarded(client, messages, TOOLS, handlers);
  console.log(`⏺ ${second.answer}`);
  return [first, second, messages, client];
}

if (import.meta.main) {
  console.log("—— 场景一：撞迭代上限 ——");
  const [, c1] = await demoMaxIterations();
  console.log(`\n[离线 fake 模型] 收口那次请求的 tool_choice：${JSON.stringify(c1.calls.at(-1)!.tool_choice)}`);
  console.log("\n—— 场景二：打断后继续 ——");
  await demoInterrupt();
}
