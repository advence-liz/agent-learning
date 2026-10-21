"""第 17 章 实战：K-Means 颜色量化（sklearn 自带的 china.jpg）。"""
import numpy as np

from .ch12_knn import pairwise_sq_dist
from .ch16_kmeans import kmeans


def load_pixels():
    from sklearn.datasets import load_sample_image

    img = load_sample_image("china.jpg")  # (427, 640, 3) uint8
    return img, img.reshape(-1, 3).astype(float) / 255.0


def quantize(img_pixels, k, n_sample=10000, seed=0):
    """在随机抽的 n_sample 个像素上聚类，再把全部像素映射到最近的代表色。"""
    rng = np.random.default_rng(seed)
    sample = img_pixels[rng.choice(len(img_pixels), n_sample, replace=False)]
    C, _, _, it, _ = kmeans(sample, k, seed=seed)
    # 27 万像素 × k 个质心，分块算距离，省内存
    labels = np.concatenate([pairwise_sq_dist(chunk, C).argmin(1) for chunk in np.array_split(img_pixels, 20)])
    return C, labels, it


def psnr(a, b):
    m = np.mean((a - b) ** 2)
    return float(10 * np.log10(1.0 / m))


def main():
    import time

    from sklearn.cluster import KMeans

    from .common import plt, save

    img, px = load_pixels()
    h, w, _ = img.shape
    n_colors = len(np.unique(img.reshape(-1, 3), axis=0))
    print(f"原图 {w}×{h}，{len(px)} 个像素，{n_colors} 种不同颜色")
    results = {}
    for k in [4, 8, 16, 32]:
        t0 = time.perf_counter()
        C, labels, it = quantize(px, k)
        dt = time.perf_counter() - t0
        out = C[labels]
        bits = int(np.ceil(np.log2(k)))
        raw, comp = len(px) * 24, len(px) * bits + k * 24
        results[k] = (C, out)
        print(f"k={k:<2} {it:>3} 轮 {dt:.2f}s  PSNR={psnr(px, out):.2f} dB  "
              f"每像素 {bits} bit, 体积约为原来的 {comp / raw:.1%}")

    # 与 sklearn 对照：同一份采样、同一组初始质心
    rng = np.random.default_rng(0)
    sample = px[rng.choice(len(px), 10000, replace=False)]
    init = sample[:8]
    C, _, inertia, _, _ = kmeans(sample, 8, init=init, tol=0)
    sk = KMeans(8, init=init, n_init=1, algorithm="lloyd", tol=0).fit(sample)
    print(f"k=8 同初值对照: 手写 inertia={inertia:.4f}  sklearn inertia={sk.inertia_:.4f}  "
          f"质心最大差 {np.abs(np.sort(C, 0) - np.sort(sk.cluster_centers_, 0)).max():.1e}")

    fig, axes = plt.subplots(2, 4, figsize=(14, 3.9), gridspec_kw={"height_ratios": [5, 0.5]})
    axes[0, 0].imshow(img)
    axes[0, 0].set_title(f"原图（{n_colors} 色）")
    axes[1, 0].axis("off")
    for j, k in enumerate([4, 8, 16], start=1):
        C, out = results[k]
        axes[0, j].imshow(out.reshape(h, w, 3))
        axes[0, j].set_title(f"k={k}  PSNR={psnr(px, out):.1f}dB")
        order = np.argsort(C @ [0.299, 0.587, 0.114])
        axes[1, j].imshow(C[order][None, :, :], aspect="auto")
        axes[1, j].set_yticks([])
        axes[1, j].set_xticks([])
    for ax in axes[0]:
        ax.axis("off")
    fig.suptitle("每个像素换成离它最近的代表色；下方是 K-Means 选出的调色板")
    save(fig, "17-china-quantized.png")

    # 像素在 RGB 空间里的分布 + 质心
    sub = sample[:3000]
    C8, _ = results[8]
    fig = plt.figure(figsize=(5.5, 4.5))
    ax = fig.add_subplot(projection="3d")
    ax.scatter(sub[:, 0], sub[:, 1], sub[:, 2], c=sub, s=2)
    ax.scatter(C8[:, 0], C8[:, 1], C8[:, 2], c="k", s=120, marker="X")
    ax.set_xlabel("R")
    ax.set_ylabel("G")
    ax.set_zlabel("B")
    ax.set_title("像素是 RGB 空间里的点，黑叉是 k=8 的质心")
    save(fig, "17-rgb-space.png")


if __name__ == "__main__":
    main()
