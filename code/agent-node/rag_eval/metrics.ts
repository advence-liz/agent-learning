/**
 * RAG 评测：检索指标。纯函数，不依赖检索器，也不依赖模型。
 *
 * 输入统一成 hits：按检索排名排好的列表，hits[i] 是第 i+1 名那一块「覆盖了哪些标注证据」。
 * 没覆盖任何证据的块，hits[i] 是空集合，也就是不相关。
 *
 * 这样同一套函数既能按「文档」标注用，也能按「证据片段」标注用，换切块方式也不用重标。
 */

export type Hits = ReadonlyArray<ReadonlySet<string>>;

/** 前 k 名一共覆盖了多少条标注证据。回答「该找的找全了没有」。 */
export function recallAtK(hits: Hits, gold: ReadonlySet<string>, k: number): number {
  if (gold.size === 0) throw new Error("没有标注证据的题（无答案题）不参与 recall 计算");
  const found = new Set<string>();
  for (const h of hits.slice(0, k)) for (const e of h) if (gold.has(e)) found.add(e);
  return found.size / gold.size;
}

/** 前 k 名里有几块是相关的。回答「塞进上下文的东西有多少是有用的」。 */
export function precisionAtK(hits: Hits, k: number): number {
  return hits.slice(0, k).filter((h) => h.size > 0).length / k;
}

/** 第一块相关的排在第几名，取倒数；一块都没有就是 0。对一批题取平均就是 MRR。 */
export function reciprocalRank(hits: Hits): number {
  const i = hits.findIndex((h) => h.size > 0);
  return i === -1 ? 0 : 1 / (i + 1);
}

/**
 * 二值相关度的 nDCG：排名越靠后的相关块，打的折扣越大（除以 log2(名次+1)）。
 * nRelevant 是语料里一共有几块相关，用来算「理想排序」能拿多少分。
 */
export function ndcgAtK(hits: Hits, nRelevant: number, k: number): number {
  let dcg = 0;
  hits.slice(0, k).forEach((h, i) => {
    if (h.size > 0) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(k, nRelevant); i++) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
