"""第 16 章 K-Means：分配到最近质心 ↔ 质心移到簇均值，反复直到不动。"""
import numpy as np

from .ch12_knn import pairwise_sq_dist


def kmeans_pp_init(X, k, rng):
    """k-means++：第一个质心随机挑，之后按「到已有质心最近距离的平方」成比例抽样，让质心彼此散开。"""
    centers = [X[rng.integers(len(X))]]
    for _ in range(1, k):
        d2 = pairwise_sq_dist(X, np.array(centers)).min(1)
        centers.append(X[rng.choice(len(X), p=d2 / d2.sum())])
    return np.array(centers)


def kmeans(X, k, init="k-means++", max_iter=300, tol=1e-6, seed=0):
    """Lloyd 算法。返回 (centers, labels, inertia, 迭代次数, 每轮 inertia 历史)。"""
    X = np.asarray(X, float)
    rng = np.random.default_rng(seed)
    if isinstance(init, str):
        C = kmeans_pp_init(X, k, rng) if init == "k-means++" else X[rng.choice(len(X), k, replace=False)]
    else:
        C = np.array(init, float)
    history = []
    for it in range(1, max_iter + 1):
        D = pairwise_sq_dist(X, C)
        labels = D.argmin(1)  # 第一步：分配
        history.append(float(D[np.arange(len(X)), labels].sum()))
        newC = C.copy()
        for j in range(k):  # 第二步：更新（空簇保持原位）
            m = labels == j
            if m.any():
                newC[j] = X[m].mean(0)
        shift = float(((newC - C) ** 2).sum())
        C = newC
        if shift <= tol:
            break
    D = pairwise_sq_dist(X, C)
    labels = D.argmin(1)
    inertia = float(D[np.arange(len(X)), labels].sum())
    return C, labels, inertia, it, history


def best_of(X, k, n_init=10, seed=0, **kw):
    """多次随机初始化，取 inertia 最小的那次（sklearn 的 n_init 就是干这个）。"""
    runs = [kmeans(X, k, seed=seed + i, **kw) for i in range(n_init)]
    return min(runs, key=lambda r: r[2])


def main():
    from sklearn.cluster import KMeans
    from sklearn.datasets import make_blobs, make_moons

    from .common import plt, save

    X, y_true = make_blobs(n_samples=600, centers=4, cluster_std=1.0, random_state=7)
    C, labels, inertia, it, hist = kmeans(X, 4, seed=0)
    print(f"手写 k-means++: {it} 轮收敛, inertia={inertia:.2f}, 每轮 inertia: {np.round(hist[:6], 1).tolist()} ...")
    sk = KMeans(4, init=C, n_init=1).fit(X)  # 用同一组最终质心喂给 sklearn，它应该原地不动
    print(f"sklearn 以手写结果为初值: inertia={sk.inertia_:.2f}")
    init = X[[0, 1, 2, 3]]
    C1, _, in1, _, _ = kmeans(X, 4, init=init)
    sk1 = KMeans(4, init=init, n_init=1, algorithm="lloyd", tol=0).fit(X)
    print(f"同一初值 X[0:4]: 手写 inertia={in1:.4f}  sklearn inertia={sk1.inertia_:.4f}")

    print("随机初始化(非 ++) 10 次各自的 inertia:",
          [round(kmeans(X, 4, init="random", seed=s)[2]) for s in range(10)])
    ks = list(range(1, 10))
    inertias = [best_of(X, k)[2] for k in ks]
    print("肘部法 k -> inertia:", {k: round(v) for k, v in zip(ks, inertias)})

    # 图 1：迭代过程
    rng = np.random.default_rng(3)
    Cs = [X[rng.choice(len(X), 4, replace=False)]]
    for _ in range(3):
        lab = pairwise_sq_dist(X, Cs[-1]).argmin(1)
        Cs.append(np.array([X[lab == j].mean(0) if (lab == j).any() else Cs[-1][j] for j in range(4)]))
    fig, axes = plt.subplots(1, 4, figsize=(13, 3.3), sharey=True)
    for ax, i in zip(axes, range(4)):
        lab = pairwise_sq_dist(X, Cs[i]).argmin(1)
        ax.scatter(X[:, 0], X[:, 1], c=lab, s=5, cmap="tab10", vmin=0, vmax=9)
        ax.scatter(Cs[i][:, 0], Cs[i][:, 1], c="k", marker="X", s=120)
        if i:
            for a, b in zip(Cs[i - 1], Cs[i]):
                ax.annotate("", b, a, arrowprops=dict(arrowstyle="->", lw=1.5))
        ax.set_title(f"第 {i} 轮" if i else "随机初始质心")
    fig.suptitle("分配 → 更新 → 分配 → 更新……几轮就停了；但这次初值不好，停在一个坏解里")
    save(fig, "16-kmeans-steps.png")

    # 图 2：肘部法 + 失败案例
    fig, axes = plt.subplots(1, 3, figsize=(13, 3.5))
    axes[0].plot(ks, inertias, "o-")
    axes[0].set_xlabel("k")
    axes[0].set_ylabel("inertia")
    axes[0].set_title("肘部法：k=4 之后下降变缓")
    Xm, _ = make_moons(400, noise=0.05, random_state=0)
    _, lm, _, _, _ = best_of(Xm, 2)
    axes[1].scatter(Xm[:, 0], Xm[:, 1], c=lm, s=6, cmap="coolwarm")
    axes[1].set_title("月牙：K-Means 只会按距离切成两半")
    rng = np.random.default_rng(0)
    Xs = np.vstack([rng.normal([0, 0], [4, 0.4], (300, 2)), rng.normal([0, 3], [4, 0.4], (300, 2))])
    _, ls, _, _, _ = best_of(Xs, 2)
    axes[2].scatter(Xs[:, 0], Xs[:, 1], c=ls, s=6, cmap="coolwarm")
    axes[2].set_title("两条扁长带：被竖着切开")
    save(fig, "16-elbow-and-failures.png")


if __name__ == "__main__":
    main()
