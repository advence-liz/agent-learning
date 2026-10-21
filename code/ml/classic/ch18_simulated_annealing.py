"""第 18 章 模拟退火：允许偶尔「往上走」，靠温度控制这种胆量。"""
import itertools

import numpy as np

from .ch06_local_global import f as f1d
from .ch06_local_global import gd_1d, grid_min


def anneal(loss, x0, neighbor, T0=2.0, alpha=0.995, steps=5000, seed=0):
    """通用模拟退火。

    loss(x) -> float；neighbor(x, rng, T) -> 新的候选解。
    Metropolis 准则：变好就接受；变差 Δ>0 时以概率 exp(-Δ/T) 接受。
    返回 (最好的解, 最好的损失, 轨迹 [(当前损失, 温度, 是否接受变差)])。
    """
    rng = np.random.default_rng(seed)
    x, fx = x0, loss(x0)
    best, fbest = x, fx
    T = T0
    trace = []
    for _ in range(steps):
        cand = neighbor(x, rng, T)
        fc = loss(cand)
        delta = fc - fx
        worse_accepted = False
        if delta <= 0 or rng.random() < np.exp(-delta / T):
            worse_accepted = delta > 0
            x, fx = cand, fc
            if fx < fbest:
                best, fbest = x, fx
        trace.append((fx, T, worse_accepted))
        T *= alpha  # 指数降温
    return best, fbest, trace


def gauss_step(scale=0.5):
    return lambda x, rng, T: x + rng.normal(0, scale)


# ---------- TSP：离散问题，梯度根本无从谈起 ----------

def tour_length(tour, D):
    return float(D[tour, np.roll(tour, -1)].sum())


def two_opt(tour, rng, T):
    """随机选一段路线翻转（2-opt 邻域）。"""
    i, j = sorted(rng.choice(len(tour), 2, replace=False))
    new = tour.copy()
    new[i : j + 1] = new[i : j + 1][::-1]
    return new


def random_cities(n, seed=0):
    rng = np.random.default_rng(seed)
    P = rng.uniform(0, 1, (n, 2))
    D = np.sqrt(((P[:, None] - P[None]) ** 2).sum(-1))
    return P, D


def brute_force_tsp(D):
    n = len(D)
    best, bl = None, np.inf
    for perm in itertools.permutations(range(1, n)):
        t = np.array((0,) + perm)
        L = tour_length(t, D)
        if L < bl:
            best, bl = t, L
    return best, bl


def greedy_descent(loss, x0, neighbor, steps, seed=0):
    """对照组：只接受变好的移动（T→0 的退火）。"""
    return anneal(loss, x0, neighbor, T0=1e-12, alpha=1.0, steps=steps, seed=seed)


def main():
    from scipy.optimize import dual_annealing

    from .common import plt, save

    x_gd, _ = gd_1d(2.0)
    print(f"GD     起点 +2.0 -> x={x_gd:+.4f} f={f1d(x_gd):.4f}  (局部最优)")
    xb, fb, trace = anneal(f1d, 2.0, gauss_step(0.5), T0=2.0, alpha=0.995, steps=3000, seed=0)
    n_worse = sum(t[2] for t in trace)
    print(f"退火   起点 +2.0 -> x={xb:+.4f} f={fb:.4f}  (接受过 {n_worse} 次变差)")
    xg, fg, _ = greedy_descent(f1d, 2.0, gauss_step(0.5), 3000)
    print(f"只接受变好 起点 +2.0 -> x={xg:+.4f} f={fg:.4f}")
    r = dual_annealing(lambda v: f1d(v[0]), bounds=[(-3, 3)], seed=0)
    print(f"scipy dual_annealing -> x={r.x[0]:+.4f} f={r.fun:.4f}   网格全局最优 x={grid_min():+.4f}")
    wins = sum(anneal(f1d, 2.0, gauss_step(0.5), steps=3000, seed=s)[1] < -5 for s in range(20))
    print(f"20 个随机种子里退火找到全局最优: {wins} 次")

    P, D = random_cities(9, seed=1)
    tour0 = np.arange(9)
    t_opt, L_opt = brute_force_tsp(D)
    t_sa, L_sa, tr_sa = anneal(lambda t: tour_length(t, D), tour0, two_opt, T0=0.5, alpha=0.998, steps=4000, seed=0)
    t_gr, L_gr, _ = greedy_descent(lambda t: tour_length(t, D), tour0, two_opt, 4000)
    print(f"TSP 9 城: 初始 {tour_length(tour0, D):.4f}  只接受变好 {L_gr:.4f}  退火 {L_sa:.4f}  暴力枚举 8!={40320} 条 -> {L_opt:.4f}")

    P30, D30 = random_cities(30, seed=2)
    t30 = np.arange(30)
    res = {}
    for name, kw in [("只接受变好", dict(T0=1e-12, alpha=1.0)), ("退火", dict(T0=0.5, alpha=0.9995))]:
        lens = [anneal(lambda t: tour_length(t, D30), t30, two_opt, steps=20000, seed=s, **kw)[1] for s in range(5)]
        res[name] = lens
        print(f"TSP 30 城 {name:<6} 5 次: {np.round(lens, 3).tolist()}  平均 {np.mean(lens):.3f}")

    # 图 1：1D 退火轨迹 + 温度
    fx = np.array([t[0] for t in trace])
    Ts = np.array([t[1] for t in trace])
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.6))
    axes[0].plot(fx, lw=0.6)
    axes[0].axhline(-5.444, c="g", ls=":", label="全局最低")
    axes[0].axhline(-2.619, c="r", ls=":", label="局部最低")
    axes[0].set_xlabel("步数")
    axes[0].set_ylabel("当前 f(x)")
    axes[0].set_title("高温时上蹿下跳，降温后稳定在全局谷底")
    axes[0].legend()
    d = np.linspace(0, 3, 100)
    for T in [2.0, 0.5, 0.1]:
        axes[1].plot(d, np.exp(-d / T), label=f"T={T}")
    axes[1].set_xlabel("变差幅度 Δ")
    axes[1].set_ylabel("接受概率 exp(-Δ/T)")
    axes[1].set_title("温度越低，越不敢接受变差")
    axes[1].legend()
    save(fig, "18-sa-1d.png")

    # 图 2：30 城 TSP
    t_g, L_g, _ = anneal(lambda t: tour_length(t, D30), t30, two_opt, T0=1e-12, alpha=1.0, steps=20000, seed=1)
    t_s, L_s, _ = anneal(lambda t: tour_length(t, D30), t30, two_opt, T0=0.5, alpha=0.9995, steps=20000, seed=1)
    fig, axes = plt.subplots(1, 2, figsize=(10, 4.6))
    for ax, t, L, name in [(axes[0], t_g, L_g, "只接受变好"), (axes[1], t_s, L_s, "模拟退火")]:
        c = P30[np.r_[t, t[0]]]
        ax.plot(c[:, 0], c[:, 1], "o-", ms=4)
        ax.set_title(f"{name}（seed=1）：路线长 {L:.3f}")
        ax.set_aspect("equal")
    save(fig, "18-tsp.png")


if __name__ == "__main__":
    main()
