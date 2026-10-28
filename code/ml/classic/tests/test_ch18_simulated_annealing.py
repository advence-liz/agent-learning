import numpy as np
from scipy.optimize import dual_annealing

from classic.ch06_local_global import f, grid_min
from classic.ch18_simulated_annealing import (anneal, brute_force_tsp, gauss_step, random_cities,
                                              tour_length, two_opt)


def test_escapes_local_minimum_like_scipy():
    xb, fb, _ = anneal(f, 2.0, gauss_step(0.5), steps=3000, seed=0)
    ref = dual_annealing(lambda v: f(v[0]), bounds=[(-3, 3)], seed=0)
    assert np.isclose(xb, grid_min(), atol=0.05)
    assert np.isclose(fb, ref.fun, atol=0.01)


def test_zero_temperature_is_greedy_and_gets_stuck():
    # 步长很小 + 只接受变好：跳不过两谷之间的山梁
    xb, fb, _ = anneal(f, 2.0, gauss_step(0.05), T0=1e-12, alpha=1.0, steps=3000, seed=0)
    assert xb > 0 and fb > -3


def test_tsp_matches_brute_force():
    _, D = random_cities(9, seed=1)
    _, L_opt = brute_force_tsp(D)
    _, L_sa, _ = anneal(lambda t: tour_length(t, D), np.arange(9), two_opt, T0=0.5, alpha=0.998, steps=4000, seed=0)
    assert np.isclose(L_sa, L_opt)
