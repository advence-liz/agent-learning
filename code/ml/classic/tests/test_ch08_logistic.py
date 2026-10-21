import numpy as np
from sklearn.datasets import make_classification
from sklearn.linear_model import LogisticRegression

from classic.ch08_logistic import LogisticRegressionGD, device_data, sigmoid


def test_sigmoid_stable():
    z = np.array([-1000.0, 0.0, 1000.0])
    np.testing.assert_allclose(sigmoid(z), [0.0, 0.5, 1.0])


def test_1d_matches_sklearn():
    t, y = device_data()
    ours = LogisticRegressionGD(C=1.0).fit(t, y)
    sk = LogisticRegression(C=1.0, tol=1e-10, max_iter=10000).fit(t[:, None], y)
    np.testing.assert_allclose(ours.coef_, sk.coef_[0], rtol=1e-3)
    np.testing.assert_allclose(ours.intercept_, sk.intercept_[0], rtol=1e-3)


def test_multifeature_proba_matches_sklearn():
    X, y = make_classification(n_samples=300, n_features=5, n_informative=3, random_state=0)
    ours = LogisticRegressionGD(C=0.5, epochs=8000).fit(X, y)
    sk = LogisticRegression(C=0.5, tol=1e-10, max_iter=10000).fit(X, y)
    np.testing.assert_allclose(ours.predict_proba(X), sk.predict_proba(X), atol=1e-4)
    assert np.array_equal(ours.predict(X), sk.predict(X))
