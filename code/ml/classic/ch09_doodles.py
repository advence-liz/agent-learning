"""第 9 章 实战：逻辑回归识别涂鸦。

Quick, Draw! 原始数据要从 Google Cloud 下载（单类就上百 MB），本教程约定不下载外部数据，
所以这里用脚本「模拟手绘」两类涂鸦：苹果 = 一个歪歪扭扭的闭合圆 + 一根柄，香蕉 = 一段弯月形弧线。
笔画有随机位置、大小、角度、抖动和粗细，像素网格 20×20。
"""
import numpy as np

from .ch08_logistic import LogisticRegressionGD

SIZE = 20


def _rasterize(pts, rng, size=SIZE):
    img = np.zeros((size, size))
    thick = rng.uniform(0.6, 1.2)
    yy, xx = np.mgrid[0:size, 0:size]
    for px, py in pts:
        d2 = (xx - px) ** 2 + (yy - py) ** 2
        img = np.maximum(img, np.exp(-d2 / (2 * thick**2)))
    return (img > 0.4).astype(float)


def _wobble(n, rng, amp):
    # 低频抖动：几个随机正弦叠加，模拟手抖
    t = np.linspace(0, 1, n)
    return sum(rng.normal(0, amp) * np.sin(2 * np.pi * (k * t + rng.uniform())) for k in (1, 2, 3))


def draw_apple(rng, size=SIZE):
    cx, cy = rng.uniform(7, 13, 2)
    r = rng.uniform(3.5, 6)
    n = 80
    a = np.linspace(0, 2 * np.pi * rng.uniform(0.9, 1.05), n) + rng.uniform(0, 2 * np.pi)
    rr = r * (1 + _wobble(n, rng, 0.05))
    pts = list(zip(cx + rr * np.cos(a), cy + rr * 0.95 * np.sin(a)))
    # 柄：从顶部往上一小段
    L = rng.uniform(1.5, 3)
    tilt = rng.normal(0, 0.4)
    pts += [(cx + s * np.sin(tilt), cy - r - s * np.cos(tilt)) for s in np.linspace(0, L, 8)]
    return _rasterize(pts, rng, size)


def draw_banana(rng, size=SIZE):
    cx, cy = rng.uniform(7, 13, 2)
    R = rng.uniform(5, 8)
    span = rng.uniform(1.6, 2.4)  # 弧度，约 90°~140°
    rot = rng.uniform(0, 2 * np.pi)
    n = 60
    a = np.linspace(-span / 2, span / 2, n) + rot
    outer = R * (1 + _wobble(n, rng, 0.03))
    inner = R * 0.7
    # 外弧 + 内弧，两头收拢 → 月牙形轮廓
    ox, oy = cx + outer * np.cos(a), cy + outer * np.sin(a)
    ix, iy = cx + 0.25 * R * np.cos(rot) + inner * np.cos(a), cy + 0.25 * R * np.sin(rot) + inner * np.sin(a)
    pts = list(zip(ox, oy)) + list(zip(ix, iy))
    # 把整体平移到画布中心附近
    pts = np.array(pts)
    pts -= pts.mean(0) - np.array([cx, cy])
    return _rasterize(pts, rng, size)


def make_doodles(n_per_class=600, seed=0):
    """返回 X (n, 400) 像素特征、y (1=苹果, 0=香蕉)。"""
    rng = np.random.default_rng(seed)
    imgs = [draw_apple(rng) for _ in range(n_per_class)] + [draw_banana(rng) for _ in range(n_per_class)]
    y = np.array([1] * n_per_class + [0] * n_per_class)
    X = np.array(imgs).reshape(len(imgs), -1)
    perm = rng.permutation(len(y))
    return X[perm], y[perm]


def draw_line(rng, horizontal, size=SIZE):
    """横线或竖线，位置随机：用来演示逻辑回归的局限。"""
    pos = rng.uniform(2, size - 2)
    a, b = sorted(rng.uniform(1, size - 1, 2))
    if b - a < 6:
        b = min(size - 1, a + 6)
    s = np.linspace(a, b, 30)
    pts = [(si, pos) for si in s] if horizontal else [(pos, si) for si in s]
    return _rasterize(pts, rng, size)


def make_lines(n_per_class=600, seed=0):
    rng = np.random.default_rng(seed)
    imgs = [draw_line(rng, True) for _ in range(n_per_class)] + [draw_line(rng, False) for _ in range(n_per_class)]
    y = np.array([1] * n_per_class + [0] * n_per_class)
    X = np.array(imgs).reshape(len(imgs), -1)
    perm = rng.permutation(len(y))
    return X[perm], y[perm]


def split(X, y, n_test):
    return X[:-n_test], X[-n_test:], y[:-n_test], y[-n_test:]


def train_doodle_model(seed=0, C=0.1, epochs=3000):
    X, y = make_doodles(seed=seed)
    Xtr, Xte, ytr, yte = split(X, y, 400)
    model = LogisticRegressionGD(C=C, lr=0.5, epochs=epochs, standardize=False).fit(Xtr, ytr)
    return model, (Xtr, Xte, ytr, yte)


def main():
    from sklearn.linear_model import LogisticRegression

    from .common import plt, save

    model, (Xtr, Xte, ytr, yte) = train_doodle_model()
    sk = LogisticRegression(C=0.1, max_iter=5000).fit(Xtr, ytr)
    acc = np.mean(model.predict(Xte) == yte)
    acc_sk = np.mean(sk.predict(Xte) == yte)
    agree = np.mean(model.predict(Xte) == sk.predict(Xte))
    print(f"训练 {len(ytr)} 张 / 测试 {len(yte)} 张, 特征数 {Xtr.shape[1]}")
    print(f"测试准确率  手写 {acc:.3f}   sklearn {acc_sk:.3f}   两者预测一致率 {agree:.3f}")

    Xl, yl = make_lines()
    Xltr, Xlte, yltr, ylte = split(Xl, yl, 400)
    ml = LogisticRegressionGD(C=0.1, lr=0.5, epochs=3000, standardize=False).fit(Xltr, yltr)
    skl = LogisticRegression(C=0.1, max_iter=5000).fit(Xltr, yltr)
    print(f"横线 vs 竖线（位置随机）: 训练准确率 {np.mean(ml.predict(Xltr) == yltr):.3f}  "
          f"测试准确率 手写 {np.mean(ml.predict(Xlte) == ylte):.3f}  sklearn {np.mean(skl.predict(Xlte) == ylte):.3f}")

    # 图 1：样例涂鸦
    fig, axes = plt.subplots(2, 8, figsize=(10, 2.8))
    rng = np.random.default_rng(42)
    for j in range(8):
        axes[0, j].imshow(draw_apple(rng), cmap="gray_r")
        axes[1, j].imshow(draw_banana(rng), cmap="gray_r")
    for ax in axes.ravel():
        ax.set_xticks([])
        ax.set_yticks([])
    axes[0, 0].set_ylabel("苹果")
    axes[1, 0].set_ylabel("香蕉")
    fig.suptitle("脚本生成的 20×20 涂鸦（替代 Quick, Draw! 数据集）")
    save(fig, "09-doodle-samples.png")

    # 图 2：权重画回图片 + 两类平均图
    W = model.coef_.reshape(SIZE, SIZE)
    lim = np.abs(W).max()
    fig, axes = plt.subplots(1, 3, figsize=(10, 3.4))
    axes[0].imshow(Xtr[ytr == 1].mean(0).reshape(SIZE, SIZE), cmap="gray_r")
    axes[0].set_title("苹果的平均图")
    axes[1].imshow(Xtr[ytr == 0].mean(0).reshape(SIZE, SIZE), cmap="gray_r")
    axes[1].set_title("香蕉的平均图")
    im = axes[2].imshow(W, cmap="bwr", vmin=-lim, vmax=lim)
    axes[2].set_title("权重（红=投苹果, 蓝=投香蕉）")
    fig.colorbar(im, ax=axes[2], fraction=0.046)
    for ax in axes:
        ax.set_xticks([])
        ax.set_yticks([])
    save(fig, "09-weights.png")

    # 图 3：横竖线的平均图几乎一样，权重学不到东西
    fig, axes = plt.subplots(1, 3, figsize=(10, 3.4))
    axes[0].imshow(Xltr[yltr == 1].mean(0).reshape(SIZE, SIZE), cmap="gray_r")
    axes[0].set_title("横线的平均图")
    axes[1].imshow(Xltr[yltr == 0].mean(0).reshape(SIZE, SIZE), cmap="gray_r")
    axes[1].set_title("竖线的平均图")
    Wl = ml.coef_.reshape(SIZE, SIZE)
    lim = np.abs(Wl).max()
    axes[2].imshow(Wl, cmap="bwr", vmin=-lim, vmax=lim)
    axes[2].set_title("权重：一片噪声")
    for ax in axes:
        ax.set_xticks([])
        ax.set_yticks([])
    save(fig, "09-lines-fail.png")


if __name__ == "__main__":
    main()
