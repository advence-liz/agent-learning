"""需要本地已缓存 SmolLM2-135M-Instruct；没有缓存时自动跳过（不会在测试里联网下载）。"""

import os

import pytest
import torch

os.environ.setdefault("HF_HUB_OFFLINE", "1")

from infer import (MODEL_ID, build_prompt, continue_from_prefix, generate_no_cache,  # noqa: E402
                   generate_with_cache, prefill_prefix, to_openai_json)
from sampling import sample_next  # noqa: E402


@pytest.fixture(scope="module")
def tm():
    try:
        from infer import load
        return load(MODEL_ID)
    except Exception as e:  # pragma: no cover
        pytest.skip(f"模型未缓存：{e}")


@pytest.fixture(scope="module")
def ids(tm):
    tok, _ = tm
    return tok(build_prompt(tok, "Name three colors."), return_tensors="pt").input_ids


def test_chat_template_has_roles(tm):
    tok, _ = tm
    p = build_prompt(tok, "hi")
    assert "<|im_start|>user\nhi<|im_end|>" in p and p.endswith("<|im_start|>assistant\n")


def test_greedy_loops_match_generate(tm, ids):
    tok, model = tm
    ref = model.generate(ids, max_new_tokens=20, do_sample=False)[:, ids.shape[1]:]
    assert torch.equal(generate_no_cache(model, ids, 20, tok.eos_token_id), ref)
    assert torch.equal(generate_with_cache(model, ids, 20, tok.eos_token_id), ref)


def test_sampling_loop_matches_generate_with_same_seed(tm, ids):
    tok, model = tm
    torch.manual_seed(7)
    mine = generate_with_cache(model, ids, 20, tok.eos_token_id,
                               sampler=lambda lg: sample_next(lg, 0.8, 50, 0.9))
    torch.manual_seed(7)
    hf = model.generate(ids, max_new_tokens=20, do_sample=True, temperature=0.8, top_k=50,
                        top_p=0.9)[:, ids.shape[1]:]
    assert torch.equal(mine, hf)


def test_kv_cache_grows_one_per_step(tm, ids):
    tok, model = tm
    lens = []
    generate_with_cache(model, ids, 5, eos_id=-1, on_token=lambda _t, c: lens.append(c.get_seq_length()))
    # prefill 后 cache 长度 = prompt 长度；之后每步 +1（最后一个 token 还没喂回模型）
    assert lens == [ids.shape[1] + i for i in range(5)]


def test_prefix_cache_reuse_gives_same_logits(tm):
    tok, model = tm
    sys_msg = [{"role": "system", "content": "You are terse. " * 20}]
    prefix_ids = tok(tok.apply_chat_template(sys_msg, tokenize=False), return_tensors="pt").input_ids
    full_ids = tok(tok.apply_chat_template(sys_msg + [{"role": "user", "content": "2+2?"}],
                                           add_generation_prompt=True, tokenize=False),
                   return_tensors="pt").input_ids
    cache = prefill_prefix(model, prefix_ids)
    got = continue_from_prefix(model, cache, full_ids[:, prefix_ids.shape[1]:])
    with torch.no_grad():
        ref = model(full_ids).logits[:, -1, :]
    assert torch.allclose(got, ref, atol=1e-3)
    assert got.argmax() == ref.argmax()
    assert cache.get_seq_length() == prefix_ids.shape[1]  # deepcopy：原前缀 cache 没被污染


def test_openai_json_usage(tm, ids):
    tok, model = tm
    new = generate_with_cache(model, ids, 10, tok.eos_token_id)
    resp = to_openai_json(tok, ids, new)
    assert resp["usage"]["prompt_tokens"] == ids.shape[1]
    assert resp["usage"]["total_tokens"] == ids.shape[1] + new.shape[1]
    assert resp["choices"][0]["finish_reason"] in {"stop", "length"}
