"""第 7 章 过拟合与泛化：训练集上的低 loss 不等于会预测新数据。"""
import numpy as np


def make_data(n, seed, noise=0.25):
    """真实规律 y = sin(2πx)，再加高斯噪声。"""
    rng = np.random.default_rng(seed)
    x = np.sort(rng.uniform(0, 1, n))
    return x, np.sin(2 * np.pi * x) + rng.normal(0, noise, n)


def poly_features(x, degree):
    """[x, x², ..., x^degree]，不含常数列（常数交给偏置）。"""
    return np.column_stack([x**d for d in range(1, degree + 1)])


def fit_poly(x, y, degree, alpha=0.0):
    """多项式回归；alpha>0 时是岭回归（L2 正则），偏置不参与惩罚。
    闭式解：先中心化消掉偏置，再解 (XᵀX + αI) w = Xᵀy。"""
    X = poly_features(x, degree)
    xm, ym = X.mean(0), y.mean()
    Xc, yc = X - xm, y - ym
    if alpha == 0:
        w, *_ = np.linalg.lstsq(Xc, yc, rcond=None)
    else:
        w = np.linalg.solve(Xc.T @ Xc + alpha * np.eye(degree), Xc.T @ yc)
    b = ym - xm @ w
    return w, b


def predict_poly(w, b, x):
    return poly_features(x, len(w)) @ w + b


def mse(a, b):
    return float(np.mean((a - b) ** 2))


def kfold_indices(n, k, seed=0):
    """手写 K 折：打乱后切成 k 份，每份轮流当验证集。"""
    idx = np.random.default_rng(seed).permutation(n)
    folds = np.array_split(idx, k)
    for i in range(k):
        val = folds[i]
        train = np.concatenate([folds[j] for j in range(k) if j != i])
        yield train, val


def cv_mse(x, y, degree, alpha=0.0, k=5, seed=0):
    errs = []
    for tr, va in kfold_indices(len(x), k, seed):
        w, b = fit_poly(x[tr], y[tr], degree, alpha)
        errs.append(mse(predict_poly(w, b, x[va]), y[va]))
    return float(np.mean(errs))


def main():
    from .common import plt, save

    x_tr, y_tr = make_data(15, seed=0)
    x_va, y_va = make_data(200, seed=1)
    print("degree  train_MSE  val_MSE")
    rows = []
    for d in range(1, 13):
        w, b = fit_poly(x_tr, y_tr, d)
        tr, va = mse(predict_poly(w, b, x_tr), y_tr), mse(predict_poly(w, b, x_va), y_va)
        rows.append((d, tr, va))
        print(f"{d:>6}  {tr:9.4f}  {va:9.4f}")

    w, b = fit_poly(x_tr, y_tr, 12)
    print(f"degree=12 无正则  max|w| = {np.abs(w).max():.3g}")
    for a in [1e-6, 1e-3, 1e-1]:
        w, b = fit_poly(x_tr, y_tr, 12, alpha=a)
        print(f"degree=12 alpha={a:<6} train={mse(predict_poly(w, b, x_tr), y_tr):.4f} "
              f"val={mse(predict_poly(w, b, x_va), y_va):.4f} max|w|={np.abs(w).max():.3g}")

    x_all, y_all = make_data(40, seed=2)
    cvs = {d: cv_mse(x_all, y_all, d) for d in range(1, 11)}
    best = min(cvs, key=cvs.get)
    print("5 折 CV:", {d: round(v, 3) for d, v in cvs.items()}, "-> 选 degree", best)

    # 图 1：三种复杂度的拟合
    xs = np.linspace(0, 1, 300)
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.6), sharey=True)
    for ax, d, name in zip(axes, [1, 3, 12], ["欠拟合", "刚好", "过拟合"]):
        w, b = fit_poly(x_tr, y_tr, d)
        ax.scatter(x_tr, y_tr, c="k", s=18, label="训练点")
        ax.plot(xs, np.sin(2 * np.pi * xs), "g--", lw=1, label="真实规律")
        ax.plot(xs, predict_poly(w, b, xs), "r", label=f"{d} 次多项式")
        ax.set_ylim(-2, 2)
        ax.set_title(f"degree={d}：{name}")
        ax.legend(fontsize=7, loc="lower left")
    save(fig, "07-under-good-over.png")

    # 图 2：训练误差 vs 验证误差
    ds, trs, vas = zip(*rows)
    fig, ax = plt.subplots(figsize=(6, 3.8))
    ax.plot(ds, trs, "o-", label="训练集 MSE")
    ax.plot(ds, vas, "s-", label="验证集 MSE")
    ax.set_yscale("log")
    ax.set_xlabel("多项式次数（模型复杂度）")
    ax.set_ylabel("MSE (log)")
    ax.set_title("训练误差一路下降，验证误差先降后升")
    ax.legend()
    save(fig, "07-train-vs-val.png")


if __name__ == "__main__":
    main()
