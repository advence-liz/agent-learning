"""第 4 章实验：词面检索（我们的 TF-IDF）在哪些地方赢、在哪些地方输。

uv run python -m rag.experiments
"""

from __future__ import annotations

import re

from rag.rag import DOCS, Chunk, Index, chunk_markdown


def show(idx: Index, q: str, k: int = 2) -> None:
    print(f"  Q: {q}")
    for s, c in idx.search(q, k):
        print(f"     {s:.3f}  {c.source:24} {c.text[:28]}…")


def exp1_title_prefix() -> None:
    print("实验 1：给每块加不加文档标题（上下文补全）")
    with_title = Index.from_dir()
    raw = [c for p in sorted(DOCS.glob("*.md")) for c in chunk_markdown(p)]
    no_title = Index([Chunk(c.source, re.sub(r"^【.*?】", "", c.text)) for c in raw])
    for name, idx in [("加标题", with_title), ("不加标题", no_title)]:
        print(f" [{name}]")
        show(idx, "具体价格是多少")


def exp2_paraphrase() -> None:
    print("\n实验 2：换个说法（同义改写，几乎不共享字）")
    idx = Index.from_dir()
    show(idx, "忘记密码怎么办")       # 和原文共享「忘记」「密码」
    show(idx, "登不上去了口令想不起来")  # 意思一样，但几乎没有共同的字


CODE = {
    "src/store/tracking.ts": "export const useTrackingStore = create((set) => ({ tracks: [], add: (t) => set(...) }))",
    "src/hooks/useTracker.ts": "export function useTracker() { const store = useTrackingStore(); return store.add }",
    "src/pages/Home.tsx": "function Home() { const items = useTrackStore(); return <List items={items} /> }",
    "src/utils/track.ts": "export function trackEvent(name: string) { analytics.capture(name) }",
}


def exp3_code_identifiers() -> None:
    print("\n实验 3：在代码里找 `useTrackingStore` 的所有引用")
    hits = [p for p, src in CODE.items() if re.search(r"\buseTrackingStore\b", src)]
    print(f"  grep -w: {hits}")
    # 真实 embedding 模型用子词（subword）切分标识符，这里用驼峰拆分模拟：
    # useTrackingStore → use tracking store
    def subwords(s: str) -> str:
        return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)

    idx = Index([Chunk(p, subwords(src)) for p, src in CODE.items()])
    print("  向量检索（子词切分）top-4：")
    for s, c in idx.search(subwords("useTrackingStore"), 4):
        print(f"     {s:.3f}  {c.source}")


if __name__ == "__main__":
    exp1_title_prefix()
    exp2_paraphrase()
    exp3_code_identifiers()
