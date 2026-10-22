/**
 * 第 4 章实验：词面检索（我们的 TF-IDF）在哪些地方赢、在哪些地方输。
 *
 * node rag/experiments.ts
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DOCS, Index, chunkMarkdown } from "./rag.ts";

function show(idx: Index, q: string, k = 2): void {
  console.log(`  Q: ${q}`);
  for (const [s, c] of idx.search(q, k)) console.log(`     ${s.toFixed(3)}  ${c.source.padEnd(24)} ${c.text.slice(0, 28)}…`);
}

function exp1TitlePrefix(): void {
  console.log("实验 1：给每块加不加文档标题（上下文补全）");
  const withTitle = Index.fromDir();
  const files = readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort();
  const raw = files.flatMap((f) => chunkMarkdown(join(DOCS, f)));
  const noTitle = new Index(raw.map((c) => ({ source: c.source, text: c.text.replace(/^【.*?】/, "") })));
  for (const [name, idx] of [["加标题", withTitle], ["不加标题", noTitle]] as const) {
    console.log(` [${name}]`);
    show(idx, "具体价格是多少");
  }
}

function exp2Paraphrase(): void {
  console.log("\n实验 2：换个说法（同义改写，几乎不共享字）");
  const idx = Index.fromDir();
  show(idx, "忘记密码怎么办"); // 和原文共享「忘记」「密码」
  show(idx, "登不上去了口令想不起来"); // 意思一样，但几乎没有共同的字
}

export const CODE: Record<string, string> = {
  "src/store/recording.ts": "export const useRecordingStore = create((set) => ({ recordings: [], add: (r) => set(...) }))",
  "src/hooks/useRecorder.ts": "export function useRecorder() { const store = useRecordingStore(); return store.add }",
  "src/pages/Home.tsx": "function Home() { const recs = useRecordStore(); return <List items={recs} /> }",
  "src/utils/record.ts": "export function recordEvent(name: string) { analytics.capture(name) }",
};

function exp3CodeIdentifiers(): void {
  console.log("\n实验 3：在代码里找 `useRecordingStore` 的所有引用");
  const hits = Object.entries(CODE).filter(([, src]) => /\buseRecordingStore\b/.test(src)).map(([p]) => p);
  console.log(`  grep -w: ${JSON.stringify(hits)}`);
  // 真实 embedding 模型用子词（subword）切分标识符，这里用驼峰拆分模拟：
  // useRecordingStore → use recording store
  const subwords = (s: string) => s.replace(/(?<=[a-z])(?=[A-Z])/g, " ");

  const idx = new Index(Object.entries(CODE).map(([p, src]) => ({ source: p, text: subwords(src) })));
  console.log("  向量检索（子词切分）top-4：");
  for (const [s, c] of idx.search(subwords("useRecordingStore"), 4)) console.log(`     ${s.toFixed(3)}  ${c.source}`);
}

if (import.meta.main) {
  exp1TitlePrefix();
  exp2Paraphrase();
  exp3CodeIdentifiers();
}
