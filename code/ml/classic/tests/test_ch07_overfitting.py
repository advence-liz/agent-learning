import numpy as np
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.model_selection import KFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures

from classic.ch07_overfitting import fit_poly, kfold_indices, make_data, mse, predict_poly


def test_poly_matches_sklearn():
    x, y = make_data(15, seed=0)
    xs = np.linspace(0, 1, 50)
    for d in (1, 3, 6):
        w, b = fit_poly(x, y, d)
        sk = make_pipeline(PolynomialFeatures(d, include_bias=False), LinearRegression()).fit(x[:, None], y)
        np.testing.assert_allclose(predict_poly(w, b, xs), sk.predict(xs[:, None]), atol=1e-6)


def test_ridge_matches_sklearn():
    x, y = make_data(15, seed=0)
    for alpha in (1e-3, 1e-1, 1.0):
        w, b = fit_poly(x, y, 9, alpha)
        sk = make_pipeline(PolynomialFeatures(9, include_bias=False), Ridge(alpha=alpha)).fit(x[:, None], y)
        np.testing.assert_allclose(w, sk[-1].coef_, rtol=1e-5, atol=1e-6)
        assert np.isclose(b, sk[-1].intercept_, atol=1e-6)


def test_overfitting_shape():
    x_tr, y_tr = make_data(15, seed=0)
    x_va, y_va = make_data(200, seed=1)
    tr, va = [], []
    for d in range(1, 13):
        w, b = fit_poly(x_tr, y_tr, d)
        tr.append(mse(predict_poly(w, b, x_tr), y_tr))
        va.append(mse(predict_poly(w, b, x_va), y_va))
    assert tr[-1] < tr[0] / 10  # 高次在训练集上很好
    assert va[-1] > min(va) * 5  # 但验证集上明显变差
    assert 2 <= int(np.argmin(va)) + 1 <= 7  # 最优复杂度在中间


def test_kfold_partition_like_sklearn():
    n, k = 23, 5
    ours = list(kfold_indices(n, k))
    sk = list(KFold(k).split(np.zeros(n)))
    assert [len(v) for _, v in ours] == [len(v) for _, v in sk]
    allval = np.concatenate([v for _, v in ours])
    assert sorted(allval) == list(range(n))  # 每个样本恰好当一次验证
