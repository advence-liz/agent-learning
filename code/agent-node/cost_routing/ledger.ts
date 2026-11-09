/**
 * 补充章「成本控制与模型路由」：同一段 10 圈的 agent 对话，换几种做法各花多少钱。
 *
 * usage 是按下面的形状构造的（不是真实请求）：
 *   - 固定前缀（system + 工具定义）8,000 token，任务描述 300 token；
 *   - 前 9 圈每圈：模型输出 400 token（一次工具调用），工具结果 6,000 token（截断后 1,200）；
 *   - 第 10 圈：模型输出 800 token 的最终回答。
 * 每圈的输入 = 前缀 + 任务 + 之前所有圈的输出和工具结果，所以输入逐圈线性变长，累计输入按圈数平方增长。
 *
 * 缓存按「顶层自动缓存」的理想情况构造：每圈读到上一圈的全部输入，只写这一圈新增的部分。
 *
 * 离线运行： node cost_routing/ledger.ts
 */

import { CostMeter, ljust, promptOf, tokens, type Tokens } from "./meter.ts";

export const MODEL = "claude-opus-5-5";
const PREFIX = 8_000, TASK = 300;
const OUT = 400, FINAL_OUT = 800;
const TOOL_RESULT = 6_000, TRUNCATED = 1_200;
const TURNS = 10;

export interface Scenario {
  name: string;
  cache: boolean;
  truncate: boolean;
  prefixBreaks?: boolean; // 前缀每圈都变（比如 system 里带了当前时间）
}

export const SCENARIOS: Scenario[] = [
  { name: "不缓存 · 不截断", cache: false, truncate: false },
  { name: "不缓存 · 截断工具结果", cache: false, truncate: true },
  { name: "缓存 · 不截断", cache: true, truncate: false },
  { name: "缓存 · 截断工具结果", cache: true, truncate: true },
  { name: "缓存，但前缀每圈都变", cache: true, truncate: false, prefixBreaks: true },
];

/** 每圈请求的输入总量。 */
export function prompts(truncate: boolean): number[] {
  const res = truncate ? TRUNCATED : TOOL_RESULT;
  return Array.from({ length: TURNS }, (_, i) => PREFIX + TASK + i * (OUT + res));
}

export function usages(s: Scenario): Tokens[] {
  const ps = prompts(s.truncate);
  return ps.map((p, i) => {
    const output = i === TURNS - 1 ? FINAL_OUT : OUT;
    if (!s.cache) return tokens({ input: p, output });
    if (s.prefixBreaks || i === 0) return tokens({ write5m: p, output }); // 什么都读不到，整段重写
    return tokens({ cacheRead: ps[i - 1], write5m: p - ps[i - 1], output });
  });
}

export function run(s: Scenario): CostMeter {
  const meter = new CostMeter();
  for (const u of usages(s)) meter.add(MODEL, u);
  return meter;
}

function main() {
  console.log(`[离线 fake 用量] 模型 ${MODEL}，10 圈 agent 对话，usage 按固定形状构造\n`);
  const base = run(SCENARIOS[0]), cached = run(SCENARIOS[2]);
  console.log("圈    本圈输入   无缓存 本圈$   有缓存 本圈$");
  base.records.forEach((a, i) => {
    const b = cached.records[i];
    console.log(
      `${String(i + 1).padStart(2)} ${promptOf(a.tokens).toLocaleString("en-US").padStart(11)} ${a.usd.toFixed(4).padStart(13)} ${b.usd.toFixed(4).padStart(14)}`,
    );
  });
  const ps = prompts(false);
  const sum = ps.reduce((s, x) => s + x, 0);
  console.log(
    `\n第 10 圈的输入是第 1 圈的 ${(ps.at(-1)! / ps[0]).toFixed(1)} 倍；10 圈累计输入 ${sum.toLocaleString("en-US")} token` +
      `（如果每圈都只有第 1 圈那么长，是 ${(ps[0] * TURNS).toLocaleString("en-US")}）\n`,
  );

  console.log(`${ljust("做法", 26)}  总成本$  相对基线`);
  const b0 = base.spent();
  for (const s of SCENARIOS) {
    const usd = run(s).spent();
    console.log(`${ljust(s.name, 26)}${usd.toFixed(4).padStart(9)}  ${(Math.round((usd / b0) * 100) + "%").padStart(7)}`);
  }
}

if (import.meta.main) main();
