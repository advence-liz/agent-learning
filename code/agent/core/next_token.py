"""第 4 章：用 numpy 从零走一遍「预测下一个 token」。

1) 字符级 bigram：数数 → 概率分布 → temperature / top-k 采样 → 自回归生成
2) 一个单头因果注意力：带 / 不带 KV cache 生成，结果逐位相同，但算 K/V 的乘加次数差一个数量级

离线运行： uv run python -m core.next_token
"""

from __future__ import annotations

import numpy as np

# 语料：一段 webapp 风格的 commit message（自己编的，够小，能手算）
CORPUS = (
    "fix(webapp): 修复录音列表滚动卡顿\n"
    "fix(webapp): 修复登录页按钮错位\n"
    "feat(webapp): 新增录音转写进度条\n"
    "feat(webapp): 新增会员额度提示\n"
    "fix(webapp): 修复转写进度条闪烁\n"
    "refactor(webapp): 拆分录音列表组件\n"
)


# ---------------- 1. bigram：最朴素的「下一个 token 预测器」 ----------------
def build_vocab(text: str) -> tuple[list[str], dict[str, int]]:
    itos = sorted(set(text))
    return itos, {c: i for i, c in enumerate(itos)}


def bigram_counts(text: str, stoi: dict[str, int]) -> np.ndarray:
    V = len(stoi)
    counts = np.zeros((V, V), dtype=np.int64)
    for a, b in zip(text, text[1:]):
        counts[stoi[a], stoi[b]] += 1
    return counts


def logits_from_counts(counts: np.ndarray, alpha: float = 0.01) -> np.ndarray:
    """log(计数 + 平滑) 当作 logits：数越多分越高。alpha 让没见过的组合也有一点点概率。"""
    return np.log(counts + alpha)


def softmax(x: np.ndarray) -> np.ndarray:
    z = x - x.max(axis=-1, keepdims=True)  # 减最大值防溢出，不改变结果
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def next_token_probs(logits_row: np.ndarray, temperature: float = 1.0, top_k: int | None = None) -> np.ndarray:
    if temperature == 0:  # 约定：T=0 就是贪心，直接取最大
        p = np.zeros_like(logits_row)
        p[int(np.argmax(logits_row))] = 1.0
        return p
    x = logits_row / temperature
    if top_k is not None and top_k < len(x):
        keep = np.argsort(-x, kind="stable")[:top_k]  # 只留前 k 名（并列时按词表顺序取），其余概率置 0
        masked = np.full_like(x, -np.inf)
        masked[keep] = x[keep]
        x = masked
    return softmax(x)


def generate(prompt: str, logits: np.ndarray, itos: list[str], stoi: dict[str, int], n: int,
             temperature: float = 1.0, top_k: int | None = None, seed: int = 0) -> str:
    rng = np.random.default_rng(seed)
    out = list(prompt)
    for _ in range(n):  # 自回归：每生成一个就拼回去，再用它预测下一个
        p = next_token_probs(logits[stoi[out[-1]]], temperature, top_k)
        nxt = itos[int(rng.choice(len(p), p=p))]
        out.append(nxt)
        if nxt == "\n":
            break
    return "".join(out)


# ---------------- 2. 单头因果注意力 + KV cache ----------------
class TinyAttention:
    """一层、单头、随机权重的因果自注意力。只为对比计算量，不为生成好句子。"""

    def __init__(self, vocab: int, d: int = 32, seed: int = 0):
        rng = np.random.default_rng(seed)
        self.d = d
        self.emb = rng.normal(0, 1, (vocab, d))
        self.Wq, self.Wk, self.Wv = (rng.normal(0, d ** -0.5, (d, d)) for _ in range(3))
        self.Wout = rng.normal(0, d ** -0.5, (d, vocab))
        self.kv_macs = 0  # 计 K/V 投影的乘加次数：每个位置 2 × d × d

    def _kv(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        self.kv_macs += 2 * x.shape[0] * self.d * self.d
        return x @ self.Wk, x @ self.Wv

    def _logits_last(self, q: np.ndarray, K: np.ndarray, V: np.ndarray) -> np.ndarray:
        att = softmax(q @ K.T / np.sqrt(self.d))  # 最后一个位置只看自己和前文 → 天然因果
        return (att @ V) @ self.Wout

    def generate(self, ids: list[int], n: int, use_cache: bool) -> list[int]:
        ids = list(ids)
        K = V = None
        for step in range(n):
            if not use_cache or K is None:
                x = self.emb[ids]                 # 不用缓存：每步把整段重新投影一遍
                K, V = self._kv(x)                # 用缓存时，这里只在第一步执行 = prefill
            else:
                x_new = self.emb[ids[-1:]]        # 用缓存：只投影新来的那个 token = decode
                k, v = self._kv(x_new)
                K, V = np.vstack([K, k]), np.vstack([V, v])
            q = self.emb[ids[-1]] @ self.Wq
            ids.append(int(np.argmax(self._logits_last(q, K, V))))
            if not use_cache:
                K = V = None
        return ids


def kv_macs(prompt_len: int, new_tokens: int, d: int, use_cache: bool) -> int:
    """解析式：生成 new_tokens 个 token 时，K/V 投影一共做多少次乘加。"""
    per_pos = 2 * d * d
    if use_cache:
        return per_pos * (prompt_len + new_tokens - 1)
    return per_pos * sum(prompt_len + i for i in range(new_tokens))


def bar(x: float, xmax: float, width: int = 40) -> str:
    return "█" * max(1, round(width * x / xmax))


def main() -> None:
    itos, stoi = build_vocab(CORPUS)
    counts = bigram_counts(CORPUS, stoi)
    logits = logits_from_counts(counts)
    print(f"词表大小 V={len(itos)}（字符级），bigram 计数矩阵 {counts.shape}，语料 {len(CORPUS)} 个字符\n")

    for ctx in ("修", "录"):
        row = counts[stoi[ctx]]
        top = np.argsort(-row)[:4]
        print(f"「{ctx}」后面出现过：" + "  ".join(f"{itos[i]!r}×{row[i]}" for i in top if row[i]))
        for T, k in ((0, None), (0.5, None), (1.0, None), (1.5, None), (1.0, 2)):
            p = next_token_probs(logits[stoi[ctx]], T, k)
            top = np.argsort(-p)[:3]
            desc = "  ".join(f"{itos[i]!r}:{p[i]:.3f}" for i in top)
            print(f"  T={T:<3} top_k={str(k):4}  {desc}   （其余 {1 - p[top].sum():.3f}）")
        print()

    print("自回归生成（prompt='fix(webapp): '，每行一个随机种子）：")
    for T, k in ((0, None), (0.7, 3), (1.5, None)):
        for seed in (1, 2):
            s = generate("fix(webapp): ", logits, itos, stoi, 20, T, k, seed).rstrip("\n")
            print(f"  T={T:<3} top_k={str(k):4} seed={seed}  {s}")
    print()

    model = TinyAttention(len(itos), d=32)
    prompt_ids = [stoi[c] for c in CORPUS[:40]]
    model.kv_macs = 0
    a = model.generate(prompt_ids, 20, use_cache=False)
    macs_nocache = model.kv_macs
    model.kv_macs = 0
    b = model.generate(prompt_ids, 20, use_cache=True)
    macs_cache = model.kv_macs
    print(f"TinyAttention(d=32)：prompt 40 个 token，生成 20 个")
    print(f"  两种方式生成的 token 完全一致：{a == b}")
    print(f"  K/V 投影乘加次数：不用缓存 {macs_nocache:,}  用缓存 {macs_cache:,}（实测计数）")
    print(f"  与解析式一致：{macs_nocache == kv_macs(40, 20, 32, False) and macs_cache == kv_macs(40, 20, 32, True)}\n")

    print("同一次请求内（KV cache）：d=4096，生成 200 个 token，K/V 投影乘加次数")
    for P in (1_000, 10_000, 100_000):
        nc, c = kv_macs(P, 200, 4096, False), kv_macs(P, 200, 4096, True)
        print(f"  P={P:>7,}  无缓存 {nc:.2e} {bar(nc, nc)}")
        print(f"  {'':9}  有缓存 {c:.2e} {bar(c, nc)}  省 {nc / c:,.0f} 倍")
    print()
    print("跨请求（Prompt Cache）：第 2 轮请求复用前缀 P，只追加 Δ=2,000 个新 token，prefill 要投影的位置数")
    for P in (10_000, 100_000, 500_000):
        full, delta = P + 2_000, 2_000
        print(f"  前缀 P={P:>7,}  不命中 {full:>8,} {bar(full, full)}")
        print(f"  {'':15}  命中   {delta:>8,} {bar(delta, full)}  只算 {delta / full:.1%}")

if __name__ == "__main__":
    main()
