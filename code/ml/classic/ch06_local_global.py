"""第 6 章 局部最优与全局最优：梯度下降只看脚下的坡。"""
import numpy as np


def f(x):
    """两个谷底的一元函数：x≈-1.47 是全局最低，x≈1.35 是较浅的局部最低。"""
    return x**4 - 4 * x**2 + x


def df(x):
    return 4 * x**3 - 8 * x + 1


def gd_1d(x0, lr=0.01, steps=2000, grad=df):
    x = float(x0)
    path = [x]
    for _ in range(steps):
        x -= lr * grad(x)
        path.append(x)
    return x, np.array(path)


def multi_start(xs0, **kw):
    """多起点：从每个起点各跑一次 GD，取损失最小的那个。"""
    ends = np.array([gd_1d(x0, **kw)[0] for x0 in xs0])
    best = ends[np.argmin(f(ends))]
    return best, ends


def grid_min(lo=-3, hi=3, n=600001):
    """暴力网格：一维才付得起的「标准答案」。"""
    xs = np.linspace(lo, hi, n)
    return xs[np.argmin(f(xs))]


def f2(p):
    """二维多谷函数，用来展示随机起点会落进不同的谷。"""
    x, y = p[..., 0], p[..., 1]
    return np.sin(3 * x) * np.cos(3 * y) + 0.1 * (x**2 + y**2)


def df2(p):
    x, y = p[..., 0], p[..., 1]
    gx = 3 * np.cos(3 * x) * np.cos(3 * y) + 0.2 * x
    gy = -3 * np.sin(3 * x) * np.sin(3 * y) + 0.2 * y
    return np.stack([gx, gy], -1)


def main():
    from scipy.optimize import minimize

    from .common import plt, save

    for x0 in [-2.0, -0.5, 0.3, 2.0]:
        x_end, _ = gd_1d(x0)
        print(f"GD 起点 {x0:+.1f} -> 停在 x={x_end:+.4f}  f={f(x_end):.4f}")
    xg = grid_min()
    print(f"暴力网格全局最低   x={xg:+.4f}  f={f(xg):.4f}")
    r = minimize(lambda v: f(v[0]), x0=[2.0], method="BFGS")
    print(f"scipy BFGS 起点 2  x={r.x[0]:+.4f}  f={r.fun:.4f}   <- 换了更聪明的局部优化器也一样被困")
    rng = np.random.default_rng(0)
    best, ends = multi_start(rng.uniform(-3, 3, 10))
    n_global = int(np.sum(np.isclose(ends, xg, atol=1e-3)))
    print(f"10 个随机起点: {n_global} 个到了全局最低, 多起点取最优 x={best:+.4f}")

    # 图 1：一维函数 + 两条 GD 轨迹
    xs = np.linspace(-2.3, 2.3, 400)
    fig, ax = plt.subplots(figsize=(6.5, 4))
    ax.plot(xs, f(xs), "k", lw=1.5)
    for x0, c in [(-2.0, "tab:green"), (2.0, "tab:red")]:
        _, path = gd_1d(x0, steps=60, lr=0.02)
        ax.plot(path, f(path), "o-", color=c, ms=3, lw=0.8, label=f"起点 {x0:+.0f}")
    ax.annotate("全局最优", (-1.47, f(-1.47)), (-1.2, -1.5), arrowprops=dict(arrowstyle="->"))
    ax.annotate("局部最优", (1.35, f(1.35)), (1.0, 1.0), arrowprops=dict(arrowstyle="->"))
    ax.set_xlabel("x")
    ax.set_ylabel("f(x)")
    ax.set_title("同一个 GD，起点不同，落进不同的谷")
    ax.legend()
    save(fig, "06-two-valleys.png")

    # 图 2：二维多谷函数 + 多个随机起点
    g = np.linspace(-3, 3, 300)
    X, Y = np.meshgrid(g, g)
    Z = f2(np.stack([X, Y], -1))
    fig, ax = plt.subplots(figsize=(5.5, 5))
    ax.contourf(X, Y, Z, levels=30, cmap="viridis")
    rng = np.random.default_rng(3)
    for p0 in rng.uniform(-2.8, 2.8, (12, 2)):
        p = p0.copy()
        path = [p.copy()]
        for _ in range(200):
            p -= 0.05 * df2(p)
            path.append(p.copy())
        path = np.array(path)
        ax.plot(path[:, 0], path[:, 1], "w-", lw=1)
        ax.plot(*path[0], "wo", ms=4)
        ax.plot(*path[-1], "r*", ms=9)
    ax.set_title("12 个随机起点 → 停在不同的局部最低（红星）")
    save(fig, "06-multi-valley-2d.png")


if __name__ == "__main__":
    main()
