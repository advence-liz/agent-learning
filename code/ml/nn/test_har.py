import numpy as np
import torch

from har_data import CLASSES, WINDOW, make_dataset, synth_window
from har_train import CNN1D, MLP, accuracy, n_params, standardize, train


def test_shapes_and_balance():
    X, y = make_dataset(20, seed=0)
    assert X.shape == (80, 3, WINDOW) and X.dtype == np.float32
    assert np.bincount(y).tolist() == [20] * len(CLASSES)


def test_deterministic_with_seed():
    a, _ = make_dataset(5, seed=7)
    b, _ = make_dataset(5, seed=7)
    assert np.array_equal(a, b)


def test_gravity_present_in_every_window():
    # 不管手机怎么转，三轴合加速度的均值都应接近 g
    rng = np.random.default_rng(0)
    for label in range(len(CLASSES)):
        w = synth_window(label, rng)
        assert abs(np.linalg.norm(w, axis=0).mean() - 9.81) < 1.5


def test_run_is_most_energetic_still_is_calmest():
    rng = np.random.default_rng(0)
    energy = {k: np.mean([np.linalg.norm(synth_window(k, rng), axis=0).std() for _ in range(50)])
              for k in range(len(CLASSES))}
    assert energy[2] == max(energy.values())
    assert energy[0] == min(energy.values())


def test_standardize_uses_train_stats_only():
    tr = np.random.default_rng(0).normal(5, 2, size=(100, 3, 16))
    te = np.full((10, 3, 16), 5.0)
    tr2, te2 = standardize(tr, te)
    assert np.allclose(tr2.mean(axis=(0, 2)), 0, atol=1e-6)
    assert np.abs(te2).max() < 0.2  # 测试集被训练集的均值方差变换，不会自己归零


def test_cnn_has_fewer_params_than_mlp():
    assert n_params(CNN1D()) < n_params(MLP()) / 5


def test_small_training_beats_chance():
    X, y = make_dataset(60, seed=11)
    (X,) = standardize(X)
    X, y = torch.from_numpy(np.ascontiguousarray(X)), torch.from_numpy(y)
    torch.manual_seed(0)
    model = MLP()
    train(model, X, y, X, y, epochs=8, log=lambda *_: None)
    assert accuracy(model, X, y) > 0.7  # 4 类随机猜是 0.25
