import numpy as np

from core.next_token import (CORPUS, TinyAttention, bigram_counts, build_vocab, generate, kv_macs,
                             logits_from_counts, next_token_probs)


def _model():
    itos, stoi = build_vocab(CORPUS)
    return itos, stoi, logits_from_counts(bigram_counts(CORPUS, stoi))


def test_probs_sum_to_one_and_temperature_sharpens():
    itos, stoi, logits = _model()
    row = logits[stoi["录"]]
    p_cold, p_hot = next_token_probs(row, 0.5), next_token_probs(row, 1.5)
    assert np.isclose(p_cold.sum(), 1) and np.isclose(p_hot.sum(), 1)
    assert p_cold.max() > p_hot.max()  # T 越小越尖
    assert next_token_probs(row, 0)[stoi["列"]] == 1.0  # T=0 = 贪心


def test_top_k_keeps_exactly_k():
    itos, stoi, logits = _model()
    p = next_token_probs(logits[stoi["录"]], 1.0, top_k=2)
    assert (p > 0).sum() == 2 and {itos[i] for i in np.flatnonzero(p)} == {"列", "页"}


def test_greedy_generation_is_deterministic():
    itos, stoi, logits = _model()
    a = generate("fix(webapp): ", logits, itos, stoi, 20, temperature=0, seed=1)
    b = generate("fix(webapp): ", logits, itos, stoi, 20, temperature=0, seed=2)
    assert a == b == "fix(webapp): 修复导出进度条\n"


def test_kv_cache_same_output_less_compute():
    itos, stoi, _ = _model()
    m = TinyAttention(len(itos), d=16)
    ids = [stoi[c] for c in CORPUS[:30]]
    m.kv_macs = 0
    a = m.generate(ids, 10, use_cache=False)
    nc = m.kv_macs
    m.kv_macs = 0
    b = m.generate(ids, 10, use_cache=True)
    assert a == b
    assert nc == kv_macs(30, 10, 16, False) and m.kv_macs == kv_macs(30, 10, 16, True) and m.kv_macs < nc
