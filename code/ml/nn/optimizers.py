"""手写 SGD / Momentum / Adam，在 Rosenbrock 函数上比较收敛轨迹。

运行：cd code/ml && uv run python nn/optimizers.py
图片输出到 p6-nn-llm/img/。
"""

from __future__ import annotations

import os

import numpy as np

IMG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../p6-nn-llm/img"))


# ---------------- 目标函数 ----------------
def rosenbrock(p: np.ndarray) -> float:
    x, y = p
    return (1 - x) ** 2 + 100 * (y - x ** 2) ** 2


def rosenbrock_grad(p: np.ndarray) -> np.ndarray:
    x, y = p
    return np.array([-2 * (1 - x) - 400 * x * (y - x ** 2), 200 * (y - x ** 2)])


def valley(p: np.ndarray) -> float:
    """狭长山谷：x 方向很平（系数 1），y 方向很陡（系数 50）。"""
    x, y = p
    return 0.5 * (x ** 2 + 50 * y ** 2)


def valley_grad(p: np.ndarray) -> np.ndarray:
    x, y = p
    return np.array([x, 50 * y])


# ---------------- 优化器：都只有一个 step(params, grad) ----------------
class SGD:
    def __init__(self, lr: float):
        self.lr = lr

    def step(self, p: np.ndarray, g: np.ndarray) -> np.ndarray:
        return p - self.lr * g


class Momentum:
    """v ← β·v + g；p ← p − lr·v。与 torch.optim.SGD(momentum=β) 的定义一致。"""

    def __init__(self, lr: float, beta: float = 0.9):
        self.lr, self.beta = lr, beta
        self.v = None

    def step(self, p, g):
        self.v = g.copy() if self.v is None else self.beta * self.v + g
        return p - self.lr * self.v


class Adam:
    """m 是梯度的滑动平均（方向），v 是梯度平方的滑动平均（尺度），再做偏差修正。"""

    def __init__(self, lr: float, beta1: float = 0.9, beta2: float = 0.999, eps: float = 1e-8):
        self.lr, self.b1, self.b2, self.eps = lr, beta1, beta2, eps
        self.m = self.v = None
        self.t = 0

    def step(self, p, g):
        if self.m is None:
            self.m, self.v = np.zeros_like(p), np.zeros_like(p)
        self.t += 1
        self.m = self.b1 * self.m + (1 - self.b1) * g
        self.v = self.b2 * self.v + (1 - self.b2) * g * g
        m_hat = self.m / (1 - self.b1 ** self.t)
        v_hat = self.v / (1 - self.b2 ** self.t)
        return p - self.lr * m_hat / (np.sqrt(v_hat) + self.eps)


def run(opt, start=(-1.5, 2.0), steps: int = 3000, f=rosenbrock, grad=rosenbrock_grad):
    p = np.array(start, dtype=float)
    path = [p.copy()]
    for _ in range(steps):
        p = opt.step(p, grad(p))
        path.append(p.copy())
        if not np.all(np.isfinite(p)) or np.abs(p).max() > 1e6:
            break
    return np.array(path)


CONFIGS = {
    "SGD lr=1e-3": lambda: SGD(1e-3),
    "Momentum lr=1e-3 β=0.9": lambda: Momentum(1e-3, 0.9),
    "Adam lr=0.05": lambda: Adam(0.05),
}


def report(paths: dict[str, np.ndarray], checkpoints=(100, 500, 1000, 3000)):
    target = np.array([1.0, 1.0])
    for name, path in paths.items():
        cells = []
        for c in checkpoints:
            if c < len(path):
                cells.append(f"{c}:{np.linalg.norm(path[c] - target):.4f}")
            else:
                cells.append(f"{c}:diverged")
        print(f"  {name:<24} 距最优点 (1,1) 的距离  " + "  ".join(cells))


def plot(paths: dict[str, np.ndarray], path_png: str):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))
    xs, ys = np.meshgrid(np.linspace(-2, 2, 400), np.linspace(-1, 3, 400))
    zs = (1 - xs) ** 2 + 100 * (ys - xs ** 2) ** 2
    ax1.contour(xs, ys, np.log10(zs + 1e-3), levels=30, cmap="Greys", linewidths=0.6)
    colors = ["#d62728", "#1f77b4", "#2ca02c"]
    for (name, path), c in zip(paths.items(), colors):
        ax1.plot(path[:, 0], path[:, 1], color=c, lw=1.2, label=name)
        ax1.plot(*path[-1], "o", color=c, ms=5)
        losses = [rosenbrock(p) for p in path]
        ax2.semilogy(losses, color=c, label=name)
    ax1.plot(-1.5, 2.0, "k^", ms=8, label="start (-1.5, 2)")
    ax1.plot(1, 1, "k*", ms=12, label="optimum (1, 1)")
    ax1.set_xlim(-2, 2)
    ax1.set_ylim(-1, 3)
    ax1.set_title("Rosenbrock: trajectories (3000 steps)")
    ax1.legend(fontsize=8)
    ax2.set_title("f(x, y) vs step (log scale)")
    ax2.set_xlabel("step")
    ax2.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(path_png, dpi=120)
    plt.close(fig)


def plot_valley(path_png: str, steps: int = 60):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    cfgs = {"SGD lr=0.038": SGD(0.038), "Momentum lr=0.01 β=0.9": Momentum(0.01, 0.9), "Adam lr=0.3": Adam(0.3)}
    paths = {n: run(o, start=(-9.0, 1.5), steps=steps, f=valley, grad=valley_grad) for n, o in cfgs.items()}
    fig, ax = plt.subplots(figsize=(9, 3.6))
    xs, ys = np.meshgrid(np.linspace(-10, 2, 300), np.linspace(-2, 2, 300))
    ax.contour(xs, ys, 0.5 * (xs ** 2 + 50 * ys ** 2), levels=25, cmap="Greys", linewidths=0.6)
    for (name, path), c in zip(paths.items(), ["#d62728", "#1f77b4", "#2ca02c"]):
        ax.plot(path[:, 0], path[:, 1], "-o", ms=2, lw=1, color=c, label=name)
    ax.plot(0, 0, "k*", ms=12)
    ax.set_title(f"narrow valley f = (x² + 50y²)/2, {steps} steps from (-9, 1.5)")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(path_png, dpi=120)
    plt.close(fig)
    for name, path in paths.items():
        print(f"  {name:<24} {steps} 步后 f={valley(path[-1]):.5f}")


def main():
    os.makedirs(IMG_DIR, exist_ok=True)
    print("SGD 学习率扫描（更大就发散）：")
    report({f"SGD lr={lr}": run(SGD(lr)) for lr in (1e-3, 2e-3, 3e-3)})
    print("\n三种优化器对比：")
    paths = {name: run(make()) for name, make in CONFIGS.items()}
    report(paths)
    out = os.path.join(IMG_DIR, "optimizers-rosenbrock.png")
    plot(paths, out)
    print(f"\nsaved {out}")
    print("\n狭长山谷：")
    out2 = os.path.join(IMG_DIR, "optimizers-valley.png")
    plot_valley(out2)
    print(f"saved {out2}")


if __name__ == "__main__":
    main()
