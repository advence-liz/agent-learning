import numpy as np
from sklearn.cluster import KMeans
from sklearn.datasets import make_blobs
from sklearn.metrics import adjusted_rand_score

from classic.ch16_kmeans import best_of, kmeans


def _data():
    return make_blobs(n_samples=600, centers=4, cluster_std=1.0, random_state=7)


def test_same_init_same_result_as_sklearn():
    X, _ = _data()
    for idx in ([0, 1, 2, 3], [10, 20, 30, 40], [5, 6, 7, 8]):
        init = X[idx]
        C, labels, inertia, _, _ = kmeans(X, 4, init=init, tol=0)
        sk = KMeans(4, init=init, n_init=1, algorithm="lloyd", tol=0).fit(X)
        np.testing.assert_allclose(C, sk.cluster_centers_, atol=1e-8)
        assert np.array_equal(labels, sk.labels_)
        assert np.isclose(inertia, sk.inertia_, rtol=1e-8)


def test_inertia_never_increases():
    X, _ = _data()
    _, _, _, _, hist = kmeans(X, 4, init="random", seed=3)
    assert np.all(np.diff(hist) <= 1e-9)


def test_best_of_recovers_blobs():
    X, y = _data()
    _, labels, inertia, _, _ = best_of(X, 4)
    sk = KMeans(4, n_init=10, random_state=0).fit(X)
    assert adjusted_rand_score(y, labels) > 0.95
    assert np.isclose(inertia, sk.inertia_, rtol=1e-6)
