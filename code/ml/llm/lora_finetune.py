"""用手写 LoRALinear 微调 SmolLM2-135M-Instruct，学会把工单路由成 JSON。

运行：cd code/ml && HF_HUB_OFFLINE=1 uv run python llm/lora_finetune.py
设备：优先 mps（Apple Silicon），否则 cpu。M 系列芯片上约 1–2 分钟。
"""

from __future__ import annotations

import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lora import count_params, inject_lora, lora_state_dict  # noqa: E402
from ticket_data import make_split, messages, parse, target_json  # noqa: E402

MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct"


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    return "cuda" if torch.cuda.is_available() else "cpu"


def encode(tok, ex: dict) -> tuple[list[int], list[int]]:
    """prompt 部分的 label 设为 -100（不算 loss），只让模型学「回答」那几个 token。"""
    prompt = tok.apply_chat_template(messages(ex["text"]), add_generation_prompt=True, tokenize=False)
    answer = target_json(ex["route"], ex["priority"]) + "<|im_end|>"
    p_ids = tok(prompt, add_special_tokens=False).input_ids
    a_ids = tok(answer, add_special_tokens=False).input_ids
    return p_ids + a_ids, [-100] * len(p_ids) + a_ids


def collate(batch, pad_id: int, device: str):
    L = max(len(ids) for ids, _ in batch)
    ids = torch.full((len(batch), L), pad_id)
    labels = torch.full((len(batch), L), -100)
    mask = torch.zeros((len(batch), L), dtype=torch.long)
    for i, (x, y) in enumerate(batch):  # 右侧 padding（训练时）
        ids[i, :len(x)] = torch.tensor(x)
        labels[i, :len(y)] = torch.tensor(y)
        mask[i, :len(x)] = 1
    return ids.to(device), labels.to(device), mask.to(device)


@torch.no_grad()
def evaluate(tok, model, data: list[dict], device: str, show: int = 0) -> dict:
    model.eval()
    tok.padding_side = "left"  # 生成时左侧 padding，保证每条的「最后一个位置」都是真 token
    valid = exact = route_ok = prio_ok = 0
    shown, failures = [], []
    for i in range(0, len(data), 16):
        chunk = data[i:i + 16]
        prompts = [tok.apply_chat_template(messages(e["text"]), add_generation_prompt=True, tokenize=False)
                   for e in chunk]
        enc = tok(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(device)
        out = model.generate(**enc, max_new_tokens=24, do_sample=False, pad_token_id=tok.pad_token_id)
        for e, row in zip(chunk, out[:, enc.input_ids.shape[1]:]):
            text = tok.decode(row, skip_special_tokens=True)
            obj = parse(text)
            valid += obj is not None
            exact += obj == {"route": e["route"], "priority": e["priority"]}
            route_ok += bool(obj) and obj["route"] == e["route"]
            prio_ok += bool(obj) and obj["priority"] == e["priority"]
            if obj != {"route": e["route"], "priority": e["priority"]}:
                failures.append((e["text"], target_json(e["route"], e["priority"]), text))
            if len(shown) < show:
                shown.append((e["text"], text))
    n = len(data)
    return {"valid_json": valid / n, "exact": exact / n, "route": route_ok / n, "priority": prio_ok / n,
            "examples": shown, "failures": failures}


def train(tok, model, train_data, device, steps=150, batch=16, lr=2e-3, log=print, seed=0):
    g = torch.Generator().manual_seed(seed)
    encoded = [encode(tok, e) for e in train_data]
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 10) * (1 - s / steps))
    model.train()
    t0 = time.time()
    for step in range(steps):
        idx = torch.randint(len(encoded), (batch,), generator=g).tolist()
        ids, labels, mask = collate([encoded[i] for i in idx], tok.pad_token_id, device)
        loss = model(input_ids=ids, attention_mask=mask, labels=labels).loss
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if step % 25 == 0 or step == steps - 1:
            log(f"  step {step:3d}  loss={loss.item():.4f}  lr={sched.get_last_lr()[0]:.2e}  {time.time() - t0:5.1f}s")


def main():
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.manual_seed(0)
    device = pick_device()
    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float32).to(device)

    train_data = make_split(400, "train", seed=0)
    test_data = make_split(100, "test", seed=1)
    print(f"device={device}  train={len(train_data)}  test={len(test_data)}（测试集句子主干训练时没见过）")
    print("样例:", train_data[0]["text"], "→", target_json(train_data[0]["route"], train_data[0]["priority"]))

    before = evaluate(tok, model, test_data, device, show=3)
    print(f"\n[微调前] valid_json={before['valid_json']:.2f}  exact={before['exact']:.2f}")
    for q, a in before["examples"]:
        print(f"    {q!r}\n      → {a!r}")

    replaced = inject_lora(model, target=("q_proj", "k_proj", "v_proj", "o_proj"), r=8, alpha=16)
    trainable, total = count_params(model)
    print(f"\n注入 LoRA 到 {len(replaced)} 个 Linear（例：{replaced[0]}）")
    print(f"可训练参数 {trainable:,} / 总参数 {total:,} = {trainable / total:.3%}")

    print("\n[训练]")
    t0 = time.time()
    train(tok, model, train_data, device)
    print(f"  训练耗时 {time.time() - t0:.1f}s")

    after = evaluate(tok, model, test_data, device, show=3)
    print(f"\n[微调后] valid_json={after['valid_json']:.2f}  exact={after['exact']:.2f}  "
          f"route_acc={after['route']:.2f}  priority_acc={after['priority']:.2f}")
    for q, a in after["examples"]:
        print(f"    {q!r}\n      → {a!r}")
    print(f"  失败样例（共 {len(after['failures'])} 条，列前 6 条）：")
    for q, want, got in after["failures"][:6]:
        print(f"    {q!r}\n      期望 {want}\n      实际 {got!r}")

    sd = lora_state_dict(model)
    n_bytes = sum(v.numel() * v.element_size() for v in sd.values())
    print(f"\n适配器只需保存 {len(sd)} 个张量，{n_bytes / 1024 / 1024:.2f} MiB（原模型 fp32 约 "
          f"{total * 4 / 1024 / 1024:.0f} MiB）")

    for m in model.modules():
        if hasattr(m, "merge"):
            m.merge()
    merged = evaluate(tok, model, test_data, device)
    print(f"merge 进原权重后 exact={merged['exact']:.2f}（应与微调后一致）")


if __name__ == "__main__":
    main()
