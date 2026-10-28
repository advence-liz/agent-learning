"""第 15 章 随机森林：Bootstrap 采样 + 每个节点随机挑特征 + 多棵树投票。"""
import numpy as np

from .ch14_decision_tree import DecisionTreeGini, moons


class RandomForest:
    def __init__(self, n_estimators=100, max_features="sqrt", max_depth=None, random_state=0, oob=True):
        self.n_estimators = n_estimators
        self.max_features = max_features
        self.max_depth = max_depth
        self.random_state = random_state
        self.oob = oob

    def fit(self, X, y):
        X, y = np.asarray(X, float), np.asarray(y)
        n, d = X.shape
        self.classes_ = np.unique(y)
        mf = max(1, int(np.sqrt(d))) if self.max_features == "sqrt" else (self.max_features or d)
        rng = np.random.default_rng(self.random_state)
        self.trees_ = []
        oob_votes = np.zeros((n, len(self.classes_)))
        for _ in range(self.n_estimators):
            idx = rng.integers(0, n, n)  # 有放回抽 n 个：约 63.2% 的样本会被抽到
            tree = DecisionTreeGini(max_depth=self.max_depth, max_features=mf,
                                    random_state=int(rng.integers(1 << 31))).fit(X[idx], y[idx])
            # 树内部的类别编号可能只覆盖部分类别，映射回全局
            tree.global_cols_ = np.searchsorted(self.classes_, tree.classes_)
            self.trees_.append(tree)
            if self.oob:
                out = np.setdiff1d(np.arange(n), idx)  # 没被抽到的样本 = 这棵树的「免费验证集」
                P = np.zeros((len(out), len(self.classes_)))
                P[:, tree.global_cols_] = tree.predict_proba(X[out])
                oob_votes[out] += P
        if self.oob:
            seen = oob_votes.sum(1) > 0
            self.oob_score_ = float(np.mean(self.classes_[np.argmax(oob_votes[seen], 1)] == y[seen]))
        return self

    def predict_proba(self, X):
        X = np.asarray(X, float)
        P = np.zeros((len(X), len(self.classes_)))
        for t in self.trees_:
            P[:, t.global_cols_] += t.predict_proba(X)  # 与 sklearn 一样：平均每棵树的概率（软投票）
        return P / len(self.trees_)

    def predict(self, X):
        return self.classes_[np.argmax(self.predict_proba(X), axis=1)]


def main():
    from sklearn.datasets import load_digits
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import train_test_split

    from .common import plt, save

    X, y = moons()
    Xtr, Xte, ytr, yte = X[:700], X[700:], y[:700], y[700:]

    # 单棵树对训练数据有多敏感：换 10 份 bootstrap，看测试集预测的分歧
    rng = np.random.default_rng(0)
    preds = []
    for _ in range(10):
        idx = rng.integers(0, 700, 700)
        preds.append(DecisionTreeGini().fit(Xtr[idx], ytr[idx]).predict(Xte))
    preds = np.array(preds)
    disagree = np.mean(preds.min(0) != preds.max(0))
    accs = (preds == yte).mean(1)
    print(f"10 棵不限深度的单树: test_acc {accs.min():.3f}~{accs.max():.3f}, "
          f"{disagree:.1%} 的测试点至少有两棵树意见不同")

    for n in [1, 10, 100]:
        rf = RandomForest(n_estimators=n, random_state=0).fit(Xtr, ytr)
        sk = RandomForestClassifier(n_estimators=n, random_state=0, oob_score=n >= 10).fit(Xtr, ytr)
        oob = f"OOB={rf.oob_score_:.3f} / sklearn OOB={sk.oob_score_:.3f}" if n >= 10 else ""
        print(f"森林 {n:>3} 棵: 手写 test_acc={np.mean(rf.predict(Xte) == yte):.3f}  "
              f"sklearn test_acc={np.mean(sk.predict(Xte) == yte):.3f}  {oob}")

    Xd, yd = load_digits(return_X_y=True)
    dtr, dte, ydtr, ydte = train_test_split(Xd, yd, test_size=0.3, random_state=0, stratify=yd)
    tree = DecisionTreeGini(random_state=0).fit(dtr, ydtr)
    rf = RandomForest(n_estimators=50, random_state=0).fit(dtr, ydtr)
    sk = RandomForestClassifier(n_estimators=50, random_state=0).fit(dtr, ydtr)
    print(f"digits: 单树 {np.mean(tree.predict(dte) == ydte):.3f}  手写森林(50棵, 每节点 8/64 个特征) "
          f"{np.mean(rf.predict(dte) == ydte):.3f}  sklearn 森林 {np.mean(sk.predict(dte) == ydte):.3f}")

    g0, g1 = np.meshgrid(np.linspace(-2, 3, 200), np.linspace(-1.6, 2.1, 200))
    grid = np.column_stack([g0.ravel(), g1.ravel()])
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.6), sharey=True)
    rng = np.random.default_rng(1)
    for ax, title in zip(axes[:2], ["单树（bootstrap 样本 A）", "单树（bootstrap 样本 B）"]):
        idx = rng.integers(0, 700, 700)
        m = DecisionTreeGini().fit(Xtr[idx], ytr[idx])
        ax.contourf(g0, g1, m.predict(grid).reshape(g0.shape), alpha=0.3, cmap="coolwarm")
        ax.scatter(Xtr[:, 0], Xtr[:, 1], c=ytr, s=5, cmap="coolwarm")
        ax.set_title(f"{title} acc={np.mean(m.predict(Xte) == yte):.3f}")
    rf = RandomForest(n_estimators=100, random_state=0).fit(Xtr, ytr)
    axes[2].contourf(g0, g1, rf.predict_proba(grid)[:, 1].reshape(g0.shape), levels=20, alpha=0.5, cmap="coolwarm")
    axes[2].scatter(Xtr[:, 0], Xtr[:, 1], c=ytr, s=5, cmap="coolwarm")
    axes[2].set_title(f"100 棵树平均 acc={np.mean(rf.predict(Xte) == yte):.3f}")
    fig.suptitle("单树的边界随数据剧烈抖动；森林把抖动平均掉，边界变平滑")
    save(fig, "15-forest-vs-tree.png")

    ns = [1, 2, 5, 10, 20, 50, 100, 200]
    big = RandomForest(n_estimators=200, random_state=0, oob=False).fit(Xtr, ytr)
    accs = []
    for n in ns:
        P = sum(t.predict_proba(Xte) for t in big.trees_[:n])
        accs.append(np.mean(np.argmax(P, 1) == yte))
    fig, ax = plt.subplots(figsize=(5.5, 3.5))
    ax.plot(ns, accs, "o-")
    ax.set_xscale("log")
    ax.set_xlabel("树的数量")
    ax.set_ylabel("测试准确率")
    ax.set_title("树越多越稳，但很快就饱和")
    save(fig, "15-n-trees.png")


if __name__ == "__main__":
    main()
