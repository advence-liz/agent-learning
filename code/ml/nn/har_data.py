"""合成三轴加速度数据，代替 UCI HAR 数据集。

为什么不用 UCI HAR：本库规定不依赖外网下载数据集；而且合成数据的"生成规则"
完全透明，你能清楚知道每个类别和别的类别差在哪，方便理解模型到底学到了什么。

采样设定与 UCI HAR 一致：50 Hz，每个窗口 128 个点（2.56 秒），三轴 x/y/z，单位 m/s²。

四种动作：
  0 静止 still   —— 只有重力 + 传感器噪声 + 极轻微的手抖
  1 走路 walk    —— 步频 1.5~2.1 Hz，竖直方向起伏 1.2~2.6 m/s²
  2 跑步 run     —— 步频 2.5~3.3 Hz，起伏 ~6 m/s²，带明显二次谐波（落地冲击）
  3 上楼 stairs  —— 步频 1.4~2.0 Hz（和走路大面积重叠！），起伏和走路差不多，
                    但每一步前半段"蹬"得更狠：用不对称波形 + 前向分量体现
"""

from __future__ import annotations

import numpy as np

FS = 50          # 采样率 Hz
WINDOW = 128     # 每个样本 128 个点 = 2.56 s
G = 9.81
CLASSES = ["still", "walk", "run", "stairs"]


def _random_rotation(rng: np.random.Generator) -> np.ndarray:
    """手机在口袋里的朝向每个人都不一样：随机一个小角度旋转（±40°）。"""
    angles = rng.uniform(-0.7, 0.7, size=3)
    cx, cy, cz = np.cos(angles)
    sx, sy, sz = np.sin(angles)
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rz @ ry @ rx


def synth_window(label: int, rng: np.random.Generator) -> np.ndarray:
    """生成一个 (3, 128) 的窗口。坐标系：x=前进方向，y=左右，z=竖直。"""
    t = np.arange(WINDOW) / FS
    phase = rng.uniform(0, 2 * np.pi)
    noise_std = rng.uniform(0.3, 0.9)

    fwd = np.zeros(WINDOW)
    side = np.zeros(WINDOW)
    vert = np.zeros(WINDOW)

    if label == 0:  # still
        tremor = rng.uniform(0.02, 0.08)
        vert += tremor * np.sin(2 * np.pi * rng.uniform(4, 8) * t + phase)
    elif label == 1:  # walk
        f = rng.uniform(1.5, 2.1)
        a = rng.uniform(1.2, 2.6)
        vert += a * np.sin(2 * np.pi * f * t + phase)
        fwd += 0.5 * a * np.sin(2 * np.pi * f * t + phase + np.pi / 2)
        side += 0.3 * a * np.sin(np.pi * f * t + phase)  # 左右摆动是步频的一半
    elif label == 2:  # run
        f = rng.uniform(2.5, 3.3)
        a = rng.uniform(4.5, 7.5)
        vert += a * np.sin(2 * np.pi * f * t + phase)
        vert += 0.4 * a * np.sin(4 * np.pi * f * t + 2 * phase)  # 落地冲击的二次谐波
        fwd += 0.6 * a * np.sin(2 * np.pi * f * t + phase + np.pi / 2)
        side += 0.3 * a * np.sin(np.pi * f * t + phase)
    elif label == 3:  # stairs (up)
        f = rng.uniform(1.4, 2.0)
        a = rng.uniform(1.2, 2.4)
        base = np.sin(2 * np.pi * f * t + phase)
        # 不对称：正半周（蹬）尖、负半周平
        vert += a * (np.maximum(base, 0) ** 0.7 * 1.2 - np.maximum(-base, 0) * 0.8)
        fwd += 0.25 * a * np.sin(2 * np.pi * f * t + phase + np.pi / 3) + 0.4  # 身体前倾
        side += 0.2 * a * np.sin(np.pi * f * t + phase)
    else:
        raise ValueError(label)

    body = np.stack([fwd, side, vert + G])          # 体坐标下的加速度（含重力）
    sig = _random_rotation(rng) @ body              # 转到手机坐标
    sig += rng.normal(0, noise_std, size=sig.shape)
    return sig.astype(np.float32)


def make_dataset(n_per_class: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """返回 X: (N, 3, 128) float32，y: (N,) int64，已打乱。"""
    rng = np.random.default_rng(seed)
    xs, ys = [], []
    for label in range(len(CLASSES)):
        for _ in range(n_per_class):
            xs.append(synth_window(label, rng))
            ys.append(label)
    X = np.stack(xs)
    y = np.array(ys, dtype=np.int64)
    perm = rng.permutation(len(y))
    return X[perm], y[perm]
