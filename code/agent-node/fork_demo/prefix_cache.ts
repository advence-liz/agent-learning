#!/usr/bin/env node
/**
 * 用一个「前缀缓存模拟器」解释 Fork 为什么必须原样继承父会话。
 *
 * Prompt Cache 的规则（Anthropic 文档）：
 *   - 请求按 tools → system → messages 的顺序渲染；
 *   - 缓存按「前缀」精确匹配：某处变了，它之后的全部要重算；
 *   - 改 tool 定义会让三层全部失效。
 *
 * 模拟器：把请求拆成 block 序列，每个 block 边界算一个累计 hash 存进 cache；
 * 新请求从头比对，命中的最长前缀算 cache_read，剩下的算 uncached。
 * token 数用「字符数 / 4」粗估，只看相对大小。
 *
 * 运行：node fork_demo/prefix_cache.ts
 */

import { createHash } from "node:crypto";

type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
type Msg = { role: string; content: string };

export const TOOLS: Tool[] = [
  { name: "Bash", description: "run shell", input_schema: { type: "object" } },
  { name: "Read", description: "read file", input_schema: { type: "object" } },
  { name: "Edit", description: "edit file", input_schema: { type: "object" } },
  { name: "Agent", description: "spawn subagent", input_schema: { type: "object" } },
];
export const SYSTEM = "You are Claude Code. " + "（系统提示词与工具说明占位文本）".repeat(400);

/** 键排序后的 JSON（对应 Python 的 json.dumps(sort_keys=True)），保证同一个对象永远渲染成同一串。 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function blocksOf(tools: Tool[], system: string, messages: Msg[]): string[] {
  return [stableJson(tools), system, ...messages.map(stableJson)];
}

export function tok(s: string): number {
  return Math.max(1, Math.floor(s.length / 4));
}

export type CacheResult = { cache_read: number; uncached: number; total: number };

export class PrefixCache {
  entries = new Set<string>();

  send(tools: Tool[], system: string, messages: Msg[]): CacheResult {
    const h = createHash("sha256");
    let read = 0;
    let matched = true;
    let total = 0;
    for (const b of blocksOf(tools, system, messages)) {
      h.update(b);
      const d = h.copy().digest("hex"); // digest() 会结束 hash，所以先 copy() 一份再取累计值
      total += tok(b);
      if (matched && this.entries.has(d)) {
        read = total;
      } else {
        matched = false;
      }
      this.entries.add(d); // 写入（真实 API 只在 cache_control 断点写；这里每个边界都写，简化）
    }
    return { cache_read: read, uncached: total - read, total };
  }
}

export function mainHistory(): Msg[] {
  const msgs: Msg[] = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: "user", content: `第 ${i} 轮：讨论 webapp 卡片协议的细节 ` + "…".repeat(300) });
    msgs.push({ role: "assistant", content: `第 ${i} 轮回答 ` + "…".repeat(600) });
  }
  return msgs;
}

export function run(): Array<[string, CacheResult]> {
  const cache = new PrefixCache();
  const hist = mainHistory();
  const rows: Array<[string, CacheResult]> = [];
  rows.push(["主会话第 N 轮（预热）", cache.send(TOOLS, SYSTEM, hist)]);
  const task = { role: "user", content: "<fork 指令> 基于上面的讨论，起草单测，完成后只回报结论" };
  rows.push(["Fork：同 tools/system/历史 + 追加任务", cache.send(TOOLS, SYSTEM, [...hist, task])]);
  const noBash = TOOLS.filter((t) => t.name !== "Bash");
  rows.push(["Fork 但删掉 Bash 工具定义", cache.send(noBash, SYSTEM, [...hist, task])]);
  rows.push(["Fork 但改了 system prompt", cache.send(TOOLS, SYSTEM + "\n只读模式。", [...hist, task])]);
  const subSys = "You are an Explore subagent.";
  rows.push([
    "全新 Sub Agent（自己的 system+tools，空历史）",
    cache.send([TOOLS[1]], subSys, [{ role: "user", content: "找出 exit 2 的处理位置" }]),
  ]);
  const btw = { role: "user", content: "<side question> 刚才那个配置文件叫什么？" };
  rows.push(["/btw：同前缀 + 追加问题（推测实现）", cache.send(TOOLS, SYSTEM, [...hist, btw])]);
  return rows;
}

if (import.meta.main) {
  console.log(`${"场景".padEnd(42)}${"cache_read".padStart(11)}${"uncached".padStart(10)}${"命中率".padStart(8)}`);
  for (const [name, r] of run()) {
    const rate = `${((r.cache_read / r.total) * 100).toFixed(1)}%`;
    console.log(`${name.padEnd(42)}${String(r.cache_read).padStart(11)}${String(r.uncached).padStart(10)}${rate.padStart(8)}`);
  }
}
