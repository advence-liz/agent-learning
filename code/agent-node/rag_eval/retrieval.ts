/**
 * RAG 评测（一）：只评检索，不调模型。复用 rag/ 的切块和检索，在同一个评测集上比较三种配置。
 *
 * node rag_eval/retrieval.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, Index, chunkMarkdown, type Chunk } from "../rag/rag.ts";
import { mean, precisionAtK, reciprocalRank, recallAtK } from "./metrics.ts";

export const DATASET = join(import.meta.dirname, "../../agent/rag_eval/dataset.json"); // 和 Python 版共用
const K = 5; // 每题取前 5 名，R@1 / R@3 / R@5 都从这 5 名里截

export interface Case {
  id: string;
  question: string;
  tags: string[];
  gold_docs: string[];
  evidence: string[];
  reference: string;
  key_facts: string[];
}

export function loadDataset(path: string = DATASET): Case[] {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------- 三种待比较的配置：只有建索引的方式不同 ----------
function chunks(maxChars = 200): Chunk[] {
  const files = readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort();
  return files.flatMap((f) => chunkMarkdown(join(DOCS, f), maxChars));
}

export function buildConfigs(): Record<string, Index> {
  return {
    "A 基线：200 字块 + 标题": new Index(chunks()),
    "B 去掉块标题": new Index(chunks().map((c) => ({ source: c.source, text: c.text.replace(/^【.*?】/, "") }))),
    "C 小块：40 字块 + 标题": new Index(chunks(40)),
  };
}

// ---------- 逐题评分 ----------
export interface Row {
  id: string;
  tags: string[];
  r1: number;
  r3: number;
  r5: number;
  p3: number;
  rr: number;
  docR3: number; // 文档级标注：前 3 名里有没有出现目标文档（更宽松）
  top1: string;
}

export function scoreCase(index: Index, c: Case): Row {
  const ranked = index.search(c.question, K).map(([, ch]) => ch);
  const gold = new Set(c.evidence);
  // 一块覆盖了哪些证据片段：按文本包含判断，所以换切块方式不用重新标注
  const hits = ranked.map((ch) => new Set(c.evidence.filter((e) => ch.text.includes(e))));
  const docHits = ranked.map((ch) => new Set([ch.source.split("#")[0]].filter((d) => c.gold_docs.includes(d))));
  return {
    id: c.id,
    tags: c.tags,
    r1: recallAtK(hits, gold, 1),
    r3: recallAtK(hits, gold, 3),
    r5: recallAtK(hits, gold, 5),
    p3: precisionAtK(hits, 3),
    rr: reciprocalRank(hits),
    docR3: recallAtK(docHits, new Set(c.gold_docs), 3),
    top1: ranked[0].text,
  };
}

export function evaluate(index: Index, dataset: Case[]): Row[] {
  // 无答案题没有「该命中的块」，不参与检索指标；它留给生成环节评「会不会说不知道」
  return dataset.filter((c) => c.evidence.length > 0).map((c) => scoreCase(index, c));
}

type Metric = "r1" | "r3" | "r5" | "p3" | "rr" | "docR3";

export function summarize(rows: Row[]): Record<Metric, number> {
  const m = (f: Metric) => mean(rows.map((r) => r[f]));
  return { r1: m("r1"), r3: m("r3"), r5: m("r5"), p3: m("p3"), rr: m("rr"), docR3: m("docR3") };
}

/** 同一批题逐题比：哪些题变差、哪些题变好。只看均值会把两者抵消掉。 */
export function pairedDiff(base: Row[], cand: Row[], field: Metric = "rr"): [string[], string[]] {
  const worse = base.filter((b, i) => cand[i][field] < b[field]).map((b) => b.id);
  const better = base.filter((b, i) => cand[i][field] > b[field]).map((b) => b.id);
  return [worse, better];
}

if (import.meta.main) {
  const data = loadDataset();
  const configs = buildConfigs();
  const results = Object.fromEntries(Object.entries(configs).map(([name, idx]) => [name, evaluate(idx, data)]));
  const names = Object.keys(results);
  const n = results[names[0]].length;
  console.log(`评测集 ${data.length} 题：${n} 题参与检索指标，${data.length - n} 题无答案（留给生成环节）\n`);

  const f = (x: number) => x.toFixed(2);
  console.log(" R@1   R@3   R@5   P@3   MRR   文档级R@3  配置");
  for (const [name, rows] of Object.entries(results)) {
    const s = summarize(rows);
    console.log(`${f(s.r1)}  ${f(s.r3)}  ${f(s.r5)}  ${f(s.p3)}  ${f(s.rr)}  ${f(s.docR3)}       ${name}`);
  }

  console.log("\n按题型拆开看 R@3：");
  const tags = [...new Set(results[names[0]].flatMap((r) => r.tags))].sort();
  for (const [name, rows] of Object.entries(results)) {
    const parts = tags.map((t) => {
      const sub = rows.filter((r) => r.tags.includes(t));
      return `${t}(${sub.length}) ${f(mean(sub.map((r) => r.r3)))}`;
    });
    console.log(`  ${parts.join("  ")}   ${name}`);
  }

  const [baseName, ...others] = names;
  const base = results[baseName];
  console.log(`\n逐题配对比较（以 ${baseName[0]} 为基线，看倒数排名 RR）：`);
  for (const name of others) {
    const [worse, better] = pairedDiff(base, results[name]);
    console.log(`  ${name[0]}：变差 ${worse.length} 题 ${JSON.stringify(worse)}；变好 ${better.length} 题 ${JSON.stringify(better)}`);
  }

  console.log(`\n${baseName[0]} 的第 1 名没命中证据的题（先读这些，再决定改哪里）：`);
  for (const r of base) {
    if (r.rr < 1) console.log(`  ${r.id} RR=${f(r.rr)}  第 1 名：${r.top1.slice(0, 30)}…`);
  }
}
