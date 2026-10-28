"""第 11 章 多分类：Softmax 回归。"""
import numpy as np


def softmax(Z):
    """按行 softmax。先减去每行最大值：结果不变，但 exp 不会溢出。"""
    Z = Z - Z.max(axis=1, keepdims=True)
    E = np.exp(Z)
    return E / E.sum(axis=1, keepdims=True)


def cross_entropy(P, y, eps=1e-12):
    return float(-np.mean(np.log(P[np.arange(len(y)), y] + eps)))


def one_hot(y, k):
    Y = np.zeros((len(y), k))
    Y[np.arange(len(y)), y] = 1
    return Y


class SoftmaxRegressionGD:
    """手写 softmax 回归：mean(CE) + 1/(2·C·n)·‖W‖²，偏置不罚（与 sklearn 的 C 同义）。"""

    def __init__(self, C=1.0, lr=0.5, epochs=3000, standardize=True):
        self.C, self.lr, self.epochs, self.standardize = C, lr, epochs, standardize

    def fit(self, X, y):
        X = np.asarray(X, float)
        y = np.asarray(y)
        self.classes_ = np.unique(y)
        yi = np.searchsorted(self.classes_, y)
        n, d = X.shape
        k = len(self.classes_)
        self.mu_ = X.mean(0) if self.standardize else np.zeros(d)
        self.sd_ = X.std(0) if self.standardize else np.ones(d)
        self.sd_[self.sd_ == 0] = 1
        Zx = (X - self.mu_) / self.sd_
        Y = one_hot(yi, k)
        W, b = np.zeros((d, k)), np.zeros(k)
        pen = (1.0 / (self.C * n)) / self.sd_[:, None] ** 2
        self.loss_ = []
        for _ in range(self.epochs):
            P = softmax(Zx @ W + b)
            G = (P - Y) / n  # 和二分类一样干净：预测概率 - one-hot
            # 正则项用「隐式」一步：某些像素几乎恒定、sd 极小，pen 会很大，显式更新会发散
            W = (W - self.lr * (Zx.T @ G)) / (1 + self.lr * pen)
            b -= self.lr * G.sum(0)
            self.loss_.append(cross_entropy(P, yi))
        self.coef_ = (W / self.sd_[:, None]).T  # (k, d)，与 sklearn 同形
        self.intercept_ = b - self.mu_ @ self.coef_.T
        return self

    def decision_function(self, X):
        return np.asarray(X, float) @ self.coef_.T + self.intercept_

    def predict_proba(self, X):
        return softmax(self.decision_function(X))

    def predict(self, X):
        return self.classes_[np.argmax(self.decision_function(X), axis=1)]


def main():
    from sklearn.datasets import load_digits
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split

    from .common import plt, save

    z = np.array([[2.0, 1.0, 0.1]])
    print("logits [2, 1, 0.1] -> softmax", np.round(softmax(z), 4))
    print("logits 都加 100     -> softmax", np.round(softmax(z + 100), 4), " (平移不变)")
    print("logits 都乘 3       -> softmax", np.round(softmax(z * 3), 4), " (更尖：相当于温度降低)")

    X, y = load_digits(return_X_y=True)
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.3, random_state=0, stratify=y)
    ours = SoftmaxRegressionGD(C=0.05, lr=0.5, epochs=3000).fit(Xtr, ytr)
    sk = LogisticRegression(C=0.05, max_iter=5000).fit(Xtr, ytr)
    acc, acc_sk = np.mean(ours.predict(Xte) == yte), np.mean(sk.predict(Xte) == yte)
    print(f"digits 10 分类 测试准确率  手写 {acc:.4f}  sklearn {acc_sk:.4f}  "
          f"概率最大差 {np.abs(ours.predict_proba(Xte) - sk.predict_proba(Xte)).max():.2e}")
    P = ours.predict_proba(Xte[:1])[0]
    top = np.argsort(-P)[:3]
    print(f"第 1 张测试图(真值 {yte[0]}) top-3: " + ", ".join(f"{c}:{P[c]:.3f}" for c in top))

    fig, axes = plt.subplots(1, 2, figsize=(10, 3.4))
    axes[0].bar(range(10), P)
    axes[0].set_xticks(range(10))
    axes[0].set_title(f"一张「{yte[0]}」的 10 类概率（和为 1）")
    for tau in [0.5, 1, 3]:
        axes[1].plot(softmax(np.array([[2.0, 1.0, 0.1, -1.0]]) / tau)[0], "o-", label=f"温度 T={tau}")
    axes[1].set_xticks(range(4))
    axes[1].set_title("logits / T 再 softmax：T 越小越尖")
    axes[1].legend()
    save(fig, "11-softmax-probs.png")

    fig, axes = plt.subplots(1, 10, figsize=(12, 1.6))
    for c in range(10):
        Wc = ours.coef_[c].reshape(8, 8)
        lim = np.abs(Wc).max()
        axes[c].imshow(Wc, cmap="bwr", vmin=-lim, vmax=lim)
        axes[c].set_title(str(c))
        axes[c].axis("off")
    fig.suptitle("每个类别一张权重图（红=支持该类）", y=1.08)
    save(fig, "11-class-weights.png")


if __name__ == "__main__":
    main()
