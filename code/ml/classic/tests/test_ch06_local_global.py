import numpy as np
from scipy.optimize import minimize

from classic.ch06_local_global import df, f, gd_1d, grid_min, multi_start


def test_gd_gets_trapped_from_right():
    x_local, _ = gd_1d(2.0)
    x_global = grid_min()
    assert abs(df(x_local)) < 1e-8  # 梯度为 0：GD 认为自己到底了
    assert f(x_local) > f(x_global) + 2  # 但它比全局最低高了一大截


def test_gd_matches_scipy_local_optimizer():
    # 同一起点，手写 GD 与 scipy BFGS 停在同一个局部最低
    for x0 in (-2.0, 2.0):
        ours, _ = gd_1d(x0)
        ref = minimize(lambda v: f(v[0]), x0=[x0], method="BFGS").x[0]
        assert np.isclose(ours, ref, atol=1e-4)


def test_multi_start_finds_global():
    rng = np.random.default_rng(0)
    best, _ = multi_start(rng.uniform(-3, 3, 10))
    assert np.isclose(best, grid_min(), atol=1e-4)
