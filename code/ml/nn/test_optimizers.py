import numpy as np
import pytest
import torch

from optimizers import SGD, Adam, Momentum, rosenbrock, rosenbrock_grad, run


def _torch_path(make_opt, start=(-1.5, 2.0), steps=200):
    p = torch.tensor(start, dtype=torch.float64, requires_grad=True)
    opt = make_opt([p])
    path = [p.detach().numpy().copy()]
    for _ in range(steps):
        x, y = p[0], p[1]
        loss = (1 - x) ** 2 + 100 * (y - x ** 2) ** 2
        opt.zero_grad()
        loss.backward()
        opt.step()
        path.append(p.detach().numpy().copy())
    return np.array(path)


def test_rosenbrock_grad_matches_finite_difference():
    p, eps = np.array([0.3, -0.8]), 1e-6
    num = np.array([(rosenbrock(p + eps * e) - rosenbrock(p - eps * e)) / (2 * eps) for e in np.eye(2)])
    assert np.allclose(rosenbrock_grad(p), num, rtol=1e-5)


@pytest.mark.parametrize("ours,theirs", [
    (lambda: SGD(1e-3), lambda ps: torch.optim.SGD(ps, lr=1e-3)),
    (lambda: Momentum(1e-3, 0.9), lambda ps: torch.optim.SGD(ps, lr=1e-3, momentum=0.9)),
    (lambda: Adam(0.05), lambda ps: torch.optim.Adam(ps, lr=0.05)),
])
def test_matches_torch_optim(ours, theirs):
    mine = run(ours(), steps=200)
    ref = _torch_path(theirs, steps=200)
    assert np.allclose(mine, ref, rtol=1e-6, atol=1e-9)


def test_adam_first_step_is_lr_regardless_of_grad_scale():
    # 偏差修正后，第一步每个坐标都移动 ≈ lr，和梯度大小无关 —— Adam「按参数自适应步长」的直观体现
    opt = Adam(0.1)
    p = np.zeros(2)
    new = opt.step(p, np.array([1e-4, 1e4]))
    assert np.allclose(np.abs(new - p), 0.1, rtol=1e-3)


def test_momentum_and_adam_beat_sgd_on_rosenbrock():
    target = np.array([1.0, 1.0])
    d = {name: np.linalg.norm(run(o, steps=1000)[-1] - target)
         for name, o in [("sgd", SGD(1e-3)), ("mom", Momentum(1e-3)), ("adam", Adam(0.05))]}
    assert d["mom"] < d["sgd"] / 10
    assert d["adam"] < d["sgd"] / 10


def test_sgd_diverges_when_lr_too_large():
    path = run(SGD(3e-3), steps=3000)
    assert len(path) < 3001  # 提前终止 = 发散
