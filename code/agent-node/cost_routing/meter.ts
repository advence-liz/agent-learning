/**
 * 补充章「成本控制与模型路由」：按 usage 记账的 CostMeter + 预算。
 *
 * 一次响应的钱 = 四种 token 各乘各的单价：
 *   input_tokens                 × 输入价
 *   cache_creation_input_tokens  × 输入价 × 1.25（5 分钟 TTL）或 × 2（1 小时 TTL）
 *   cache_read_input_tokens      × 缓存读价（多数模型 0.1× 输入价，Opus 5.5 / Sonnet 5.5 是 0.05×）
 *   output_tokens                × 输出价（思考 token 也按输出计）
 * 走 Batch API 时以上全部再打五折。
 *
 * 只做计算，不发请求：cost_routing/ledger.ts、router.ts、budget.ts 里有演示。
 */

// ---------------------------------------------------------------------------
// 价格表（美元 / 百万 token，第一方 API 标价）
// 来源：官方定价页 https://platform.claude.com/docs/en/about-claude/pricing（2026-11-09 查）。
//   合作方渠道（Bedrock / Vertex）另计价。
// cache_read：Opus 5.5、Sonnet 5.5 是输入价的 0.05×（$0.20、$0.10），Haiku 5.5 是 0.1×（$0.01）。
//   注意 claude-api skill 的模型表（cached: 2026-10-06）把 Sonnet 5.5 写成 $0.20，以定价页为准。
// Haiku 5.5 的 $0.10 / $0.50 / 读 $0.01 只适用于 ≤100K token 的提示，超过后是 $0.50 / $2.50 / 读 $0.05。
// ---------------------------------------------------------------------------
export const PRICES_AS_OF = "2026-11-09";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  longThreshold?: number; // 提示（三种输入之和）超过这个数就换成下面的长上下文价
  longInput?: number;
  longOutput?: number;
  longCacheRead?: number;
}

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.1 },
  "claude-haiku-5-5": {
    input: 0.1, output: 0.5, cacheRead: 0.01,
    longThreshold: 100_000, longInput: 0.5, longOutput: 2.5, longCacheRead: 0.05,
  },
};
export const CACHE_WRITE_5M = 1.25; // 5 分钟 TTL 写入 = 1.25× 输入价
export const CACHE_WRITE_1H = 2.0; // 1 小时 TTL 写入 = 2× 输入价
export const BATCH_DISCOUNT = 0.5; // Batch API：所有 token（含缓存读写）五折

export interface Tokens {
  input: number;
  write5m: number;
  write1h: number;
  cacheRead: number;
  output: number;
}

export const tokens = (t: Partial<Tokens>): Tokens => ({ input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 0, ...t });

/** 模型实际读到的输入总量：三项相加（input_tokens 只是最后一个断点之后的尾巴）。 */
export const promptOf = (t: Tokens) => t.input + t.write5m + t.write1h + t.cacheRead;

/** SDK 的 Usage 里这几个字段都可能是 null（没开缓存时）。 */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

const isTokens = (u: UsageLike | Tokens): u is Tokens => "write5m" in u;

/** 吃 SDK 的 Usage。没有 TTL 拆分（cache_creation）时，写入一律按 5 分钟算。 */
export function normalizeUsage(u: UsageLike | Tokens): Tokens {
  if (isTokens(u)) return u;
  const created = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  return {
    input: u.input_tokens ?? 0,
    write5m: split ? split.ephemeral_5m_input_tokens ?? 0 : created,
    write1h: split ? split.ephemeral_1h_input_tokens ?? 0 : 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

export function costUsd(model: string, usage: UsageLike | Tokens, { batch = false } = {}): number {
  const p = PRICES[model];
  if (!p) throw new Error(`价格表里没有 ${model}：宁可报错，也别按 0 元记账`);
  const t = normalizeUsage(usage);
  const long = p.longThreshold !== undefined && promptOf(t) > p.longThreshold;
  const [inp, out, read] = long ? [p.longInput!, p.longOutput!, p.longCacheRead!] : [p.input, p.output, p.cacheRead];
  const usd =
    (t.input * inp + t.write5m * inp * CACHE_WRITE_5M + t.write1h * inp * CACHE_WRITE_1H + t.cacheRead * read + t.output * out) /
    1_000_000;
  return batch ? usd * BATCH_DISCOUNT : usd;
}

export interface CostRecord {
  model: string;
  tenant: string;
  tokens: Tokens;
  usd: number;
}

/** 每次响应调一次 add()。按模型、按租户（用户 / 团队）汇总。 */
export class CostMeter {
  records: CostRecord[] = [];

  add(model: string, usage: UsageLike | Tokens, { tenant = "default", batch = false } = {}): number {
    const t = normalizeUsage(usage);
    const usd = costUsd(model, t, { batch });
    this.records.push({ model, tenant, tokens: t, usd });
    return usd;
  }

  spent(tenant?: string): number {
    return this.records.filter((r) => tenant === undefined || r.tenant === tenant).reduce((s, r) => s + r.usd, 0);
  }

  by(key: "model" | "tenant"): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.records) out[r[key]] = (out[r[key]] ?? 0) + r.usd;
    return out;
  }
}

export type Verdict = "ok" | "soft" | "hard";

/** 软上限：到了就不再开新一圈，收口总结；硬上限：连收口都可能超，就直接停。 */
export class Budget {
  softUsd: number;
  hardUsd: number;
  constructor(softUsd: number, hardUsd: number) {
    this.softUsd = softUsd;
    this.hardUsd = hardUsd;
  }

  check(spent: number, nextWorstUsd: number): Verdict {
    if (spent + nextWorstUsd > this.hardUsd) return "hard";
    if (spent >= this.softUsd) return "soft";
    return "ok";
  }
}

/** 下一次请求最坏花多少：上一次的输入总量 + 新增内容全按未缓存输入价，输出顶满 max_tokens。 */
export function worstCaseNextUsd(model: string, last: Tokens | null, maxTokens: number, extraInput = 0): number {
  const prompt = (last ? promptOf(last) + last.output : 0) + extraInput;
  return costUsd(model, tokens({ input: prompt, output: maxTokens }));
}

const width = (s: string) => [...s].reduce((w, ch) => w + (ch.codePointAt(0)! > 0x2e7f ? 2 : 1), 0);
/** 按终端显示宽度对齐（中文占两格），只给演示打印表格用。 */
export const ljust = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));
export const rjust = (s: string, w: number) => " ".repeat(Math.max(0, w - width(s))) + s;
