"""第 12 章 K 近邻：不训练，只记住；预测时找最像的 k 个邻居投票。"""
import numpy as np


def pairwise_sq_dist(A, B):
    """‖a-b‖² = ‖a‖² - 2a·b + ‖b‖²，一次矩阵乘法算完所有距离。"""
    A, B = np.asarray(A, float), np.asarray(B, float)
    d = (A**2).sum(1)[:, None] - 2 * A @ B.T + (B**2).sum(1)[None, :]
    return np.maximum(d, 0)  # 浮点误差可能出现 -1e-12


class KNNClassifier:
    def __init__(self, k=5):
        self.k = k

    def fit(self, X, y):
        # 「训练」= 把数据存起来
        self.X_ = np.asarray(X, float)
        self.y_ = np.asarray(y)
        self.classes_ = np.unique(self.y_)
        return self

    def kneighbors(self, X):
        D = pairwise_sq_dist(X, self.X_)
        idx = np.argsort(D, axis=1, kind="stable")[:, : self.k]
        return np.sqrt(np.take_along_axis(D, idx, 1)), idx

    def predict(self, X):
        _, idx = self.kneighbors(X)
        labels = np.searchsorted(self.classes_, self.y_[idx])
        votes = np.apply_along_axis(np.bincount, 1, labels, minlength=len(self.classes_))
        # 平票时 argmax 取编号最小的类别，和 sklearn 的规则一致
        return self.classes_[np.argmax(votes, axis=1)]


def device_data(n=200, seed=0):
    """温度(°C)、振动(mm/s)、累计运行小时数(h)，1 = 需检修。

    只有温度和振动决定是否需要检修；运行小时数是个和标签无关、但数值大好几个量级的列。
    """
    rng = np.random.default_rng(seed)
    temp = rng.uniform(40, 100, n)
    vib = rng.uniform(0, 8, n)
    hours = rng.uniform(0, 10000, n)
    risk = (temp - 70) / 15 + (vib - 4) / 1.5
    y = (risk + rng.normal(0, 0.6, n) > 0).astype(int)
    return np.column_stack([temp, vib, hours]), y


def standardize(Xtr, *others):
    mu, sd = Xtr.mean(0), Xtr.std(0)
    return [(Xtr - mu) / sd] + [(X - mu) / sd for X in others]


def main():
    from sklearn.neighbors import KNeighborsClassifier

    from .common import plt, save

    X, y = device_data(300)
    Xtr, Xte, ytr, yte = X[:200], X[200:], y[:200], y[200:]
    new = np.array([[78.0, 5.5, 3000.0]])
    m = KNNClassifier(3).fit(Xtr, ytr)
    dist, idx = m.kneighbors(new)
    print(f"新设备 温度 78°C 振动 5.5mm/s 运行 3000h 的 3 个邻居(原始尺度):")
    for d, i in zip(dist[0], idx[0]):
        print(f"  temp={Xtr[i, 0]:.1f} vib={Xtr[i, 1]:.2f} hours={Xtr[i, 2]:.0f} label={ytr[i]} dist={d:.1f}")
    print(f"  -> 投票结果 {m.predict(new)[0]}")

    print("k   原始尺度acc  标准化后acc  sklearn(标准化)acc  只用温度+振动acc")
    Ztr, Zte = standardize(Xtr, Xte)
    for k in [1, 3, 5, 15, 51]:
        a_raw = np.mean(KNNClassifier(k).fit(Xtr, ytr).predict(Xte) == yte)
        a_z = np.mean(KNNClassifier(k).fit(Ztr, ytr).predict(Zte) == yte)
        a_sk = np.mean(KNeighborsClassifier(k).fit(Ztr, ytr).predict(Zte) == yte)
        a_2 = np.mean(KNNClassifier(k).fit(Ztr[:, :2], ytr).predict(Zte[:, :2]) == yte)
        print(f"{k:<3} {a_raw:>11.3f}  {a_z:>11.3f}  {a_sk:>17.3f}  {a_2:>15.3f}")
    Ztr, Zte, Xtr = Ztr[:, :2], Zte[:, :2], Xtr[:, :2]  # 下面画图只看前两个特征

    # 图：不同 k 的决策边界（标准化空间）
    g0, g1 = np.meshgrid(np.linspace(-2, 2, 200), np.linspace(-2, 2, 200))
    grid = np.column_stack([g0.ravel(), g1.ravel()])
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.8), sharey=True)
    for ax, k in zip(axes, [1, 15, 101]):
        Z = KNNClassifier(k).fit(Ztr, ytr).predict(grid).reshape(g0.shape)
        ax.contourf(g0, g1, Z, alpha=0.25, cmap="coolwarm")
        ax.scatter(Ztr[:, 0], Ztr[:, 1], c=ytr, cmap="coolwarm", s=12, edgecolors="k", linewidths=0.3)
        ax.set_title(f"k={k}")
        ax.set_xlabel("温度（标准化）")
    axes[0].set_ylabel("振动（标准化）")
    fig.suptitle("k 太小：边界被个别噪声点牵着走；k 变大：边界越来越平滑")
    save(fig, "12-knn-k.png")

    # 图：特征尺度
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
    axes[0].scatter(Xtr[:, 0], Xtr[:, 1], c=ytr, cmap="coolwarm", s=12)
    axes[0].set_aspect("equal")
    axes[0].set_title("原始尺度：等比例画出来，振动轴几乎被压扁")
    axes[0].set_xlabel("温度 °C")
    axes[0].set_ylabel("振动 mm/s")
    axes[1].scatter(Ztr[:, 0], Ztr[:, 1], c=ytr, cmap="coolwarm", s=12)
    axes[1].set_aspect("equal")
    axes[1].set_title("标准化后：两个特征同等重要")
    save(fig, "12-knn-scaling.png")


if __name__ == "__main__":
    main()
