"""同一件事用 peft 库来写：几行配置代替手写的 inject_lora。

运行：cd code/ml && HF_HUB_OFFLINE=1 uv run python llm/lora_peft.py
"""

from __future__ import annotations

import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hf_env  # noqa: E402,F401  必须先于 transformers
from lora import count_params, inject_lora  # noqa: E402
from lora_finetune import MODEL_ID, evaluate, pick_device, train  # noqa: E402
from ticket_data import make_split  # noqa: E402

TARGET = ["q_proj", "k_proj", "v_proj", "o_proj"]


def peft_wrap(model, r=8, alpha=16):
    from peft import LoraConfig, get_peft_model

    cfg = LoraConfig(r=r, lora_alpha=alpha, lora_dropout=0.0, target_modules=TARGET,
                     bias="none", task_type="CAUSAL_LM")
    return get_peft_model(model, cfg)


@torch.no_grad()
def copy_lora_weights(mine, peft_model) -> int:
    """把手写版的 A/B 拷进 peft 版，用来证明两者数学上等价。"""
    ours = {n: m for n, m in mine.named_modules() if hasattr(m, "lora_A") and not hasattr(m, "active_adapters")}
    n = 0
    for name, m in peft_model.named_modules():
        if hasattr(m, "lora_A") and isinstance(m.lora_A, torch.nn.ModuleDict):
            key = name.replace("base_model.model.", "")
            m.lora_A["default"].weight.copy_(ours[key].lora_A)
            m.lora_B["default"].weight.copy_(ours[key].lora_B)
            n += 1
    return n


def main():
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(MODEL_ID)
    ids = tok("The quick brown fox", return_tensors="pt").input_ids

    # ---- 1) 等价性：同样的 A、B，两种实现输出一样 ----
    torch.manual_seed(0)
    mine = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float32)
    inject_lora(mine, target=tuple(TARGET), r=8, alpha=16)
    for m in mine.modules():  # B 默认是 0，随机一下才有可比性
        if hasattr(m, "lora_B"):
            torch.nn.init.normal_(m.lora_B, std=0.02)
    theirs = peft_wrap(AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float32))
    n = copy_lora_weights(mine, theirs)
    with torch.no_grad():
        d = (mine(ids).logits - theirs(ids).logits).abs().max().item()
    print(f"[等价性] 拷贝了 {n} 组 A/B，手写版 vs peft 版 max|Δlogits| = {d:.2e}")
    print(f"[参数量] 手写版 trainable={count_params(mine)[0]:,}")
    theirs.print_trainable_parameters()
    del mine, theirs

    # ---- 2) 用 peft 版跑同样的训练 ----
    device = pick_device()
    torch.manual_seed(0)
    model = peft_wrap(AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float32)).to(device)
    train_data, test_data = make_split(400, "train", seed=0), make_split(100, "test", seed=1)
    print(f"\n[peft 训练] device={device}")
    t0 = time.time()
    train(tok, model, train_data, device)
    print(f"  训练耗时 {time.time() - t0:.1f}s")
    res = evaluate(tok, model, test_data, device)
    print(f"[peft 微调后] valid_json={res['valid_json']:.2f}  exact={res['exact']:.2f}")

    import tempfile

    out_dir = tempfile.mkdtemp(prefix="adapter-ticket-")
    model.save_pretrained(out_dir)
    files = {f: os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir)}
    print(f"save_pretrained → {out_dir}: " + ", ".join(f"{k} {v / 1024:.0f} KiB" for k, v in files.items()))


if __name__ == "__main__":
    main()
