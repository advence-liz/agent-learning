import json

from core.usage_stats import PRICES, render, scan


def _line(mid, model="claude-opus-5-5", **u):
    usage = {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0}
    usage.update(u)
    return json.dumps({"type": "assistant", "message": {"id": mid, "model": model, "usage": usage,
                                                         "content": [{"type": "text", "text": "SECRET-BODY"}]}})


def test_dedupe_split_lines_and_cost(tmp_path):
    f = tmp_path / "s.jsonl"
    rows = [
        json.dumps({"type": "user", "message": {"role": "user", "content": "SECRET-BODY"}}),
        _line("m1", input_tokens=10, cache_creation_input_tokens=1_000_000, output_tokens=100,
              cache_creation={"ephemeral_1h_input_tokens": 1_000_000, "ephemeral_5m_input_tokens": 0}),
        _line("m1", input_tokens=10, cache_creation_input_tokens=1_000_000, output_tokens=100,
              cache_creation={"ephemeral_1h_input_tokens": 1_000_000, "ephemeral_5m_input_tokens": 0}),
        _line("m2", input_tokens=10, cache_read_input_tokens=1_000_000, cache_creation_input_tokens=1_000_000,
              output_tokens=100),  # 没有拆分字段 → 按 5 分钟写入算
        _line("m3", model="<synthetic>", input_tokens=999),
        "not json",
    ]
    f.write_text("\n".join(rows))
    rep = scan([f])
    t = rep.by_model["claude-opus-5-5"]
    assert rep.duplicate_lines == 1 and rep.skipped_lines == 1 and "<synthetic>" not in rep.by_model
    assert (t.requests, t.input, t.cache_read, t.write_1h, t.write_5m, t.output) == (2, 20, 1_000_000, 1_000_000, 1_000_000, 200)
    assert abs(t.hit_rate - 1_000_000 / 3_000_020) < 1e-12
    p = PRICES["claude-opus-5-5"]
    expected = (20 * 4 + 1_000_000 * 0.20 + 1_000_000 * 4 * 2 + 1_000_000 * 4 * 1.25 + 200 * 20) / 1e6
    assert abs(t.cost(p) - expected) < 1e-9
    assert abs(t.cost_without_cache(p) - (3_000_020 * 4 + 200 * 20) / 1e6) < 1e-9
    assert "SECRET-BODY" not in render(rep)  # 输出里绝不出现正文
