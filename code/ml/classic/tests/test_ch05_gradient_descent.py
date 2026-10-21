import numpy as np
from sklearn.linear_model import LinearRegression

from classic.ch04_least_squares import add_bias, delivery_data
from classic.ch05_gradient_descent import gd_linear, mse_loss_and_grad, numeric_grad, sgd_linear


def test_analytic_grad_matches_numeric():
    x, y = delivery_data()
    Xb = add_bias(x)
    th = np.array([0.3, -1.2])
    _, g = mse_loss_and_grad(th, Xb, y)
    ng = numeric_grad(lambda t: mse_loss_and_grad(t, Xb, y)[0], th)
    np.testing.assert_allclose(g, ng, rtol=1e-5)


def test_gd_converges_to_sklearn():
    x, y = delivery_data()
    theta, hist = gd_linear(x, y, lr=0.02, epochs=20000)
    lr = LinearRegression().fit(x[:, None], y)
    np.testing.assert_allclose(theta, [lr.coef_[0], lr.intercept_], atol=1e-6)
    assert np.all(np.diff(hist) <= 1e-12)  # 学习率合适时损失单调不增


def test_too_large_lr_diverges():
    x, y = delivery_data()
    _, hist = gd_linear(x, y, lr=0.05, epochs=50)
    assert hist[-1] > hist[0] * 1e6


def test_sgd_close_to_optimum():
    x, y = delivery_data()
    _, hist = sgd_linear(x, y, lr=0.005, epochs=300)
    lr = LinearRegression().fit(x[:, None], y)
    best = np.mean((lr.predict(x[:, None]) - y) ** 2)
    # SGD 在最优点附近抖动，参数不会精确收敛，但损失应该只比最优高一点点
    assert hist[-1] < best * 1.05
