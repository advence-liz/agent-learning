import numpy as np
from sklearn.ensemble import RandomForestClassifier

from classic.ch14_decision_tree import DecisionTreeGini, moons
from classic.ch15_random_forest import RandomForest


def test_forest_accuracy_close_to_sklearn():
    X, y = moons()
    Xtr, Xte, ytr, yte = X[:700], X[700:], y[:700], y[700:]
    ours = RandomForest(n_estimators=30, random_state=0).fit(Xtr, ytr)
    sk = RandomForestClassifier(n_estimators=30, random_state=0, oob_score=True).fit(Xtr, ytr)
    a, b = np.mean(ours.predict(Xte) == yte), np.mean(sk.predict(Xte) == yte)
    assert abs(a - b) <= 0.03
    assert abs(ours.oob_score_ - sk.oob_score_) <= 0.03
    single = np.mean(DecisionTreeGini().fit(Xtr, ytr).predict(Xte) == yte)
    assert a >= single  # 森林不比单棵不剪枝的树差


def test_proba_is_average_of_trees():
    X, y = moons(n=200)
    rf = RandomForest(n_estimators=5, random_state=1).fit(X, y)
    manual = np.mean([t.predict_proba(X) for t in rf.trees_], axis=0)
    np.testing.assert_allclose(rf.predict_proba(X), manual)
