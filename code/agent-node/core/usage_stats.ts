/**
 * 第 3 章：从 Claude Code 会话 jsonl 里只读地统计 token 与费用。
 *
 * 只读取每条 assistant 记录的 message.model / message.id / message.usage，**不读、不打印任何会话正文**。
 *
 * 用法：
 *     node core/usage_stats.ts                       # 默认：~/.claude/projects 下最大的那个会话
 *     node core/usage_stats.ts <a.jsonl> [b.jsonl…]  # 指定会话文件（可多个，例如连同 subagents/*.jsonl）
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Price {
  input: number;
  output: number;
  cache_read: number;
}

// 单位：美元 / 百万 token。来源：claude-api skill「Current Models」表（cached: 2026-10-06），第一方 API 标价。
// cache_read 一列：Opus 5.5 / Sonnet 5.5 的 $0.20 是 skill 里写明的；其余按 skill 的一般规则「≈0.1× 输入价」推算，标 *。
// 缓存写入：5 分钟 TTL = 1.25× 输入价，1 小时 TTL = 2× 输入价（skill: shared/prompt-caching.md）。
export const PRICES: Record<string, Price> = {
  "claude-opus-5-5":   { input: 4.0, output: 20.0, cache_read: 0.2 },
  "claude-opus-5":     { input: 5.0, output: 25.0, cache_read: 0.5 },   // *
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cache_read: 0.2 },
  "claude-haiku-5-5":  { input: 0.1, output: 0.5,  cache_read: 0.01 },  // * 且只适用于 ≤100K 的提示
};
export const PRICE_DATE = "2026-10-06";
const WRITE_5M = 1.25;
const WRITE_1H = 2.0;

/** jsonl 里 message.usage 的形状（只列我们用到的字段）。 */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
}

export class Totals {
  requests = 0;
  input = 0; //      最后一个缓存断点之后、没走缓存的输入
  cacheRead = 0; //  命中缓存的前缀
  write5m = 0; //    本次新写入缓存（5 分钟 TTL）
  write1h = 0; //    本次新写入缓存（1 小时 TTL）
  output = 0;

  add(u: Usage): void {
    this.requests += 1;
    this.input += u.input_tokens ?? 0;
    this.cacheRead += u.cache_read_input_tokens ?? 0;
    this.output += u.output_tokens ?? 0;
    const created = u.cache_creation_input_tokens ?? 0;
    const split = u.cache_creation ?? {};
    let w1h = split.ephemeral_1h_input_tokens ?? 0;
    let w5m = split.ephemeral_5m_input_tokens ?? 0;
    if (w1h + w5m !== created) {
      // 老记录没有拆分字段：按默认的 5 分钟 TTL 算
      [w5m, w1h] = [created, 0];
    }
    this.write5m += w5m;
    this.write1h += w1h;
  }

  /** 模型这一轮真正「看到」的输入总量 */
  get prompt(): number {
    return this.input + this.cacheRead + this.write5m + this.write1h;
  }

  get hitRate(): number {
    return this.prompt ? this.cacheRead / this.prompt : 0;
  }

  cost(p: Price): number {
    return (
      (this.input * p.input + this.cacheRead * p.cache_read +
        this.write5m * p.input * WRITE_5M + this.write1h * p.input * WRITE_1H +
        this.output * p.output) / 1e6
    );
  }

  /** 反事实：同样的输入全部按普通输入价计。 */
  costWithoutCache(p: Price): number {
    return (this.prompt * p.input + this.output * p.output) / 1e6;
  }
}

export interface Report {
  byModel: Map<string, Totals>;
  skippedLines: number;
  duplicateLines: number;
}

export function scan(paths: string[]): Report {
  const rep: Report = { byModel: new Map(), skippedLines: 0, duplicateLines: 0 };
  const seen = new Set<string>();
  for (const path of paths) {
    const lines = readFileSync(path, "utf-8").split("\n");
    if (lines.at(-1) === "") lines.pop(); // 文件以换行结尾时，split 会多出一个空串
    for (const line of lines) {
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        rep.skippedLines += 1;
        continue;
      }
      const msg = rec?.message;
      if (rec?.type !== "assistant" || typeof msg !== "object" || msg === null || !("usage" in msg)) continue;
      const model: string = msg.model || "unknown";
      if (model === "<synthetic>") continue; // Claude Code 本地合成的消息，没打 API
      // 一次 API 响应会按 content block 拆成多行写进 jsonl，每行带同一份 usage → 按 message.id 去重
      const mid: string | undefined = msg.id;
      if (mid && seen.has(mid)) {
        rep.duplicateLines += 1;
        continue;
      }
      if (mid) seen.add(mid);
      if (!rep.byModel.has(model)) rep.byModel.set(model, new Totals());
      rep.byModel.get(model)!.add(msg.usage);
    }
  }
  return rep;
}

/** proj 下所有 <项目目录>/<会话>.jsonl 里最大的那个（对应 Python 的 proj.glob("*\/*.jsonl")）。 */
export function defaultSession(proj = join(homedir(), ".claude/projects")): string {
  const files: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(proj);
  } catch {
    // 目录不存在就当没有会话
  }
  for (const d of dirs) {
    const dir = join(proj, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".jsonl") && statSync(join(dir, f)).isFile()) files.push(join(dir, f));
  }
  if (!files.length) throw new Error(`在 ${proj} 下没找到会话 jsonl，请显式传路径`);
  return files.sort((a, b) => statSync(b).size - statSync(a).size)[0];
}

// ---------- 打印用的小工具（对应 Python 的 f-string 格式说明符） ----------
const comma = (n: number, w: number) => n.toLocaleString("en-US").padStart(w); // {:w,d}
const pct = (x: number, w: number) => `${(x * 100).toFixed(1)}%`.padStart(w); //  {:w.1%}

export function render(rep: Report): string {
  const lines = [`价格表：claude-api skill，第一方 API 标价，cached ${PRICE_DATE}（Vertex 等合作方渠道另计价）`];
  const hdr =
    "model".padEnd(18) + "请求".padStart(7) + "未缓存输入".padStart(12) + "缓存读".padStart(14) + "写5m".padStart(11) +
    "写1h".padStart(12) + "输出".padStart(11) + "命中率".padStart(8) + "实际$".padStart(10) + "无缓存$".padStart(10);
  lines.push(hdr);
  const grand = [0, 0];
  for (const [model, t] of [...rep.byModel].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const p = PRICES[model];
    const cost = p ? t.cost(p).toFixed(2).padStart(10) : "无价目".padStart(10);
    const nocache = p ? t.costWithoutCache(p).toFixed(2).padStart(10) : "-".padStart(10);
    if (p) {
      grand[0] += t.cost(p);
      grand[1] += t.costWithoutCache(p);
    }
    lines.push(
      model.padEnd(18) + String(t.requests).padStart(7) + comma(t.input, 12) + comma(t.cacheRead, 14) +
        comma(t.write5m, 11) + comma(t.write1h, 12) + comma(t.output, 11) + pct(t.hitRate, 8) + cost + nocache,
    );
  }
  lines.push(
    `合计（有价目的模型）：实际 ≈ $${grand[0].toFixed(2)}，若无缓存 ≈ $${grand[1].toFixed(2)}` +
      (grand[1] ? `，缓存省了 ${((1 - grand[0] / grand[1]) * 100).toFixed(1)}%` : ""),
  );
  lines.push(`去重掉的重复行：${rep.duplicateLines}；解析失败行：${rep.skippedLines}`);
  return lines.join("\n");
}

if (import.meta.main) {
  let paths = process.argv.slice(2);
  if (!paths.length) {
    try {
      paths = [defaultSession()];
    } catch (e) {
      console.error((e as Error).message); // 对应 Python 的 SystemExit(消息)：打印并以 1 退出
      process.exit(1);
    }
  }
  const rep = scan(paths);
  console.log(`扫描 ${paths.length} 个文件（只读 usage 字段）`);
  console.log(render(rep));
}
