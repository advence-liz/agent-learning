import hf_env  # noqa: F401
import torch
from torch import nn

from lora import LoRALinear, count_params, inject_lora, lora_state_dict
from ticket_data import HELD_OUT, STEMS, make_split, parse


class TinyAttn(nn.Module):
    def __init__(self, d=32):
        super().__init__()
        self.q_proj = nn.Linear(d, d)
        self.v_proj = nn.Linear(d, d)
        self.out = nn.Linear(d, 4)

    def forward(self, x):
        return self.out(torch.relu(self.q_proj(x)) * self.v_proj(x))


def test_fresh_lora_is_identity_and_base_frozen():
    torch.manual_seed(0)
    base = nn.Linear(16, 8)
    x = torch.randn(5, 16)
    ref = base(x)
    lora = LoRALinear(base, r=4, alpha=8)
    assert torch.allclose(lora(x), ref)                       # B=0 ⇒ 输出不变
    assert not base.weight.requires_grad and lora.lora_A.requires_grad
    trainable, _ = count_params(lora)
    assert trainable == 4 * (16 + 8)                          # r·(in+out)


def test_only_lora_params_get_grads():
    torch.manual_seed(0)
    lora = LoRALinear(nn.Linear(16, 8), r=2)
    lora(torch.randn(3, 16)).sum().backward()
    assert lora.base.weight.grad is None
    assert lora.lora_B.grad is not None and lora.lora_A.grad is not None


def test_merge_equals_unmerged_and_unmerge_restores():
    torch.manual_seed(0)
    lora = LoRALinear(nn.Linear(16, 8), r=4, alpha=16)
    nn.init.normal_(lora.lora_B)
    w0 = lora.base.weight.clone()
    x = torch.randn(7, 16)
    y = lora(x)
    lora.merge()
    assert torch.allclose(lora(x), y, atol=1e-5)
    lora.unmerge()
    assert torch.allclose(lora.base.weight, w0, atol=1e-6)


def test_inject_replaces_only_targets_and_freezes_rest():
    m = TinyAttn()
    names = inject_lora(m, target=("q_proj", "v_proj"), r=4)
    assert sorted(names) == ["q_proj", "v_proj"]
    assert isinstance(m.q_proj, LoRALinear) and isinstance(m.out, nn.Linear)
    assert not m.out.weight.requires_grad
    assert set(lora_state_dict(m)) == {"q_proj.lora_A", "q_proj.lora_B", "v_proj.lora_A", "v_proj.lora_B"}


def test_lora_can_learn_a_low_rank_update():
    """目标 = 原权重 + 一个秩为 2 的改动；r=2 的 LoRA 应该能把 loss 压到接近 0。"""
    torch.manual_seed(0)
    base = nn.Linear(64, 64, bias=False)
    delta = torch.randn(64, 2) @ torch.randn(2, 64) * 0.1
    target_w = base.weight.detach() + delta
    lora = LoRALinear(base, r=2, alpha=2)
    opt = torch.optim.Adam([lora.lora_A, lora.lora_B], lr=1e-2)
    for _ in range(1500):
        x = torch.randn(64, 64)
        loss = ((lora(x) - x @ target_w.T) ** 2).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
    assert loss.item() < 1e-4
    trainable, total = count_params(lora)
    assert trainable == 256 and total == 64 * 64 + 256        # 只训练了全量的 1/16


def test_matches_peft_on_tiny_model():
    from peft import LoraConfig, get_peft_model

    torch.manual_seed(0)
    mine = TinyAttn()
    theirs = TinyAttn()
    theirs.load_state_dict(mine.state_dict())
    inject_lora(mine, target=("q_proj", "v_proj"), r=4, alpha=8)
    peft_model = get_peft_model(theirs, LoraConfig(r=4, lora_alpha=8, target_modules=["q_proj", "v_proj"]))
    with torch.no_grad():
        for name in ("q_proj", "v_proj"):
            nn.init.normal_(getattr(mine, name).lora_B)
            pm = getattr(peft_model.base_model.model, name)
            pm.lora_A["default"].weight.copy_(getattr(mine, name).lora_A)
            pm.lora_B["default"].weight.copy_(getattr(mine, name).lora_B)
    x = torch.randn(10, 32)
    assert torch.allclose(mine(x), peft_model(x), atol=1e-6)
    assert count_params(mine)[0] == sum(p.numel() for p in peft_model.parameters() if p.requires_grad)


def test_ticket_split_holds_out_stems():
    train_texts = " | ".join(e["text"] for e in make_split(500, "train", seed=0))
    for stems in STEMS.values():
        for s in stems[-HELD_OUT:]:
            assert s not in train_texts
    test = make_split(50, "test", seed=1)
    assert all(any(s in e["text"] for s in STEMS[e["route"]][-HELD_OUT:]) for e in test)


def test_parse_rejects_invented_labels():
    assert parse('{"route": "billing", "priority": "low"}') == {"route": "billing", "priority": "low"}
    assert parse('{"route": "baking", "priority": "low"}') is None
    assert parse("Sure! Here is the JSON") is None
