import pytest
import torch

from sampling import apply_temperature, apply_top_k, apply_top_p, sample_next


def test_temperature_sharpens_and_flattens():
    logits = torch.tensor([[2.0, 1.0, 0.0]])
    p1 = logits.softmax(-1)
    p_cold = apply_temperature(logits, 0.5).softmax(-1)
    p_hot = apply_temperature(logits, 2.0).softmax(-1)
    assert p_cold[0, 0] > p1[0, 0] > p_hot[0, 0]
    with pytest.raises(ValueError):
        apply_temperature(logits, 0)


def test_top_k_keeps_exactly_k():
    logits = torch.tensor([[0.1, 3.0, 2.0, -1.0, 5.0]])
    out = apply_top_k(logits, 2)
    assert torch.isfinite(out).sum() == 2
    assert set(torch.nonzero(torch.isfinite(out[0])).flatten().tolist()) == {1, 4}


def test_top_p_keeps_smallest_set_reaching_p():
    probs = torch.tensor([[0.5, 0.3, 0.15, 0.05]])
    logits = probs.log()
    kept = torch.isfinite(apply_top_p(logits, 0.75))[0].tolist()
    assert kept == [True, True, False, False]   # 0.5+0.3=0.8 ≥ 0.75
    kept = torch.isfinite(apply_top_p(logits, 0.85))[0].tolist()
    assert kept == [True, True, True, False]


def test_top_p_always_keeps_at_least_one():
    logits = torch.tensor([[10.0, 0.0, 0.0]])
    assert torch.isfinite(apply_top_p(logits, 0.01)).sum() == 1


def test_matches_transformers_logits_processors():
    from transformers.generation.logits_process import (
        TemperatureLogitsWarper, TopKLogitsWarper, TopPLogitsWarper)
    torch.manual_seed(0)
    logits = torch.randn(4, 1000)
    ref = TopPLogitsWarper(0.9)(None, TopKLogitsWarper(50)(None, TemperatureLogitsWarper(0.7)(None, logits.clone())))
    mine = apply_top_p(apply_top_k(apply_temperature(logits, 0.7), 50), 0.9)
    assert torch.equal(torch.isfinite(ref), torch.isfinite(mine))
    assert torch.allclose(ref[torch.isfinite(ref)], mine[torch.isfinite(mine)])


def test_same_seed_same_sample_different_seed_differs():
    logits = torch.zeros(1, 100)  # 均匀分布
    a = [sample_next(logits, generator=torch.Generator().manual_seed(42)).item() for _ in range(3)]
    assert len(set(a)) == 1
    many = {sample_next(logits, generator=torch.Generator().manual_seed(s)).item() for s in range(20)}
    assert len(many) > 5


def test_empirical_distribution_respects_temperature():
    logits = torch.tensor([[1.0, 0.0]])
    g = torch.Generator().manual_seed(0)
    n = 4000
    hits_cold = sum(sample_next(logits, 0.25, generator=g).item() == 0 for _ in range(n)) / n
    hits_warm = sum(sample_next(logits, 1.0, generator=g).item() == 0 for _ in range(n)) / n
    assert hits_cold == pytest.approx(torch.sigmoid(torch.tensor(4.0)).item(), abs=0.03)  # ≈0.982
    assert hits_warm == pytest.approx(torch.sigmoid(torch.tensor(1.0)).item(), abs=0.03)  # ≈0.731
