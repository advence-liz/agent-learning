import pytest

from cost_routing.meter import Budget, CostMeter, Tokens, cost_usd, normalize_usage, worst_case_next_usd


def approx(x):
    return pytest.approx(x, rel=1e-9)


def test_plain_input_output():
    # Opus 5.5：输入 $4 / 输出 $20 每百万
    assert cost_usd("claude-opus-5-5", {"input_tokens": 1_000_000, "output_tokens": 0}) == approx(4.0)
    assert cost_usd("claude-opus-5-5", {"input_tokens": 0, "output_tokens": 1_000_000}) == approx(20.0)


def test_cache_write_and_read():
    u = {"input_tokens": 0, "output_tokens": 0,
         "cache_creation_input_tokens": 1_000_000, "cache_read_input_tokens": 1_000_000}
    # Sonnet 5.5：写入（默认按 5 分钟）2 × 1.25 = 2.5，读 0.10（0.05×）
    assert cost_usd("claude-sonnet-5-5", u) == approx(2.5 + 0.1)


def test_ttl_split_uses_cache_creation_breakdown():
    u = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 300,
         "cache_creation": {"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200}}
    t = normalize_usage(u)
    assert (t.write_5m, t.write_1h) == (100, 200)
    assert cost_usd("claude-opus-5-5", u) == approx((100 * 4 * 1.25 + 200 * 4 * 2.0) / 1e6)


def test_none_fields_count_as_zero():
    # SDK 的 Usage 里没开缓存时这两个字段是 None
    u = {"input_tokens": 10, "output_tokens": 10, "cache_creation_input_tokens": None, "cache_read_input_tokens": None}
    assert normalize_usage(u) == Tokens(input=10, output=10)


def test_batch_halves_everything():
    u = {"input_tokens": 1000, "output_tokens": 1000, "cache_read_input_tokens": 5000}
    assert cost_usd("claude-opus-5-5", u, batch=True) == approx(cost_usd("claude-opus-5-5", u) / 2)


def test_haiku_long_prompt_tier():
    short = Tokens(input=100_000, output=1_000)
    long = Tokens(input=100_001, output=1_000)
    assert cost_usd("claude-haiku-5-5", short) == approx((100_000 * 0.10 + 1_000 * 0.50) / 1e6)
    assert cost_usd("claude-haiku-5-5", long) == approx((100_001 * 0.50 + 1_000 * 2.50) / 1e6)
    # 判断依据是三种输入之和，不只是 input_tokens
    assert cost_usd("claude-haiku-5-5", Tokens(input=1, cache_read=100_000)) == approx((1 * 0.50 + 100_000 * 0.05) / 1e6)


def test_unknown_model_raises():
    with pytest.raises(KeyError):
        cost_usd("claude-unknown", {"input_tokens": 1, "output_tokens": 1})


def test_meter_groups_by_tenant_and_model():
    m = CostMeter()
    m.add("claude-opus-5-5", {"input_tokens": 1_000_000, "output_tokens": 0}, tenant="a")
    m.add("claude-haiku-5-5", {"input_tokens": 100_000, "output_tokens": 0}, tenant="b")
    assert m.spent() == approx(4.01)
    assert m.spent("a") == approx(4.0)
    assert m.by("tenant") == {"a": approx(4.0), "b": approx(0.01)}
    assert m.by("model") == {"claude-opus-5-5": approx(4.0), "claude-haiku-5-5": approx(0.01)}


def test_budget_verdicts():
    b = Budget(soft_usd=1.0, hard_usd=2.0)
    assert b.check(0.5, 0.1) == "ok"
    assert b.check(1.0, 0.1) == "soft"
    assert b.check(1.5, 0.6) == "hard"  # 先看硬上限：最坏情况会超就别再调


def test_worst_case_assumes_no_cache_and_full_max_tokens():
    last = Tokens(cache_read=9_000, write_5m=1_000, output=500)
    # 下一次输入 ≈ 10,000 + 500（上一圈输出）+ 200（新工具结果），全按未缓存价；输出顶满 1,000
    assert worst_case_next_usd("claude-opus-5-5", last, 1_000, 200) == approx((10_700 * 4 + 1_000 * 20) / 1e6)
