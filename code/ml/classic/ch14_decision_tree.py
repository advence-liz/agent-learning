"""第 14 章 决策树（CART）：贪心地挑「让基尼不纯度下降最多」的那个问题。"""
from dataclasses import dataclass

import numpy as np


def gini(counts):
    """counts: (..., k) 每类样本数 -> 基尼不纯度 1 - Σp²。"""
    counts = np.asarray(counts, float)
    n = counts.sum(-1, keepdims=True)
    p = np.divide(counts, n, out=np.zeros_like(counts), where=n > 0)
    return 1 - (p**2).sum(-1)


@dataclass
class Node:
    counts: np.ndarray
    feature: int = -1
    threshold: float = 0.0
    left: "Node | None" = None
    right: "Node | None" = None

    @property
    def is_leaf(self):
        return self.left is None


def best_split(X, y, k, features):
    """对每个候选特征：排序 → 累加类别计数 → 一次性算出所有切点的加权基尼，取最小。

    返回 (加权不纯度, feature, threshold)；没有可用切点时返回 None。
    """
    n = len(y)
    best = None
    for f in features:
        order = np.argsort(X[:, f], kind="stable")
        xs, ys = X[order, f], y[order]
        left = np.cumsum(np.eye(k)[ys], axis=0)[:-1]  # 第 i 行 = 前 i+1 个样本的类别计数
        total = left[-1] + np.eye(k)[ys[-1]]
        right = total - left
        nl = np.arange(1, n)
        w = (nl * gini(left) + (n - nl) * gini(right)) / n
        valid = xs[1:] > xs[:-1]  # 相同取值之间不能切
        if not valid.any():
            continue
        w = np.where(valid, w, np.inf)
        i = int(np.argmin(w))
        if best is None or w[i] < best[0] - 1e-12:
            best = (float(w[i]), int(f), float((xs[i] + xs[i + 1]) / 2))
    return best


class DecisionTreeGini:
    def __init__(self, max_depth=None, min_samples_split=2, max_features=None, random_state=None):
        self.max_depth = max_depth
        self.min_samples_split = min_samples_split
        self.max_features = max_features  # None=全部特征；int=每个节点随机挑这么多个（随机森林用）
        self.rng = np.random.default_rng(random_state)

    def fit(self, X, y):
        X = np.asarray(X, float)
        self.classes_, yi = np.unique(y, return_inverse=True)
        self.k_ = len(self.classes_)
        self.n_features_ = X.shape[1]
        self.importances_ = np.zeros(self.n_features_)
        self.n_ = len(yi)
        self.root_ = self._grow(X, yi, depth=0)
        s = self.importances_.sum()
        self.feature_importances_ = self.importances_ / s if s > 0 else self.importances_
        return self

    def _grow(self, X, y, depth):
        counts = np.bincount(y, minlength=self.k_)
        node = Node(counts=counts)
        imp = gini(counts)
        if (imp == 0 or len(y) < self.min_samples_split
                or (self.max_depth is not None and depth >= self.max_depth)):
            return node
        feats = np.arange(self.n_features_)
        if self.max_features is not None:
            feats = self.rng.choice(feats, self.max_features, replace=False)
        split = best_split(X, y, self.k_, feats)
        if split is None or split[0] >= imp:
            return node
        w_imp, f, t = split
        # 特征重要性 = 这个特征带来的「样本数加权的不纯度下降」之和
        self.importances_[f] += len(y) / self.n_ * (imp - w_imp)
        mask = X[:, f] <= t
        node.feature, node.threshold = f, t
        node.left = self._grow(X[mask], y[mask], depth + 1)
        node.right = self._grow(X[~mask], y[~mask], depth + 1)
        return node

    def _leaf(self, x):
        node = self.root_
        while not node.is_leaf:
            node = node.left if x[node.feature] <= node.threshold else node.right
        return node

    def predict_proba(self, X):
        out = np.array([self._leaf(x).counts for x in np.asarray(X, float)], float)
        return out / out.sum(1, keepdims=True)

    def predict(self, X):
        return self.classes_[np.argmax(self.predict_proba(X), axis=1)]

    def depth(self, node=None):
        node = node or self.root_
        return 0 if node.is_leaf else 1 + max(self.depth(node.left), self.depth(node.right))

    def n_leaves(self, node=None):
        node = node or self.root_
        return 1 if node.is_leaf else self.n_leaves(node.left) + self.n_leaves(node.right)

    def to_text(self, names=None, node=None, indent=""):
        node = node or self.root_
        names = names or [f"x{i}" for i in range(self.n_features_)]
        if node.is_leaf:
            return f"{indent}leaf counts={node.counts.tolist()} -> {self.classes_[np.argmax(node.counts)]}\n"
        s = f"{indent}if {names[node.feature]} <= {node.threshold:.3f}:  (gini={gini(node.counts):.3f}, n={node.counts.sum()})\n"
        s += self.to_text(names, node.left, indent + "  ")
        s += f"{indent}else:\n"
        s += self.to_text(names, node.right, indent + "  ")
        return s


def moons(n=1000, noise=0.3, seed=0):
    from sklearn.datasets import make_moons

    return make_moons(n_samples=n, noise=noise, random_state=seed)


def main():
    from sklearn.tree import DecisionTreeClassifier

    from .common import plt, save

    print("基尼不纯度: [5,5] ->", gini([5, 5]), " [9,1] ->", round(float(gini([9, 1])), 3), " [10,0] ->", gini([10, 0]))
    X, y = moons()
    Xtr, Xte, ytr, yte = X[:700], X[700:], y[:700], y[700:]
    t = DecisionTreeGini(max_depth=2).fit(Xtr, ytr)
    print(t.to_text(["x1", "x2"]), end="")
    sk2 = DecisionTreeClassifier(max_depth=2, random_state=0).fit(Xtr, ytr)
    print(f"sklearn 根节点: x{sk2.tree_.feature[0] + 1} <= {sk2.tree_.threshold[0]:.3f}")

    print("max_depth  叶子数  train_acc  test_acc  sklearn_test_acc  预测一致率")
    for d in [1, 2, 4, 6, 10, None]:
        m = DecisionTreeGini(max_depth=d).fit(Xtr, ytr)
        sk = DecisionTreeClassifier(max_depth=d, random_state=0).fit(Xtr, ytr)
        p = m.predict(Xte)
        print(f"{str(d):<9}  {m.n_leaves():>6}  {np.mean(m.predict(Xtr) == ytr):9.3f}  {np.mean(p == yte):8.3f}  "
              f"{np.mean(sk.predict(Xte) == yte):16.3f}  {np.mean(p == sk.predict(Xte)):9.3f}")

    g0, g1 = np.meshgrid(np.linspace(-2, 3, 250), np.linspace(-1.6, 2.1, 250))
    grid = np.column_stack([g0.ravel(), g1.ravel()])
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.6), sharey=True)
    for ax, d in zip(axes, [2, 5, None]):
        m = DecisionTreeGini(max_depth=d).fit(Xtr, ytr)
        ax.contourf(g0, g1, m.predict(grid).reshape(g0.shape), alpha=0.3, cmap="coolwarm")
        ax.scatter(Xtr[:, 0], Xtr[:, 1], c=ytr, s=6, cmap="coolwarm")
        ax.set_title(f"max_depth={d}  test_acc={np.mean(m.predict(Xte) == yte):.3f}")
    fig.suptitle("每次切分都是一条横线或竖线：决策树的边界是一堆矩形")
    save(fig, "14-tree-boundary.png")

    # 图 2：根节点处，两个特征的每个候选阈值的加权基尼
    fig, ax = plt.subplots(figsize=(6, 3.6))
    for f in (0, 1):
        order = np.argsort(Xtr[:, f])
        xs, ys = Xtr[order, f], ytr[order]
        left = np.cumsum(np.eye(2)[ys], 0)[:-1]
        right = left[-1] + np.eye(2)[ys[-1]] - left
        nl = np.arange(1, len(ys))
        w = (nl * gini(left) + (len(ys) - nl) * gini(right)) / len(ys)
        ax.plot((xs[1:] + xs[:-1]) / 2, w, label=f"按 x{f + 1} 切")
    ax.axhline(gini(np.bincount(ytr)), ls=":", c="gray", label="切之前")
    ax.set_xlabel("阈值")
    ax.set_ylabel("切分后的加权基尼")
    ax.set_title("把所有候选问题都试一遍，选最低点")
    ax.legend()
    save(fig, "14-split-search.png")


if __name__ == "__main__":
    main()
