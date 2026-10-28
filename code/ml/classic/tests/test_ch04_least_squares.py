import numpy as np
from sklearn.linear_model import LinearRegression

from classic.ch04_least_squares import delivery_data, ols_1d, ols_lstsq, ols_normal_equation


def test_1d_matches_sklearn():
    x, y = delivery_data()
    w, b = ols_1d(x, y)
    lr = LinearRegression().fit(x[:, None], y)
    assert np.isclose(w, lr.coef_[0], atol=1e-10)
    assert np.isclose(b, lr.intercept_, atol=1e-10)


def test_multifeature_matches_sklearn():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(100, 5))
    y = X @ np.array([1.0, -2.0, 0.5, 0.0, 3.0]) + 7 + rng.normal(0, 0.1, 100)
    lr = LinearRegression().fit(X, y)
    for fit in (ols_normal_equation, ols_lstsq):
        w, b = fit(X, y)
        np.testing.assert_allclose(w, lr.coef_, atol=1e-10)
        assert np.isclose(b, lr.intercept_, atol=1e-10)
