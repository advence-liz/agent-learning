"""矩阵形式的反向传播：一个两层网络，前向 4 行，反向 6 行。

前向：
    H = relu(X @ W1 + b1)      # (N, h)
    Z = H @ W2 + b2            # (N, 1)
    L = mean(BCEWithLogits(Z, y))
反向（每一行都是标量版链式法则的「批量化」）：
    dZ  = (sigmoid(Z) - y) / N
    dW2 = H.T @ dZ ;  db2 = dZ.sum(0)
    dH  = dZ @ W2.T
    dA  = dH * (A > 0)          # relu 的局部导数
    dW1 = X.T @ dA ;  db1 = dA.sum(0)
"""

from __future__ import annotations

import numpy as np


def forward_backward(X, y, W1, b1, W2, b2):
    N = X.shape[0]
    A = X @ W1 + b1
    H = np.maximum(A, 0)
    Z = (H @ W2 + b2).ravel()
    loss = np.mean(np.logaddexp(0, Z) - y * Z)

    dZ = (1 / (1 + np.exp(-Z)) - y)[:, None] / N
    dW2 = H.T @ dZ
    db2 = dZ.sum(0)
    dH = dZ @ W2.T
    dA = dH * (A > 0)
    dW1 = X.T @ dA
    db1 = dA.sum(0)
    return loss, (dW1, db1, dW2, db2)
