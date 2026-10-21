import numpy as np
from sklearn.datasets import load_iris
from sklearn.tree import DecisionTreeClassifier

from classic.ch14_decision_tree import DecisionTreeGini, gini, moons


def test_gini_values():
    assert gini([5, 5]) == 0.5
    assert gini([10, 0]) == 0.0
    assert np.isclose(gini([1, 1, 1]), 2 / 3)


def test_root_split_and_shallow_tree_match_sklearn():
    X, y = moons()
    for d in (1, 2, 3):
        ours = DecisionTreeGini(max_depth=d).fit(X, y)
        sk = DecisionTreeClassifier(max_depth=d, random_state=0).fit(X, y)
        assert ours.root_.feature == sk.tree_.feature[0]
        assert np.isclose(ours.root_.threshold, sk.tree_.threshold[0])
        assert np.array_equal(ours.predict(X), sk.predict(X))
        assert ours.n_leaves() == sk.get_n_leaves()
        np.testing.assert_allclose(ours.feature_importances_, sk.feature_importances_, atol=1e-10)


def test_full_tree_close_to_sklearn():
    X, y = moons()
    Xtr, Xte, ytr = X[:700], X[700:], y[:700]
    ours = DecisionTreeGini().fit(Xtr, ytr)
    sk = DecisionTreeClassifier(random_state=0).fit(Xtr, ytr)
    assert np.mean(ours.predict(Xtr) == ytr) == 1.0  # 不限深度：训练集全对（过拟合）
    assert np.mean(ours.predict(Xte) == sk.predict(Xte)) >= 0.97


def test_multiclass_iris():
    X, y = load_iris(return_X_y=True)
    ours = DecisionTreeGini(max_depth=3).fit(X, y)
    sk = DecisionTreeClassifier(max_depth=3, random_state=0).fit(X, y)
    assert np.mean(ours.predict(X) == sk.predict(X)) >= 0.98
