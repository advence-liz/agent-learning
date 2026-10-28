"""第 3 章：最小 RAG —— 切块 → 向量化 → 检索 → 拼 prompt → 让模型照资料回答。

向量化用纯 numpy 的「字符 n-gram + 哈希 + TF-IDF」，完全离线，不下载任何模型。
它是**词面**相似度（共享了哪些字），不是语义相似度——第 4 章会专门拿它和真 embedding 对比。

离线演示： uv run python -m rag.rag --fake "会员多少钱？"
真实运行： uv run python -m rag.rag "会员多少钱？"
"""

from __future__ import annotations

import re
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

MODEL = "claude-opus-5-5"
DOCS = Path(__file__).parent / "docs"
DIM = 2**14  # 哈希桶数；越大冲突越少


# ---------- 1. 切块 ----------
@dataclass
class Chunk:
    source: str  # 文件名#标题
    text: str


def chunk_markdown(path: Path, max_chars: int = 200) -> list[Chunk]:
    """按空行分段；过长的段再按句号硬切。每块带上文档标题，避免「这一段在说谁」丢失。"""
    raw = path.read_text()
    title = raw.splitlines()[0].lstrip("# ").strip()
    chunks: list[Chunk] = []
    for para in re.split(r"\n\s*\n", raw):
        para = para.strip()
        if not para or para.startswith("#"):
            continue
        buf = ""
        for sent in re.split(r"(?<=[。！？])", para):
            if len(buf) + len(sent) > max_chars and buf:
                chunks.append(Chunk(f"{path.name}#{title}", f"【{title}】{buf}"))
                buf = ""
            buf += sent
        if buf:
            chunks.append(Chunk(f"{path.name}#{title}", f"【{title}】{buf}"))
    return chunks


# ---------- 2. 向量化 ----------
def _ngrams(text: str) -> list[str]:
    """中文没有空格分词：直接取字符 1-gram 和 2-gram；英文/数字按词切。"""
    text = text.lower()
    grams: list[str] = re.findall(r"[a-z0-9]+", text)
    han = re.sub(r"[^一-鿿]", " ", text)
    for seg in han.split():
        grams += list(seg)
        grams += [seg[i : i + 2] for i in range(len(seg) - 1)]
    return grams


def _hash(g: str) -> int:
    return zlib.crc32(g.encode()) % DIM  # crc32 跨进程稳定（内置 hash() 每次启动会变）


class HashingTfidf:
    def fit(self, texts: list[str]) -> "HashingTfidf":
        df = np.zeros(DIM)
        for t in texts:
            for h in {_hash(g) for g in _ngrams(t)}:
                df[h] += 1
        n = len(texts)
        self.idf = np.log((1 + n) / (1 + df)) + 1  # 越多文档都有的字，权重越低（「的」「是」）
        return self

    def transform(self, texts: list[str]) -> np.ndarray:
        m = np.zeros((len(texts), DIM))
        for i, t in enumerate(texts):
            for g in _ngrams(t):
                m[i, _hash(g)] += 1
        m = np.log1p(m) * self.idf
        return m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-12)  # L2 归一化 → 点积即余弦


# ---------- 3. 检索 ----------
class Index:
    def __init__(self, chunks: list[Chunk]):
        self.chunks = chunks
        self.vec = HashingTfidf().fit([c.text for c in chunks])
        self.matrix = self.vec.transform([c.text for c in chunks])

    @classmethod
    def from_dir(cls, d: Path = DOCS) -> "Index":
        return cls([c for p in sorted(d.glob("*.md")) for c in chunk_markdown(p)])

    def search(self, query: str, k: int = 3) -> list[tuple[float, Chunk]]:
        q = self.vec.transform([query])[0]
        scores = self.matrix @ q
        top = np.argsort(-scores)[:k]
        return [(float(scores[i]), self.chunks[i]) for i in top]


# ---------- 4. 拼 prompt + 生成 ----------
SYSTEM = (
    "你是「拾光相册」的客服。只根据 <docs> 里的资料回答，并在句末用 [编号] 标注出处。"
    "资料里没有的信息，直接说「资料中没有相关说明」，不要猜。"
)


def build_prompt(question: str, hits: list[tuple[float, Chunk]]) -> str:
    docs = "\n".join(f'<doc id="{i}" source="{c.source}">{c.text}</doc>' for i, (_, c) in enumerate(hits, 1))
    return f"<docs>\n{docs}\n</docs>\n\n问题：{question}"


def answer(client: Any, index: Index, question: str, k: int = 3) -> tuple[str, list[tuple[float, Chunk]]]:
    hits = index.search(question, k)
    resp = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        system=SYSTEM,
        messages=[{"role": "user", "content": build_prompt(question, hits)}],
    )
    return "".join(b.text for b in resp.content if b.type == "text"), hits


if __name__ == "__main__":
    from fake_llm import make_client, text

    args = [a for a in sys.argv[1:] if a != "--fake"]
    q = args[0] if args else "会员多少钱？学生有优惠吗？"
    index = Index.from_dir()
    print(f"共 {len(index.chunks)} 个块，向量维度 {DIM}")
    fake = "--fake" in sys.argv
    client = make_client([text("Pro 会员月付 39 元、年付 299 元 [1]；学生认证后年付可享五折 [2]。")] if fake else None)
    reply, hits = answer(client, index, q)
    print(f"\n问题：{q}\n检索结果：")
    for s, c in hits:
        print(f"  {s:.3f}  {c.source:28}  {c.text[:40]}…")
    if fake:
        print("\n---- 发给模型的 user 消息 ----")
        print(client.calls[0]["messages"][0]["content"])
    print(f"\n回答{'（离线 fake 模型）' if fake else ''}：{reply}")
