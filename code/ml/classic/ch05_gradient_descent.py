"""第 5 章 梯度下降：不会解方程也能把损失一步步压下去。"""
import numpy as np

from .ch04_least_squares import add_bias, delivery_data


def mse_loss_and_grad(theta, Xb, y):
    """L = mean((Xbθ - y)²)，∇L = 2/n · Xbᵀ(Xbθ - y)。"""
    r = Xb @ theta - y
    return float(np.mean(r**2)), 2.0 / len(y) * Xb.T @ r


def numeric_grad(f, theta, eps=1e-6):
    """中心差分，用来核对解析梯度有没有写错。"""
    g = np.zeros_like(theta)
    for i in range(theta.size):
        e = np.zeros_like(theta)
        e[i] = eps
        g[i] = (f(theta + e) - f(theta - e)) / (2 * eps)
    return g


def gd_linear(X, y, lr=0.01, epochs=1000, theta0=None):
    """批量梯度下降拟合线性回归，返回 (θ=[w..., b], 每步损失)。"""
    Xb = add_bias(X)
    y = np.asarray(y, float)
    theta = np.zeros(Xb.shape[1]) if theta0 is None else np.array(theta0, float)
    history = []
    for _ in range(epochs):
        loss, grad = mse_loss_and_grad(theta, Xb, y)
        history.append(loss)
        theta -= lr * grad
    return theta, np.array(history)


def sgd_linear(X, y, lr=0.01, epochs=50, batch_size=8, seed=0):
    """小批量随机梯度下降：每步只用 batch_size 条样本估计梯度。"""
    rng = np.random.default_rng(seed)
    Xb = add_bias(X)
    y = np.asarray(y, float)
    theta = np.zeros(Xb.shape[1])
    history = []
    for _ in range(epochs):
        idx = rng.permutation(len(y))
        for s in range(0, len(y), batch_size):
            j = idx[s : s + batch_size]
            _, g = mse_loss_and_grad(theta, Xb[j], y[j])
            theta -= lr * g
        history.append(mse_loss_and_grad(theta, Xb, y)[0])
    return theta, np.array(history)


def main():
    from sklearn.linear_model import LinearRegression

    from .common import plt, save

    x, y = delivery_data()
    lr_sk = LinearRegression().fit(x[:, None], y)
    print(f"sklearn 最优解     : w={lr_sk.coef_[0]:.4f} b={lr_sk.intercept_:.4f}")

    Xb = add_bias(x)
    th = np.array([1.0, 1.0])
    _, g = mse_loss_and_grad(th, Xb, y)
    ng = numeric_grad(lambda t: mse_loss_and_grad(t, Xb, y)[0], th)
    print(f"解析梯度 {np.round(g, 4)}  数值梯度 {np.round(ng, 4)}")

    for lr, ep in [(0.001, 2000), (0.01, 2000), (0.02, 20000), (0.025, 30)]:
        theta, hist = gd_linear(x, y, lr=lr, epochs=ep)
        print(f"lr={lr:<6} epochs={ep:<6} -> w={theta[0]:.4f} b={theta[1]:.4f} 最终 MSE={hist[-1]:.4g}")

    theta_s, hist_s = sgd_linear(x, y, lr=0.005, epochs=300)
    print(f"mini-batch SGD     : w={theta_s[0]:.4f} b={theta_s[1]:.4f} MSE={hist_s[-1]:.4f}")

    # 标准化后收敛快得多
    xs = (x - x.mean()) / x.std()
    theta_z, hist_z = gd_linear(xs, y, lr=0.1, epochs=200)
    w_back = theta_z[0] / x.std()
    b_back = theta_z[1] - w_back * x.mean()
    print(f"标准化后 200 步    : w={w_back:.4f} b={b_back:.4f} MSE={hist_z[-1]:.4f}")

    # 图 1：在损失等高线上画出 GD 轨迹
    W, B = np.meshgrid(np.linspace(-0.5, 5, 200), np.linspace(-2, 9, 200))
    L = ((W[..., None] * x + B[..., None] - y) ** 2).mean(-1)
    fig, ax = plt.subplots(figsize=(6.5, 4.2))
    ax.contour(W, B, L, levels=np.geomspace(L.min() + 0.1, L.max(), 20), cmap="viridis", linewidths=0.8)
    for lr, color in [(0.02, "tab:orange"), (0.005, "tab:red")]:
        path = [np.zeros(2)]
        th = np.zeros(2)
        for _ in range(400):
            th = th - lr * mse_loss_and_grad(th, Xb, y)[1]
            path.append(th.copy())
        path = np.array(path)
        ax.plot(path[:, 0], path[:, 1], "-", lw=1, color=color, label=f"lr={lr} 前 400 步")
        ax.plot(path[::40, 0], path[::40, 1], "o", ms=4, color=color)
    ax.plot(lr_sk.coef_[0], lr_sk.intercept_, "k*", ms=13, label="最优解")
    ax.set_xlim(-0.5, 5)
    ax.set_ylim(-2, 9)
    ax.set_xlabel("w")
    ax.set_ylabel("b")
    ax.set_title("GD 轨迹：先在窄谷两壁来回横跳，再沿谷底慢慢爬")
    ax.legend(fontsize=8)
    save(fig, "05-gd-path.png")

    # 图 2：不同学习率的损失曲线
    fig, ax = plt.subplots(figsize=(6, 3.8))
    for lr in [0.001, 0.01, 0.02, 0.025]:
        _, hist = gd_linear(x, y, lr=lr, epochs=200)
        ax.plot(hist, label=f"lr={lr}")
    ax.set_yscale("log")
    ax.set_xlabel("迭代步数")
    ax.set_ylabel("MSE (log)")
    ax.set_title("学习率太小走得慢，太大会发散")
    ax.legend()
    save(fig, "05-lr-curves.png")


if __name__ == "__main__":
    main()
