import numpy as np
from sklearn.linear_model import LogisticRegression

from classic.ch08_logistic import LogisticRegressionGD
from classic.ch09_doodles import make_lines, split, train_doodle_model


def test_doodle_model_matches_sklearn():
    model, (Xtr, Xte, ytr, yte) = train_doodle_model()
    sk = LogisticRegression(C=0.1, max_iter=5000).fit(Xtr, ytr)
    acc, acc_sk = np.mean(model.predict(Xte) == yte), np.mean(sk.predict(Xte) == yte)
    assert acc > 0.85
    assert abs(acc - acc_sk) <= 0.01
    assert np.mean(model.predict(Xte) == sk.predict(Xte)) >= 0.98
    np.testing.assert_allclose(model.predict_proba(Xte), sk.predict_proba(Xte), atol=0.02)


def test_linear_model_cannot_learn_line_orientation():
    X, y = make_lines()
    Xtr, Xte, ytr, yte = split(X, y, 400)
    m = LogisticRegressionGD(C=0.1, lr=0.5, epochs=3000, standardize=False).fit(Xtr, ytr)
    assert np.mean(m.predict(Xte) == yte) < 0.7  # 接近瞎猜
