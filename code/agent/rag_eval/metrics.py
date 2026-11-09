"""RAG 评测：检索指标。纯函数，不依赖检索器，也不依赖模型。

输入统一成 hits：按检索排名排好的列表，hits[i] 是第 i+1 名那一块「覆盖了哪些标注证据」。
没覆盖任何证据的块，hits[i] 是空集合，也就是不相关。

这样同一套函数既能按「文档」标注用，也能按「证据片段」标注用，换切块方式也不用重标。
"""

from __future__ import annotations

import math
from collections.abc import Sequence

Hits = Sequence[set[str]]


def recall_at_k(hits: Hits, gold: set[str], k: int) -> float:
    """前 k 名一共覆盖了多少条标注证据。回答「该找的找全了没有」。"""
    if not gold:
        raise ValueError("没有标注证据的题（无答案题）不参与 recall 计算")
    found = set().union(*hits[:k]) & gold
    return len(found) / len(gold)


def precision_at_k(hits: Hits, k: int) -> float:
    """前 k 名里有几块是相关的。回答「塞进上下文的东西有多少是有用的」。"""
    return sum(1 for h in hits[:k] if h) / k


def reciprocal_rank(hits: Hits) -> float:
    """第一块相关的排在第几名，取倒数；一块都没有就是 0。对一批题取平均就是 MRR。"""
    for i, h in enumerate(hits):
        if h:
            return 1 / (i + 1)
    return 0.0


def ndcg_at_k(hits: Hits, n_relevant: int, k: int) -> float:
    """二值相关度的 nDCG：排名越靠后的相关块，打的折扣越大（除以 log2(名次+1)）。

    n_relevant 是语料里一共有几块相关，用来算「理想排序」能拿多少分。
    """
    dcg = sum(1 / math.log2(i + 2) for i, h in enumerate(hits[:k]) if h)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(k, n_relevant)))
    return dcg / idcg if idcg else 0.0


def mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0
