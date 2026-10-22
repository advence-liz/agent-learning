/**
 * 第 3 章：最小 RAG —— 切块 → 向量化 → 检索 → 拼 prompt → 让模型照资料回答。
 *
 * 向量化用普通数组的「字符 n-gram + 哈希 + TF-IDF」，完全离线，不下载任何模型。
 * 它是**词面**相似度（共享了哪些字），不是语义相似度——第 4 章会专门拿它和真 embedding 对比。
 *
 * 离线演示： node rag/rag.ts --fake "会员多少钱？"
 * 真实运行： node rag/rag.ts "会员多少钱？"
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { crc32 } from "node:zlib";
import { makeClient, text, type FakeAnthropic, type LLMClient } from "../fake_llm/index.ts";

export const MODEL = "claude-opus-5-5";
export const DOCS = join(import.meta.dirname, "../../agent/rag/docs"); // 和 Python 版共用同一份资料
export const DIM = 2 ** 14; // 哈希桶数；越大冲突越少

// ---------- 1. 切块 ----------
export interface Chunk {
  source: string; // 文件名#标题
  text: string;
}

/** 按空行分段；过长的段再按句号硬切。每块带上文档标题，避免「这一段在说谁」丢失。 */
export function chunkMarkdown(path: string, maxChars = 200): Chunk[] {
  const raw = readFileSync(path, "utf8");
  const title = raw.split("\n")[0].replace(/^[# ]+/, "").trim();
  const source = `${basename(path)}#${title}`;
  const chunks: Chunk[] = [];
  for (let para of raw.split(/\n\s*\n/)) {
    para = para.trim();
    if (!para || para.startsWith("#")) continue;
    let buf = "";
    for (const sent of para.split(/(?<=[。！？])/)) {
      if (buf.length + sent.length > maxChars && buf) {
        chunks.push({ source, text: `【${title}】${buf}` });
        buf = "";
      }
      buf += sent;
    }
    if (buf) chunks.push({ source, text: `【${title}】${buf}` });
  }
  return chunks;
}

// ---------- 2. 向量化 ----------
/** 中文没有空格分词：直接取字符 1-gram 和 2-gram；英文/数字按词切。 */
function ngrams(s: string): string[] {
  s = s.toLowerCase();
  const grams: string[] = s.match(/[a-z0-9]+/g) ?? [];
  const han = s.replace(/[^一-鿿]/g, " ");
  for (const seg of han.split(/\s+/).filter(Boolean)) {
    grams.push(...seg);
    for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2));
  }
  return grams;
}

const hash = (g: string): number => crc32(g) % DIM; // crc32 跨进程稳定，和 Python 版 zlib.crc32 结果一致

/** 一个向量就是一个定长数字数组（numpy 的一维 ndarray 在这里用 Float64Array 代替）。 */
export type Vector = Float64Array;

export function dot(a: Vector, b: Vector): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class HashingTfidf {
  idf: Vector = new Float64Array(DIM);

  fit(texts: string[]): this {
    const df = new Float64Array(DIM);
    for (const t of texts) {
      for (const h of new Set(ngrams(t).map(hash))) df[h] += 1;
    }
    const n = texts.length;
    // 越多文档都有的字，权重越低（「的」「是」）
    for (let h = 0; h < DIM; h++) this.idf[h] = Math.log((1 + n) / (1 + df[h])) + 1;
    return this;
  }

  transform(texts: string[]): Vector[] {
    return texts.map((t) => {
      const v = new Float64Array(DIM);
      for (const g of ngrams(t)) v[hash(g)] += 1;
      for (let h = 0; h < DIM; h++) v[h] = Math.log1p(v[h]) * this.idf[h];
      const norm = Math.sqrt(dot(v, v)) + 1e-12;
      return v.map((x) => x / norm); // L2 归一化 → 点积即余弦
    });
  }
}

// ---------- 3. 检索 ----------
export type Hit = [score: number, chunk: Chunk];

export class Index {
  chunks: Chunk[];
  vec: HashingTfidf;
  matrix: Vector[];

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.vec = new HashingTfidf().fit(chunks.map((c) => c.text));
    this.matrix = this.vec.transform(chunks.map((c) => c.text));
  }

  static fromDir(d: string = DOCS): Index {
    const files = readdirSync(d).filter((f) => f.endsWith(".md")).sort();
    return new Index(files.flatMap((f) => chunkMarkdown(join(d, f))));
  }

  search(query: string, k = 3): Hit[] {
    const q = this.vec.transform([query])[0];
    const scores = this.matrix.map((row) => dot(row, q)); // 相当于 numpy 的 matrix @ q
    const top = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]).slice(0, k);
    return top.map((i) => [scores[i], this.chunks[i]]);
  }
}

// ---------- 4. 拼 prompt + 生成 ----------
export const SYSTEM =
  "你是「闪记」的客服。只根据 <docs> 里的资料回答，并在句末用 [编号] 标注出处。" +
  "资料里没有的信息，直接说「资料中没有相关说明」，不要猜。";

export function buildPrompt(question: string, hits: Hit[]): string {
  const docs = hits.map(([, c], i) => `<doc id="${i + 1}" source="${c.source}">${c.text}</doc>`).join("\n");
  return `<docs>\n${docs}\n</docs>\n\n问题：${question}`;
}

export async function answer(client: LLMClient, index: Index, question: string, k = 3): Promise<[string, Hit[]]> {
  const hits = index.search(question, k);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(question, hits) }],
  });
  return [resp.content.map((b) => (b.type === "text" ? b.text : "")).join(""), hits];
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => a !== "--fake");
  const q = args[0] ?? "会员多少钱？学生有优惠吗？";
  const index = Index.fromDir();
  console.log(`共 ${index.chunks.length} 个块，向量维度 ${DIM}`);
  const fake = process.argv.includes("--fake");
  const client = await makeClient(
    fake ? [text("Pro 会员月付 39 元、年付 299 元 [1]；学生认证后年付可享五折 [2]。")] : undefined,
  );
  const [reply, hits] = await answer(client, index, q);
  console.log(`\n问题：${q}\n检索结果：`);
  for (const [s, c] of hits) console.log(`  ${s.toFixed(3)}  ${c.source.padEnd(28)}  ${c.text.slice(0, 40)}…`);
  if (fake) {
    console.log("\n---- 发给模型的 user 消息 ----");
    console.log((client as FakeAnthropic).calls[0].messages[0].content);
  }
  console.log(`\n回答${fake ? "（离线 fake 模型）" : ""}：${reply}`);
}
