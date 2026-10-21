"""把 logits 变成"下一个 token"的几种策略。纯函数，不依赖具体模型。

处理顺序与 transformers 的 generate 一致：temperature → top-k → top-p → softmax → 抽样。
"""

from __future__ import annotations

import torch


def apply_temperature(logits: torch.Tensor, temperature: float) -> torch.Tensor:
    """T<1 让分布更尖（更确定），T>1 让分布更平（更随机）。T→0 等价于 argmax。"""
    if temperature <= 0:
        raise ValueError("temperature 必须 > 0；想要确定性输出请直接用 greedy")
    return logits / temperature


def apply_top_k(logits: torch.Tensor, k: int) -> torch.Tensor:
    """只保留分数最高的 k 个 token，其余置为 -inf（softmax 后概率为 0）。"""
    if k <= 0 or k >= logits.size(-1):
        return logits
    kth = torch.topk(logits, k, dim=-1).values[..., -1, None]
    return logits.masked_fill(logits < kth, float("-inf"))


def apply_top_p(logits: torch.Tensor, p: float, min_keep: int = 1) -> torch.Tensor:
    """nucleus 采样：按概率从高到低累加，保留累计概率刚好达到 p 的最小集合。

    实现方式与 transformers 的 TopPLogitsWarper 相同（升序排序后去掉累计 ≤ 1-p 的尾部），
    这样同一个随机种子下两边能抽出一样的 token。
    """
    if p >= 1.0:
        return logits
    sorted_logits, sorted_idx = torch.sort(logits, descending=False, dim=-1)
    cum = sorted_logits.softmax(dim=-1).cumsum(dim=-1)
    remove_sorted = cum <= (1 - p)
    remove_sorted[..., -min_keep:] = False
    remove = remove_sorted.scatter(-1, sorted_idx, remove_sorted)
    return logits.masked_fill(remove, float("-inf"))


def sample_next(logits: torch.Tensor, temperature: float = 1.0, top_k: int = 0, top_p: float = 1.0,
                generator: torch.Generator | None = None) -> torch.Tensor:
    """logits: (batch, vocab) → (batch,) 的 token id。"""
    logits = apply_temperature(logits, temperature)
    logits = apply_top_k(logits, top_k)
    logits = apply_top_p(logits, top_p)
    probs = logits.softmax(dim=-1)
    return torch.multinomial(probs, num_samples=1, generator=generator).squeeze(-1)


def greedy_next(logits: torch.Tensor) -> torch.Tensor:
    return logits.argmax(dim=-1)
