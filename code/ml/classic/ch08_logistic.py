"""第 8 章 二分类：逻辑回归 = 线性打分 + sigmoid + 交叉熵。"""
import numpy as np


def sigmoid(z):
    # 分两支写，避免 exp 溢出
    out = np.empty_like(z, dtype=float)
    pos = z >= 0
    out[pos] = 1 / (1 + np.exp(-z[pos]))
    ez = np.exp(z[~pos])
    out[~pos] = ez / (1 + ez)
    return out


def device_data(n=200, seed=0):
    """设备温度(°C) -> 当天是否故障。温度越高越容易坏：P(坏)=σ(0.25·(t-75))。"""
    rng = np.random.default_rng(seed)
    t = rng.uniform(50, 100, n)
    p = sigmoid(0.25 * (t - 75))
    y = (rng.uniform(size=n) < p).astype(int)
    return t, y


def bce(p, y, eps=1e-12):
    p = np.clip(p, eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


class LogisticRegressionGD:
    """手写逻辑回归。

    目标：mean(BCE) + 1/(2·C·n)·‖w‖²（偏置不罚）。
    这和 sklearn 的 C·ΣBCE + ½‖w‖² 只差一个正数倍，最优点相同，所以 C 的含义一致。
    """

    def __init__(self, C=1.0, lr=0.5, epochs=5000, standardize=True):
        self.C, self.lr, self.epochs, self.standardize = C, lr, epochs, standardize

    def _prep(self, X):
        X = np.asarray(X, float)
        return X[:, None] if X.ndim == 1 else X

    def fit(self, X, y):
        X = self._prep(X)
        y = np.asarray(y, float)
        n, d = X.shape
        # 标准化只是为了让 GD 好走；最后会把参数换算回原始尺度
        self.mu_ = X.mean(0) if self.standardize else np.zeros(d)
        self.sd_ = X.std(0) if self.standardize else np.ones(d)
        self.sd_[self.sd_ == 0] = 1
        Z = (X - self.mu_) / self.sd_
        w, b = np.zeros(d), 0.0
        lam = 1.0 / (self.C * n) if self.C != np.inf else 0.0
        # 正则项罚的是原始尺度的 w = w_z / sd，所以 z 空间里每一维的惩罚系数是 lam / sd²
        pen = lam / self.sd_**2
        self.loss_ = []
        for _ in range(self.epochs):
            p = sigmoid(Z @ w + b)
            err = p - y  # ∂BCE/∂z 就是这么干净
            gw = Z.T @ err / n
            gb = err.mean()
            # 正则项做隐式更新 w ← (w - lr·g) / (1 + lr·pen)：pen 很大时也不会发散
            w = (w - self.lr * gw) / (1 + self.lr * pen)
            b -= self.lr * gb
            self.loss_.append(bce(p, y) + 0.5 * np.sum(pen * w**2))
        self.coef_ = w / self.sd_
        self.intercept_ = b - self.mu_ @ self.coef_
        return self

    def decision_function(self, X):
        return self._prep(X) @ self.coef_ + self.intercept_

    def predict_proba(self, X):
        p1 = sigmoid(self.decision_function(X))
        return np.column_stack([1 - p1, p1])

    def predict(self, X, threshold=0.5):
        return (self.predict_proba(X)[:, 1] >= threshold).astype(int)


def main():
    from sklearn.linear_model import LogisticRegression

    from .common import plt, save

    t, y = device_data()
    ours = LogisticRegressionGD(C=1.0).fit(t, y)
    sk = LogisticRegression(C=1.0).fit(t[:, None], y)
    print(f"手写   : w={ours.coef_[0]:.4f} b={ours.intercept_:.4f}")
    print(f"sklearn: w={sk.coef_[0, 0]:.4f} b={sk.intercept_[0]:.4f}")
    for temp in [60, 75, 85, 95]:
        print(f"  {temp}°C 故障概率  手写 {ours.predict_proba([temp])[0, 1]:.3f}  "
              f"sklearn {sk.predict_proba([[temp]])[0, 1]:.3f}")
    print(f"训练准确率 {np.mean(ours.predict(t) == y):.3f}，决策边界 t = {-ours.intercept_ / ours.coef_[0]:.2f}°C")

    # 为什么不用 MSE：对一个确信但错的样本，MSE 的梯度几乎为 0
    for z in [-6.0, -2.0, 0.0]:
        p = sigmoid(np.array([z]))[0]
        print(f"  真值 y=1, 打分 z={z:+.0f}, p={p:.4f}:  BCE 梯度 {p - 1:+.4f}   MSE 梯度 {2 * (p - 1) * p * (1 - p):+.4f}")

    # 图 1：数据 + sigmoid 曲线
    ts = np.linspace(45, 105, 300)
    fig, ax = plt.subplots(figsize=(6.5, 3.8))
    jitter = np.random.default_rng(1).uniform(-0.03, 0.03, len(y))
    ax.scatter(t, y + jitter, s=10, c=y, cmap="coolwarm", label="样本（0=正常, 1=故障）")
    ax.plot(ts, ours.predict_proba(ts)[:, 1], "k", label="P(故障 | 温度)")
    ax.axhline(0.5, ls=":", c="gray")
    ax.axvline(-ours.intercept_ / ours.coef_[0], ls="--", c="gray", label="阈值 0.5 对应的温度")
    ax.set_xlabel("设备温度 (°C)")
    ax.set_ylabel("概率")
    ax.set_title("逻辑回归：线性打分经过 sigmoid 变成概率")
    ax.legend(fontsize=8, loc="center left")
    save(fig, "08-sigmoid-fit.png")

    # 图 2：两种损失对比
    p = np.linspace(0.001, 0.999, 300)
    fig, ax = plt.subplots(figsize=(5.5, 3.6))
    ax.plot(p, -np.log(p), label="交叉熵 −log p")
    ax.plot(p, (1 - p) ** 2, label="平方误差 (1−p)²")
    ax.set_xlabel("模型给正确类别的概率 p（真值 y=1）")
    ax.set_ylabel("损失")
    ax.set_ylim(0, 5)
    ax.set_title("越确信地答错，交叉熵罚得越狠")
    ax.legend()
    save(fig, "08-bce-vs-mse.png")


if __name__ == "__main__":
    main()
