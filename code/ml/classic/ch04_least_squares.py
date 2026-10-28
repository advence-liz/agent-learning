"""第 4 章 最小二乘法：用公式一步算出线性回归的参数。"""
import numpy as np


def delivery_data(n: int = 30, seed: int = 0):
    """配送距离(km) -> 配送时间(min)。真实规律 y = 3x + 5，再加噪声。"""
    rng = np.random.default_rng(seed)
    x = rng.uniform(1, 10, size=n)
    y = 3.0 * x + 5.0 + rng.normal(0, 2.0, size=n)
    return x, y


def ols_1d(x, y):
    """单特征闭式解：w = cov(x, y) / var(x)，b = ȳ - w·x̄。"""
    x, y = np.asarray(x, float), np.asarray(y, float)
    xm, ym = x.mean(), y.mean()
    w = np.sum((x - xm) * (y - ym)) / np.sum((x - xm) ** 2)
    b = ym - w * xm
    return w, b


def add_bias(X):
    X = np.asarray(X, float)
    if X.ndim == 1:
        X = X[:, None]
    return np.hstack([X, np.ones((X.shape[0], 1))])


def ols_normal_equation(X, y):
    """多特征：解正规方程 (XᵀX)θ = Xᵀy。返回 (w 向量, b)。"""
    Xb = add_bias(X)
    theta = np.linalg.solve(Xb.T @ Xb, Xb.T @ np.asarray(y, float))
    return theta[:-1], theta[-1]


def ols_lstsq(X, y):
    """数值更稳的做法：直接让 numpy 用 SVD 解最小二乘，不显式求逆。"""
    Xb = add_bias(X)
    theta, *_ = np.linalg.lstsq(Xb, np.asarray(y, float), rcond=None)
    return theta[:-1], theta[-1]


def mse(y, y_hat):
    return float(np.mean((np.asarray(y) - np.asarray(y_hat)) ** 2))


def main():
    from sklearn.linear_model import LinearRegression

    from .common import plt, save

    x, y = delivery_data()
    w, b = ols_1d(x, y)
    print(f"ols_1d            : w={w:.4f}  b={b:.4f}  MSE={mse(y, w * x + b):.4f}")
    wv, bv = ols_normal_equation(x, y)
    print(f"normal_equation   : w={wv[0]:.4f}  b={bv:.4f}")
    lr = LinearRegression().fit(x[:, None], y)
    print(f"sklearn           : w={lr.coef_[0]:.4f}  b={lr.intercept_:.4f}")
    print(f"6km 的新订单预测  : {w * 6 + b:.1f} 分钟")

    # 多特征：距离 + 楼层
    rng = np.random.default_rng(1)
    floors = rng.integers(0, 30, size=x.size)
    y2 = 3 * x + 0.4 * floors + 5 + rng.normal(0, 2, size=x.size)
    X2 = np.column_stack([x, floors])
    w2, b2 = ols_lstsq(X2, y2)
    lr2 = LinearRegression().fit(X2, y2)
    print(f"2 特征 lstsq      : w={np.round(w2, 4)}  b={b2:.4f}")
    print(f"2 特征 sklearn    : w={np.round(lr2.coef_, 4)}  b={lr2.intercept_:.4f}")

    # 图 1：数据 + 拟合直线 + 残差
    fig, ax = plt.subplots(figsize=(6, 4))
    xs = np.linspace(0, 11, 50)
    ax.scatter(x, y, label="历史订单")
    ax.plot(xs, w * xs + b, "r", label=f"OLS: y={w:.2f}x+{b:.2f}")
    for xi, yi in zip(x, y):
        ax.plot([xi, xi], [yi, w * xi + b], "gray", lw=0.8, alpha=0.6)
    ax.set_xlabel("配送距离 (km)")
    ax.set_ylabel("配送时间 (min)")
    ax.set_title("最小二乘：让灰色残差的平方和最小")
    ax.legend()
    save(fig, "04-ols-fit.png")

    # 图 2：损失曲面 L(w,b) 等高线，最低点就是闭式解
    W, B = np.meshgrid(np.linspace(1, 5, 200), np.linspace(-5, 15, 200))
    L = ((W[..., None] * x + B[..., None] - y) ** 2).mean(-1)
    fig, ax = plt.subplots(figsize=(6, 4))
    cs = ax.contour(W, B, L, levels=np.geomspace(L.min() + 0.1, L.max(), 15), cmap="viridis")
    ax.clabel(cs, fontsize=7, fmt="%.0f")
    ax.plot(w, b, "r*", ms=14, label="闭式解 (w*, b*)")
    ax.set_xlabel("w")
    ax.set_ylabel("b")
    ax.set_title("MSE 损失曲面是一只「碗」，碗底唯一")
    ax.legend()
    save(fig, "04-loss-bowl.png")


if __name__ == "__main__":
    main()
