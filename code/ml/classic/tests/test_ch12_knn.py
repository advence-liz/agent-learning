import numpy as np
from sklearn.neighbors import KNeighborsClassifier

from classic.ch12_knn import KNNClassifier, device_data, pairwise_sq_dist, standardize


def test_pairwise_distance():
    rng = np.random.default_rng(0)
    A, B = rng.normal(size=(5, 3)), rng.normal(size=(7, 3))
    ref = ((A[:, None, :] - B[None, :, :]) ** 2).sum(-1)
    np.testing.assert_allclose(pairwise_sq_dist(A, B), ref, atol=1e-10)


def test_predictions_identical_to_sklearn():
    X, y = device_data(300)
    Ztr, Zte = standardize(X[:200], X[200:])
    for k in (1, 3, 5, 15):
        ours = KNNClassifier(k).fit(Ztr, y[:200])
        sk = KNeighborsClassifier(k).fit(Ztr, y[:200])
        assert np.array_equal(ours.predict(Zte), sk.predict(Zte))
        d, i = ours.kneighbors(Zte)
        sd, si = sk.kneighbors(Zte)
        np.testing.assert_allclose(d, sd, atol=1e-8)


def test_scaling_matters():
    X, y = device_data(300)
    Ztr, Zte = standardize(X[:200], X[200:])
    raw = np.mean(KNNClassifier(5).fit(X[:200], y[:200]).predict(X[200:]) == y[200:])
    z = np.mean(KNNClassifier(5).fit(Ztr, y[:200]).predict(Zte) == y[200:])
    assert z > raw + 0.05
