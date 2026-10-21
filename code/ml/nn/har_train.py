"""用 MLP 和 1D-CNN 识别合成的人体动作数据。

运行：cd code/ml && uv run python nn/har_train.py
"""

from __future__ import annotations

import os
import sys
import time

import numpy as np
import torch
from torch import nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from har_data import CLASSES, WINDOW, make_dataset  # noqa: E402

IMG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../p6-nn-llm/img"))


def standardize(train: np.ndarray, *others: np.ndarray):
    """按通道（x/y/z）标准化，统计量只用训练集算——避免把测试集信息漏进训练。"""
    mean = train.mean(axis=(0, 2), keepdims=True)
    std = train.std(axis=(0, 2), keepdims=True) + 1e-6
    return [(a - mean) / std for a in (train, *others)]


class MLP(nn.Module):
    """把 3×128 摊平成 384 维向量，丢给两层隐藏层。"""

    def __init__(self, hidden: int = 128, n_classes: int = 4):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(),
            nn.Linear(3 * WINDOW, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden), nn.ReLU(),
            nn.Linear(hidden, n_classes),
        )

    def forward(self, x):
        return self.net(x)


class CNN1D(nn.Module):
    """1D 卷积：同一个小卷积核沿时间轴滑动，天然适合"不管第几秒迈步都算迈步"。"""

    def __init__(self, n_classes: int = 4):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv1d(3, 16, kernel_size=7, padding=3), nn.ReLU(), nn.MaxPool1d(2),   # 128 -> 64
            nn.Conv1d(16, 32, kernel_size=5, padding=2), nn.ReLU(), nn.MaxPool1d(2),  # 64 -> 32
            nn.Conv1d(32, 32, kernel_size=5, padding=2), nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),  # 全局平均：对时间平移不敏感
        )
        self.head = nn.Linear(32, n_classes)

    def forward(self, x):
        return self.head(self.features(x).squeeze(-1))


def n_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())


def accuracy(model: nn.Module, X: torch.Tensor, y: torch.Tensor) -> float:
    model.eval()
    with torch.no_grad():
        return (model(X).argmax(1) == y).float().mean().item()


def confusion(model: nn.Module, X: torch.Tensor, y: torch.Tensor) -> np.ndarray:
    model.eval()
    with torch.no_grad():
        pred = model(X).argmax(1).numpy()
    k = len(CLASSES)
    m = np.zeros((k, k), dtype=int)
    for t, p in zip(y.numpy(), pred):
        m[t, p] += 1
    return m


def train(model: nn.Module, Xtr, ytr, Xva, yva, epochs: int = 30, lr: float = 1e-3,
          batch: int = 64, seed: int = 0, log=print) -> nn.Module:
    torch.manual_seed(seed)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()
    n = len(ytr)
    for ep in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(n)
        total = 0.0
        for i in range(0, n, batch):
            idx = perm[i:i + batch]
            loss = loss_fn(model(Xtr[idx]), ytr[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        log(f"  epoch {ep:2d}  loss={total / n:.4f}  train_acc={accuracy(model, Xtr, ytr):.3f}"
            f"  val_acc={accuracy(model, Xva, yva):.3f}")
    return model


def load_tensors(n_train=600, n_val=150, n_test=150):
    Xtr, ytr = make_dataset(n_train, seed=1)
    Xva, yva = make_dataset(n_val, seed=2)
    Xte, yte = make_dataset(n_test, seed=3)
    Xtr, Xva, Xte = standardize(Xtr, Xva, Xte)
    t = lambda a: torch.from_numpy(np.ascontiguousarray(a))  # noqa: E731
    return t(Xtr), t(ytr), t(Xva), t(yva), t(Xte), t(yte)


def plot_examples(path: str):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from har_data import FS, synth_window

    rng = np.random.default_rng(42)
    fig, axes = plt.subplots(1, 4, figsize=(14, 3), sharey=True)
    t = np.arange(WINDOW) / FS
    for k, ax in enumerate(axes):
        w = synth_window(k, rng)
        for c, name in enumerate("xyz"):
            ax.plot(t, w[c], lw=1, label=name)
        ax.set_title(CLASSES[k])
        ax.set_xlabel("s")
    axes[0].set_ylabel("m/s²")
    axes[0].legend(loc="lower left", fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def handcrafted_features(X: np.ndarray) -> np.ndarray:
    """人工设计的特征：每轴均值/标准差 + 合加速度的标准差。线性模型只能靠这些。"""
    mag = np.linalg.norm(X, axis=1)
    return np.concatenate([X.mean(2), X.std(2), mag.std(1, keepdims=True)], axis=1)


def baseline_logreg(Xtr, ytr, Xte, yte) -> float:
    from sklearn.linear_model import LogisticRegression
    clf = LogisticRegression(max_iter=2000)
    clf.fit(handcrafted_features(Xtr.numpy()), ytr.numpy())
    return clf.score(handcrafted_features(Xte.numpy()), yte.numpy())


def main():
    os.makedirs(IMG_DIR, exist_ok=True)
    plot_examples(os.path.join(IMG_DIR, "har-signals.png"))

    Xtr, ytr, Xva, yva, Xte, yte = load_tensors()
    print(f"train={tuple(Xtr.shape)} val={tuple(Xva.shape)} test={tuple(Xte.shape)} classes={CLASSES}")

    print(f"\n== baseline: 7 个手工特征 + 逻辑回归 ==\n  test_acc={baseline_logreg(Xtr, ytr, Xte, yte):.3f}")

    for name, model in [("MLP", MLP()), ("1D-CNN", CNN1D())]:
        torch.manual_seed(0)
        model = type(model)()  # 固定种子后重新初始化，结果可复现
        print(f"\n== {name}  params={n_params(model):,} ==")
        t0 = time.time()
        train(model, Xtr, ytr, Xva, yva)
        print(f"  test_acc={accuracy(model, Xte, yte):.3f}  time={time.time() - t0:.1f}s")
        print("  confusion (rows=true, cols=pred):", CLASSES)
        for k, row in enumerate(confusion(model, Xte, yte)):
            print(f"    {CLASSES[k]:>6} {row}")


if __name__ == "__main__":
    main()
