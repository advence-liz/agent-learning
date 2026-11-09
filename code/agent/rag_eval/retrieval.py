"""RAG 评测（一）：只评检索，不调模型。复用 rag/ 的切块和检索，在同一个评测集上比较三种配置。

uv run python -m rag_eval.retrieval
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rag.rag import DOCS, Chunk, Index, chunk_markdown
from rag_eval.metrics import mean, precision_at_k, reciprocal_rank, recall_at_k

DATASET = Path(__file__).parent / "dataset.json"
K = 5  # 每题取前 5 名，R@1 / R@3 / R@5 都从这 5 名里截


def load_dataset(path: Path = DATASET) -> list[dict[str, Any]]:
    return json.loads(path.read_text())


# ---------- 三种待比较的配置：只有建索引的方式不同 ----------
def _chunks(max_chars: int = 200) -> list[Chunk]:
    return [c for p in sorted(DOCS.glob("*.md")) for c in chunk_markdown(p, max_chars)]


def build_configs() -> dict[str, Index]:
    return {
        "A 基线：200 字块 + 标题": Index(_chunks()),
        "B 去掉块标题": Index([Chunk(c.source, re.sub(r"^【.*?】", "", c.text)) for c in _chunks()]),
        "C 小块：40 字块 + 标题": Index(_chunks(40)),
    }


# ---------- 逐题评分 ----------
@dataclass
class Row:
    id: str
    tags: list[str]
    r1: float
    r3: float
    r5: float
    p3: float
    rr: float
    doc_r3: float  # 文档级标注：前 3 名里有没有出现目标文档（更宽松）
    top1: str


def score_case(index: Index, case: dict[str, Any]) -> Row:
    ranked = [c for _, c in index.search(case["question"], K)]
    gold = set(case["evidence"])
    # 一块覆盖了哪些证据片段：按文本包含判断，所以换切块方式不用重新标注
    hits = [{e for e in gold if e in c.text} for c in ranked]
    doc_hits = [{c.source.split("#")[0]} & set(case["gold_docs"]) for c in ranked]
    return Row(
        id=case["id"],
        tags=case["tags"],
        r1=recall_at_k(hits, gold, 1),
        r3=recall_at_k(hits, gold, 3),
        r5=recall_at_k(hits, gold, 5),
        p3=precision_at_k(hits, 3),
        rr=reciprocal_rank(hits),
        doc_r3=recall_at_k(doc_hits, set(case["gold_docs"]), 3),
        top1=ranked[0].text,
    )


def evaluate(index: Index, dataset: list[dict[str, Any]]) -> list[Row]:
    # 无答案题没有「该命中的块」，不参与检索指标；它留给生成环节评「会不会说不知道」
    return [score_case(index, c) for c in dataset if c["evidence"]]


def summarize(rows: list[Row]) -> dict[str, float]:
    return {f: mean([getattr(r, f) for r in rows]) for f in ("r1", "r3", "r5", "p3", "rr", "doc_r3")}


def paired_diff(base: list[Row], cand: list[Row], field: str = "rr") -> tuple[list[str], list[str]]:
    """同一批题逐题比：哪些题变差、哪些题变好。只看均值会把两者抵消掉。"""
    worse = [b.id for b, c in zip(base, cand) if getattr(c, field) < getattr(b, field)]
    better = [b.id for b, c in zip(base, cand) if getattr(c, field) > getattr(b, field)]
    return worse, better


def main() -> None:
    data = load_dataset()
    configs = build_configs()
    results = {name: evaluate(idx, data) for name, idx in configs.items()}
    n = len(next(iter(results.values())))
    print(f"评测集 {len(data)} 题：{n} 题参与检索指标，{len(data) - n} 题无答案（留给生成环节）\n")

    print(" R@1   R@3   R@5   P@3   MRR   文档级R@3  配置")
    for name, rows in results.items():
        s = summarize(rows)
        print(f"{s['r1']:.2f}  {s['r3']:.2f}  {s['r5']:.2f}  {s['p3']:.2f}  {s['rr']:.2f}  {s['doc_r3']:.2f}       {name}")

    print("\n按题型拆开看 R@3：")
    tags = sorted({t for r in results[next(iter(results))] for t in r.tags})
    for name, rows in results.items():
        parts = []
        for t in tags:
            sub = [r for r in rows if t in r.tags]
            parts.append(f"{t}({len(sub)}) {mean([r.r3 for r in sub]):.2f}")
        print(f"  {'  '.join(parts)}   {name}")

    base_name, *others = results
    base = results[base_name]
    print(f"\n逐题配对比较（以 {base_name[:1]} 为基线，看倒数排名 RR）：")
    for name in others:
        worse, better = paired_diff(base, results[name])
        print(f"  {name[:1]}：变差 {len(worse)} 题 {worse}；变好 {len(better)} 题 {better}")

    print(f"\n{base_name[:1]} 的第 1 名没命中证据的题（先读这些，再决定改哪里）：")
    for r in base:
        if r.rr < 1:
            print(f"  {r.id} RR={r.rr:.2f}  第 1 名：{r.top1[:30]}…")


if __name__ == "__main__":
    main()
