"""第 13 章 实战：KNN 识别手写数字（sklearn 自带 8×8 digits）。"""
import time

import numpy as np

from .ch12_knn import KNNClassifier


def load_split(seed=0):
    from sklearn.datasets import load_digits
    from sklearn.model_selection import train_test_split

    X, y = load_digits(return_X_y=True)  # 像素值 0..16，1797 张
    return train_test_split(X, y, test_size=0.3, random_state=seed, stratify=y)


def confusion_matrix(y_true, y_pred, k=10):
    M = np.zeros((k, k), int)
    np.add.at(M, (y_true, y_pred), 1)
    return M


def main():
    from sklearn.model_selection import cross_val_score
    from sklearn.neighbors import KNeighborsClassifier

    from .common import plt, save

    Xtr, Xte, ytr, yte = load_split()
    print(f"训练 {Xtr.shape}  测试 {Xte.shape}")
    for k in [1, 3, 5, 9, 15]:
        t0 = time.perf_counter()
        pred = KNNClassifier(k).fit(Xtr, ytr).predict(Xte)
        dt = time.perf_counter() - t0
        sk = KNeighborsClassifier(k).fit(Xtr, ytr).predict(Xte)
        print(f"k={k:<2} 手写 acc={np.mean(pred == yte):.4f} ({dt * 1000:.0f} ms)  "
              f"sklearn acc={np.mean(sk == yte):.4f}  预测完全一致={np.array_equal(pred, sk)}")
    for k in [1, 3, 5]:
        s = cross_val_score(KNeighborsClassifier(k), Xtr, ytr, cv=5)
        print(f"5 折交叉验证 k={k}: {s.mean():.4f} ± {s.std():.4f}")

    m = KNNClassifier(3).fit(Xtr, ytr)
    pred = m.predict(Xte)
    M = confusion_matrix(yte, pred)
    off = M - np.diag(np.diag(M))
    i, j = np.unravel_index(np.argmax(off), off.shape)
    print(f"最常见的错误: 把 {i} 认成 {j}，共 {off[i, j]} 次；总错 {off.sum()} / {len(yte)}")

    # 图 1：一张测试图和它的 5 个最近邻
    _, idx = KNNClassifier(5).fit(Xtr, ytr).kneighbors(Xte)
    wrong = np.where(pred != yte)[0]
    rows = [0, 1, wrong[0], wrong[1]]
    fig, axes = plt.subplots(len(rows), 6, figsize=(7, 5))
    for r, t in enumerate(rows):
        axes[r, 0].imshow(Xte[t].reshape(8, 8), cmap="gray_r")
        axes[r, 0].set_title(f"测试 真值={yte[t]}", fontsize=8)
        for c in range(5):
            n = idx[t, c]
            axes[r, c + 1].imshow(Xtr[n].reshape(8, 8), cmap="gray_r")
            axes[r, c + 1].set_title(f"邻居 {ytr[n]}", fontsize=8)
    for ax in axes.ravel():
        ax.axis("off")
    fig.suptitle("左列是待识别图，右边是训练集里最像它的 5 张")
    save(fig, "13-neighbors.png")

    # 图 2：混淆矩阵
    fig, ax = plt.subplots(figsize=(4.8, 4.2))
    ax.imshow(np.log1p(M), cmap="Blues")
    for a in range(10):
        for b in range(10):
            if M[a, b]:
                ax.text(b, a, M[a, b], ha="center", va="center", fontsize=7,
                        color="white" if a == b else "crimson")
    ax.set_xticks(range(10))
    ax.set_yticks(range(10))
    ax.set_xlabel("预测")
    ax.set_ylabel("真值")
    ax.set_title("KNN(k=3) 混淆矩阵")
    save(fig, "13-confusion.png")


if __name__ == "__main__":
    main()
