"""手写 LLM 推理全流程：chat template → tokenize → forward → logits → 采样 → KV cache 循环。

模型：HuggingFaceTB/SmolLM2-135M-Instruct（Llama 架构，1.35 亿参数，权重文件 269 MB）。
首次运行会从 Hugging Face 下载；之后可设 HF_HUB_OFFLINE=1 完全离线。

运行：cd code/ml && uv run python llm/infer.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sampling import greedy_next, sample_next  # noqa: E402

MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct"


def load(model_id: str = MODEL_ID):
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(model_id, dtype=torch.float32)
    model.eval()
    return tok, model


def build_prompt(tok, user_text: str) -> str:
    messages = [{"role": "user", "content": user_text}]
    return tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)


@torch.no_grad()
def generate_no_cache(model, input_ids: torch.Tensor, max_new_tokens: int, eos_id: int) -> torch.Tensor:
    """最朴素的循环：每一步都把「全部已有 token」重新喂一遍。复杂度 O(n²)。"""
    ids = input_ids
    for _ in range(max_new_tokens):
        logits = model(ids, use_cache=False).logits[:, -1, :]
        nxt = greedy_next(logits)
        ids = torch.cat([ids, nxt[:, None]], dim=1)
        if nxt.item() == eos_id:
            break
    return ids[:, input_ids.shape[1]:]


@torch.no_grad()
def generate_with_cache(model, input_ids: torch.Tensor, max_new_tokens: int, eos_id: int,
                        sampler=None, on_token=None) -> torch.Tensor:
    """带 KV cache：prefill 一次算完 prompt，之后每步只喂 1 个新 token。

    sampler: logits(batch, vocab) -> token(batch,)；默认 greedy。
    """
    sampler = sampler or greedy_next
    out = model(input_ids, use_cache=True)              # ① prefill
    cache = out.past_key_values
    nxt = sampler(out.logits[:, -1, :])
    generated = [nxt]
    if on_token:
        on_token(nxt.item(), cache)
    for _ in range(max_new_tokens - 1):
        if nxt.item() == eos_id:
            break
        out = model(nxt[:, None], past_key_values=cache, use_cache=True)  # ② decode：只喂一个 token
        cache = out.past_key_values
        nxt = sampler(out.logits[:, -1, :])
        generated.append(nxt)
        if on_token:
            on_token(nxt.item(), cache)
    return torch.stack(generated, dim=1)


@torch.no_grad()
def prefill_prefix(model, prefix_ids: torch.Tensor):
    """只对公共前缀（比如 system prompt）做一次 prefill，返回可复用的 cache。"""
    return model(prefix_ids, use_cache=True).past_key_values


@torch.no_grad()
def continue_from_prefix(model, prefix_cache, suffix_ids: torch.Tensor) -> torch.Tensor:
    """复制一份前缀 cache，在它后面接着算 suffix，返回最后位置的 logits。"""
    import copy

    cache = copy.deepcopy(prefix_cache)
    return model(suffix_ids, past_key_values=cache, use_cache=True).logits[:, -1, :]


def kv_cache_bytes(cache) -> int:
    total = 0
    for layer in cache.layers:
        total += layer.keys.numel() * layer.keys.element_size()
        total += layer.values.numel() * layer.values.element_size()
    return total


def to_openai_json(tok, prompt_ids, new_ids, model_id=MODEL_ID) -> dict:
    """推理程序最后一步自己拼出的 OpenAI 风格响应——API 返回的 JSON 就是这么来的。"""
    new = new_ids[0].tolist()
    finish = "stop" if new and new[-1] == tok.eos_token_id else "length"
    text = tok.decode(new, skip_special_tokens=True)
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "model": model_id,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
        "usage": {"prompt_tokens": prompt_ids.shape[1], "completion_tokens": len(new),
                  "total_tokens": prompt_ids.shape[1] + len(new)},
    }


def main():
    torch.manual_seed(0)
    tok, model = load()
    cfg = model.config
    print(f"[0] 模型 {MODEL_ID}: {sum(p.numel() for p in model.parameters()):,} 参数, "
          f"{cfg.num_hidden_layers} 层, hidden={cfg.hidden_size}, "
          f"heads={cfg.num_attention_heads} (kv_heads={cfg.num_key_value_heads}), vocab={cfg.vocab_size}")

    question = "What is the capital of France?"
    prompt = build_prompt(tok, question)
    print("\n[1] chat template 展开后的字符串：")
    print(repr(prompt))

    input_ids = tok(prompt, return_tensors="pt").input_ids
    pieces = tok.convert_ids_to_tokens(input_ids[0])
    print(f"\n[2] tokenize：{input_ids.shape[1]} 个 token")
    print("    前 12 个:", list(zip(input_ids[0, :12].tolist(), pieces[:12])))

    with torch.no_grad():
        logits = model(input_ids).logits
    print(f"\n[3] forward：logits.shape = {tuple(logits.shape)}  (batch, seq_len, vocab)")
    probs = logits[0, -1].softmax(-1)
    top = torch.topk(probs, 5)
    print("    最后一个位置的 top-5 下一个 token：")
    for p, i in zip(top.values, top.indices):
        print(f"      {tok.decode([i.item()])!r:>12}  id={i.item():<6} p={p.item():.4f}")

    print("\n[4] 温度如何改变分布（最后一个位置，top-1 概率 / 有效候选数 exp(熵)）：")
    for T in (0.3, 0.7, 1.0, 1.5):
        pt = (logits[0, -1] / T).softmax(-1)
        ent = -(pt * pt.clamp_min(1e-12).log()).sum()
        print(f"    T={T:<4} top1_p={pt.max().item():.4f}  有效候选数≈{ent.exp().item():8.2f}")

    N = 40
    eos = tok.eos_token_id
    t0 = time.time()
    a = generate_no_cache(model, input_ids, N, eos)
    t_nc = time.time() - t0
    cache_info = {}

    def track(_tok_id, cache):
        cache_info["len"] = cache.get_seq_length()
        cache_info["shape"] = tuple(cache.layers[0].keys.shape)
        cache_info["bytes"] = kv_cache_bytes(cache)

    t0 = time.time()
    b = generate_with_cache(model, input_ids, N, eos, on_token=track)
    t_c = time.time() - t0
    with torch.no_grad():
        ref = model.generate(input_ids, max_new_tokens=N, do_sample=False)[:, input_ids.shape[1]:]
    print("\n[5] greedy 解码，三种实现对比：")
    print(f"    无 cache    : {t_nc:.2f}s  {tok.decode(a[0], skip_special_tokens=True)!r}")
    print(f"    有 KV cache : {t_c:.2f}s  {tok.decode(b[0], skip_special_tokens=True)!r}")
    print(f"    model.generate 一致: no_cache={torch.equal(a, ref)}  kv_cache={torch.equal(b, ref)}")
    print(f"    KV cache 最终长度={cache_info['len']}，每层 key 形状={cache_info['shape']} "
          f"(batch, kv_heads, seq, head_dim)，总大小={cache_info['bytes'] / 1024:.0f} KiB")

    print("\n[5b] 生成更长时 KV cache 的收益（忽略 EOS，强制生成 N 个 token）：")
    long_ids = tok(build_prompt(tok, "Write a long story about a robot who learns to paint."),
                   return_tensors="pt").input_ids
    for n in (50, 100, 200):
        t0 = time.time()
        generate_no_cache(model, long_ids, n, eos_id=-1)
        t_nc = time.time() - t0
        t0 = time.time()
        generate_with_cache(model, long_ids, n, eos_id=-1)
        t_c = time.time() - t0
        print(f"    N={n:<4} 无 cache {t_nc:6.2f}s   有 cache {t_c:5.2f}s   加速 {t_nc / t_c:4.1f}x")

    print("\n[6] 采样：temperature=0.8, top_k=50, top_p=0.9，同一种子 vs model.generate：")
    for seed in (1, 2, 3):
        torch.manual_seed(seed)
        mine = generate_with_cache(model, input_ids, 30, eos,
                                   sampler=lambda lg: sample_next(lg, 0.8, 50, 0.9))
        torch.manual_seed(seed)
        with torch.no_grad():
            hf = model.generate(input_ids, max_new_tokens=30, do_sample=True, temperature=0.8,
                                top_k=50, top_p=0.9)[:, input_ids.shape[1]:]
        print(f"    seed={seed} 一致={torch.equal(mine, hf)}  {tok.decode(mine[0], skip_special_tokens=True)!r}")

    print("\n[6b] 前缀复用（prompt caching 的本地版）：长 system prompt 只 prefill 一次")
    system = "You are a support assistant for a note-taking app. " * 40
    prefix = tok.apply_chat_template([{"role": "system", "content": system}], tokenize=False)
    prefix_ids = tok(prefix, return_tensors="pt").input_ids
    t0 = time.time()
    pcache = prefill_prefix(model, prefix_ids)
    t_prefix = time.time() - t0
    print(f"    前缀 {prefix_ids.shape[1]} token，prefill 一次 {t_prefix:.3f}s")
    for q in ("How do I export a note?", "Why did my sync fail?"):
        full = tok.apply_chat_template([{"role": "system", "content": system}, {"role": "user", "content": q}],
                                       add_generation_prompt=True, tokenize=False)
        full_ids = tok(full, return_tensors="pt").input_ids
        assert torch.equal(full_ids[:, :prefix_ids.shape[1]], prefix_ids)
        suffix_ids = full_ids[:, prefix_ids.shape[1]:]
        t0 = time.time()
        with torch.no_grad():
            ref = model(full_ids).logits[:, -1, :]
        t_full = time.time() - t0
        t0 = time.time()
        got = continue_from_prefix(model, pcache, suffix_ids)
        t_reuse = time.time() - t0
        print(f"    {q!r:<28} 全量 {full_ids.shape[1]} tok {t_full:.3f}s | 复用前缀只算 {suffix_ids.shape[1]} tok "
              f"{t_reuse:.3f}s | max|Δlogits|={(ref - got).abs().max().item():.2e}")

    print("\n[7] 拼成 OpenAI 格式的响应：")
    print(json.dumps(to_openai_json(tok, input_ids, b), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
