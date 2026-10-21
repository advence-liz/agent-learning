import numpy as np
from sklearn.datasets import load_digits, make_blobs
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

from classic.ch08_logistic import sigmoid
from classic.ch11_softmax import SoftmaxRegressionGD, softmax


def test_softmax_two_classes_is_sigmoid():
    z = np.linspace(-8, 8, 33)
    P = softmax(np.column_stack([np.zeros_like(z), z]))
    np.testing.assert_allclose(P[:, 1], sigmoid(z), atol=1e-12)


def test_softmax_overflow_safe():
    P = softmax(np.array([[1000.0, 1001.0, 1002.0]]))
    assert np.all(np.isfinite(P)) and np.isclose(P.sum(), 1)


def test_blobs_proba_match_sklearn():
    X, y = make_blobs(n_samples=300, centers=4, cluster_std=2.0, random_state=0)
    ours = SoftmaxRegressionGD(C=1.0, lr=0.5, epochs=5000).fit(X, y)
    sk = LogisticRegression(C=1.0, tol=1e-10, max_iter=10000).fit(X, y)
    np.testing.assert_allclose(ours.predict_proba(X), sk.predict_proba(X), atol=1e-4)


def test_digits_accuracy_close_to_sklearn():
    X, y = load_digits(return_X_y=True)
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.3, random_state=0, stratify=y)
    ours = SoftmaxRegressionGD(C=0.05, lr=0.5, epochs=3000).fit(Xtr, ytr)
    sk = LogisticRegression(C=0.05, max_iter=5000).fit(Xtr, ytr)
    a, b = np.mean(ours.predict(Xte) == yte), np.mean(sk.predict(Xte) == yte)
    assert a > 0.94 and abs(a - b) <= 0.01
