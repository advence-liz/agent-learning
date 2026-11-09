/**
 * 补充章「成本控制与模型路由」：规则路由 vs 级联路由。
 *
 * - 规则路由：按任务类型查表选模型（分类 / 摘要 / 改写检索词 → Haiku，编码 → Sonnet，规划 → Opus）。
 * - 级联路由：一律先用最便宜的模型；代码校验不过，就带着同一个请求升级到下一档，直到通过或用完。
 *
 * 八个任务、每个模型答得对不对，都是 fake client 按脚本给的（token 数也是预设的），
 * 目的只是看清两种策略在「成本」和「升级率」上的账怎么算。
 *
 * 离线运行： node cost_routing/router.ts
 * 真实运行：把 scriptedClient() 换成 new Anthropic()，校验函数换成真的测试 / schema 校验。
 */

import { FakeAnthropic, type CreateParams, type LLMClient, type Step } from "../fake_llm/index.ts";
import { CostMeter, ljust, rjust } from "./meter.ts";

export const HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5", OPUS = "claude-opus-5-5";
export const LADDER = [HAIKU, SONNET, OPUS];
const SHORT: Record<string, string> = { [HAIKU]: "haiku", [SONNET]: "sonnet", [OPUS]: "opus" };

// 规则路由表：任务类型 → 模型。路由规则本身会改变线上行为，改它要过评测门禁。
export const RULES: Record<string, string> = {
  classify: HAIKU,
  summarize: HAIKU,
  rewrite_query: HAIKU,
  extract: HAIKU,
  code: SONNET,
  plan: OPUS,
};

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// 校验器：只用代码判，不再调模型。真实项目里是跑测试、schema 校验、正则红线。
export const checkLabel = (s: string) => ["bug", "feature", "question"].includes(s.trim());
export const checkSummary = (s: string) => s.length > 0 && s.length <= 40;
export const checkQuery = (s: string) => s.length > 0 && s.length <= 30 && !["那个", "上次", "上周"].some((w) => s.includes(w));
export const checkLocation = (s: string) => {
  const d = parse(s);
  return isObj(d) && typeof d.file === "string" && Number.isInteger(d.line);
};
export const checkPlan = (s: string) => {
  const d = parse(s);
  return Array.isArray(d) && d.length >= 3 && d.every((x) => isObj(x) && Boolean(x.verify));
};
export const checkPatch = (s: string) => {
  // 演示用：真实场景是把补丁打上去跑测试，这里用 fake 回答里约定的测试结果字段代替
  const d = parse(s);
  return isObj(d) && Boolean(d.diff) && d.tests === "pass";
};

export interface Task {
  id: string;
  kind: string;
  prompt: string;
  check: (s: string) => boolean;
  inputTokens: number;
  outputTokens: number;
  daily: number; // 每天大约多少次这类调用，用来把单次成本折算成日成本
}

const task = (id: string, kind: string, prompt: string, check: Task["check"], inputTokens: number, outputTokens: number, daily: number): Task =>
  ({ id, kind, prompt, check, inputTokens, outputTokens, daily });

export const TASKS: Task[] = [
  task("t1", "classify", "给 issue 打标签：登录按钮点了没反应", checkLabel, 400, 10, 3_000),
  task("t2", "classify", "给 issue 打标签：能不能加个暗色模式", checkLabel, 400, 10, 3_000),
  task("t3", "summarize", "用一句话总结这个 PR 的改动", checkSummary, 1_500, 60, 800),
  task("t4", "rewrite_query", "把「上周那个缓存的问题」改写成检索词", checkQuery, 300, 20, 1_500),
  task("t5", "extract", "从这段堆栈里抽出出错的文件和行号", checkLocation, 800, 40, 400),
  task("t6", "code", "修复 useDebounce 在卸载后仍触发回调的问题", checkPatch, 3_000, 600, 60),
  task("t7", "plan", "规划把 webapp 的状态管理从 Redux 迁到 Zustand", checkPlan, 2_000, 400, 20),
  task("t8", "code", "修复 SSR 和客户端时区不一致导致的 hydration 报错", checkPatch, 6_000, 1_200, 20),
];

const GOOD_PLAN = JSON.stringify(
  [
    ["盘点 store 和 selector", "列表与代码 grep 结果一致"],
    ["新建 Zustand store 并双写", "两边状态快照一致"],
    ["逐页切换读路径", "页面 e2e 通过"],
    ["删除 Redux", "构建无引用、测试全绿"],
  ].map(([step, verify]) => ({ step, verify })),
);

// 每个任务的「好答案」和「差答案」；FAILS_ON 记录哪些模型在这个任务上会给差答案
const ANSWERS: Record<string, [string, string]> = {
  t1: ["bug", "这看起来像是一个 bug"],
  t2: ["feature", "feature"],
  t3: ["useDebounce 卸载时清理定时器", ""],
  t4: ["缓存 失效 排查", "上周那个缓存的问题"],
  t5: ['{"file": "src/api/client.ts", "line": 42}', '{"file": "src/api/client.ts", "line": "42"}'],
  t6: ['{"diff": "+ return () => clearTimeout(t)", "tests": "pass"}', '{"diff": "+ if (!mounted) return", "tests": "fail"}'],
  t7: [GOOD_PLAN, JSON.stringify([{ step: "换成 Zustand" }, { step: "删 Redux" }])],
  t8: ['{"diff": "+ const tz = useServerTimezone()", "tests": "pass"}', '{"diff": "+ suppressHydrationWarning", "tests": "fail"}'],
};
// 没列出的任务，三个模型都答对
const FAILS_ON: Record<string, string[]> = { t5: [HAIKU], t6: [HAIKU], t7: [HAIKU], t8: [HAIKU, SONNET] };

/** fake 模型：按 (任务, 模型) 查表回答，usage 用任务预设的 token 数。 */
export function scriptedClient(tasks: Task[] = TASKS): FakeAnthropic {
  const byPrompt = new Map(tasks.map((t) => [t.prompt, t]));
  const respond = (params: CreateParams): Step => {
    const t = byPrompt.get(params.messages[0].content as string)!;
    const [good, bad] = ANSWERS[t.id];
    const answer = (FAILS_ON[t.id] ?? []).includes(params.model) ? bad : good;
    return {
      content: [{ type: "text", text: answer }],
      stop_reason: "end_turn",
      usage: { input_tokens: t.inputTokens, output_tokens: t.outputTokens },
    };
  };
  return new FakeAnthropic(Array(100).fill(respond));
}

export interface Outcome {
  task: Task;
  attempts: string[]; // 依次用过的模型
  passed: boolean;
  usd: number; // 这条任务一次的总花费，失败的尝试也算在内
}
const escalated = (o: Outcome) => o.attempts.length > 1;

async function ask(client: LLMClient, model: string, t: Task, meter: CostMeter, tenant: string): Promise<[string, number]> {
  const resp = await client.messages.create({ model, max_tokens: 1024, messages: [{ role: "user", content: t.prompt }] });
  const usd = meter.add(model, resp.usage, { tenant });
  return [resp.content.map((b) => (b.type === "text" ? b.text : "")).join(""), usd];
}

export const routeRule = (t: Task) => RULES[t.kind];

/** 每个任务只问一次 pick(task) 选出的模型；校验只用来统计，不触发升级。 */
export async function runFixed(client: LLMClient, tasks: Task[], meter: CostMeter, pick: (t: Task) => string, { tenant = "default" } = {}) {
  const out: Outcome[] = [];
  for (const t of tasks) {
    const m = pick(t);
    const [answer, usd] = await ask(client, m, t, meter, tenant);
    out.push({ task: t, attempts: [m], passed: t.check(answer), usd });
  }
  return out;
}

/** 从 start(task) 选的那一档开始（默认最便宜的一档），校验不过就升级。失败那几次的钱也照算。 */
export async function runCascade(
  client: LLMClient,
  tasks: Task[],
  meter: CostMeter,
  { ladder = LADDER, start, tenant = "default" }: { ladder?: string[]; start?: (t: Task) => string; tenant?: string } = {},
) {
  const out: Outcome[] = [];
  for (const t of tasks) {
    const o: Outcome = { task: t, attempts: [], passed: false, usd: 0 };
    const first = start ? ladder.indexOf(start(t)) : 0;
    for (const m of ladder.slice(first)) {
      o.attempts.push(m);
      const [answer, usd] = await ask(client, m, t, meter, tenant);
      o.usd += usd;
      if (t.check(answer)) {
        o.passed = true;
        break;
      }
    }
    out.push(o);
  }
  return out;
}

export interface Summary {
  name: string;
  passed: number;
  total: number;
  dailyUsd: number;
  passRate: number;
  escalationRate: number;
}

/** 把每类任务的单次结果按日调用量加权，折算成一天的账。 */
export function summarize(name: string, outcomes: Outcome[]): Summary {
  const sum = (f: (o: Outcome) => number) => outcomes.reduce((s, o) => s + f(o), 0);
  const volume = sum((o) => o.task.daily);
  return {
    name,
    passed: sum((o) => (o.passed ? 1 : 0)),
    total: outcomes.length,
    dailyUsd: sum((o) => o.usd * o.task.daily),
    passRate: sum((o) => (o.passed ? o.task.daily : 0)) / volume,
    escalationRate: sum((o) => (escalated(o) ? o.task.daily : 0)) / volume,
  };
}

type Runner = (c: LLMClient, ts: Task[], m: CostMeter) => Promise<Outcome[]>;
export const STRATEGIES: [string, Runner][] = [
  ["全用 Opus", (c, ts, m) => runFixed(c, ts, m, () => OPUS)],
  ["全用 Haiku", (c, ts, m) => runFixed(c, ts, m, () => HAIKU)],
  ["规则路由", (c, ts, m) => runFixed(c, ts, m, routeRule)],
  ["级联路由", (c, ts, m) => runCascade(c, ts, m)],
  ["规则起步+级联", (c, ts, m) => runCascade(c, ts, m, { start: routeRule })],
];

export async function compare(tasks: Task[] = TASKS): Promise<Map<string, [Summary, Outcome[]]>> {
  const result = new Map<string, [Summary, Outcome[]]>();
  for (const [name, runner] of STRATEGIES) {
    const outcomes = await runner(scriptedClient(tasks), tasks, new CostMeter());
    result.set(name, [summarize(name, outcomes), outcomes]);
  }
  return result;
}

const pct = (x: number, digits: number) => `${(x * 100).toFixed(digits)}%`;

async function main() {
  const result = await compare();
  console.log("[离线 fake 模型] 级联路由逐条（任务 / 类型 / 每天调用量 / 依次用过的模型）：");
  for (const o of result.get("级联路由")![1]) {
    const trail = o.attempts.map((m) => SHORT[m]).join(" → ");
    console.log(`  ${o.task.id} ${ljust(o.task.kind, 14)}${o.task.daily.toLocaleString("en-US").padStart(6)}  ${ljust(trail, 24)}${o.passed ? "✔" : "✘"}`);
  }
  console.log();
  const base = result.get("全用 Opus")![0].dailyUsd;
  const cols: [string, number][] = [["任务通过", 9], ["按调用量通过率", 16], ["每天$", 9], ["相对全 Opus", 13], ["升级率", 8]];
  console.log(ljust("策略", 16) + cols.map(([h, w]) => rjust(h, w)).join(""));
  for (const [row] of result.values()) {
    const cells = [`${row.passed}/${row.total}`, pct(row.passRate, 1), row.dailyUsd.toFixed(2), pct(row.dailyUsd / base, 0), pct(row.escalationRate, 1)];
    console.log(ljust(row.name, 16) + cells.map((c, i) => rjust(c, cols[i][1])).join(""));
  }
}

if (import.meta.main) await main();
