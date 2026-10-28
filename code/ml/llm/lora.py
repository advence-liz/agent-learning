"""从零实现 LoRA（Low-Rank Adaptation）。

    y = W x + (alpha / r) · B (A x)
        └冻结┘            └── 只训练这两个小矩阵 ──┘
    W: (out, in)   A: (r, in)   B: (out, r)，r ≪ min(in, out)

B 初始化为 0，所以刚注入时模型输出和原模型一模一样；训练只改 A、B。
"""

from __future__ import annotations

import math

import torch
from torch import nn


class LoRALinear(nn.Module):
    def __init__(self, base: nn.Linear, r: int = 8, alpha: float = 16, dropout: float = 0.0):
        super().__init__()
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)                     # ① 冻结原权重
        self.r, self.alpha = r, alpha
        self.scaling = alpha / r                        # ② 缩放：换 r 时不用重调学习率
        dev, dt = base.weight.device, base.weight.dtype
        self.lora_A = nn.Parameter(torch.empty(r, base.in_features, device=dev, dtype=dt))
        self.lora_B = nn.Parameter(torch.zeros(base.out_features, r, device=dev, dtype=dt))
        nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))  # 与 nn.Linear / peft 默认一致
        self.dropout = nn.Dropout(dropout) if dropout > 0 else nn.Identity()
        self.merged = False

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.base(x)
        if self.merged:
            return out
        return out + (self.dropout(x) @ self.lora_A.T @ self.lora_B.T) * self.scaling

    @torch.no_grad()
    def merge(self) -> None:
        """把 ΔW = scaling·B·A 加回 W：推理时零额外开销，和普通 Linear 一样快。"""
        if not self.merged:
            self.base.weight += self.scaling * (self.lora_B @ self.lora_A)
            self.merged = True

    @torch.no_grad()
    def unmerge(self) -> None:
        if self.merged:
            self.base.weight -= self.scaling * (self.lora_B @ self.lora_A)
            self.merged = False


def inject_lora(model: nn.Module, target: tuple[str, ...] = ("q_proj", "v_proj"),
                r: int = 8, alpha: float = 16, dropout: float = 0.0) -> list[str]:
    """把名字以 target 结尾的 nn.Linear 原地替换成 LoRALinear，并冻结其余所有参数。"""
    for p in model.parameters():
        p.requires_grad_(False)
    replaced = []
    for name, module in list(model.named_modules()):
        for child_name, child in list(module.named_children()):
            if isinstance(child, nn.Linear) and child_name in target:
                setattr(module, child_name, LoRALinear(child, r, alpha, dropout))
                replaced.append(f"{name}.{child_name}" if name else child_name)
    return replaced


def lora_state_dict(model: nn.Module) -> dict[str, torch.Tensor]:
    """只保存 LoRA 参数——这就是「适配器文件」为什么只有几百 KB。"""
    return {k: v.detach().cpu() for k, v in model.state_dict().items() if "lora_" in k}


def count_params(model: nn.Module) -> tuple[int, int]:
    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return trainable, total
