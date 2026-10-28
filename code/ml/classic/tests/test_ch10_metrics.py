import numpy as np
from sklearn import metrics

from classic.ch10_metrics import confusion, f1, false_positive_rate, pr_curve, precision, recall, roc_auc


def _data(seed=0):
    rng = np.random.default_rng(seed)
    y = (rng.uniform(size=500) < 0.1).astype(int)
    scores = np.round(np.clip(0.3 * y + rng.normal(0.3, 0.2, 500), 0, 1), 2)  # 故意制造同分
    return y, scores


def test_point_metrics_match_sklearn():
    y, s = _data()
    pred = (s >= 0.5).astype(int)
    assert confusion(y, pred) == tuple(metrics.confusion_matrix(y, pred).ravel())
    assert np.isclose(precision(y, pred), metrics.precision_score(y, pred))
    assert np.isclose(recall(y, pred), metrics.recall_score(y, pred))
    assert np.isclose(f1(y, pred), metrics.f1_score(y, pred))
    fpr, _, th = metrics.roc_curve(y, s)
    i = np.where(th >= 0.5)[0][-1]
    assert np.isclose(false_positive_rate(y, pred), fpr[i])


def test_pr_curve_and_auc_match_sklearn():
    y, s = _data()
    p, r, t = pr_curve(y, s)
    sp, sr, st = metrics.precision_recall_curve(y, s, drop_intermediate=False)
    # sklearn 按阈值升序并在末尾补 (P=1, R=0)；我们按降序
    np.testing.assert_allclose(t[::-1], st)
    np.testing.assert_allclose(p[::-1], sp[:-1])
    np.testing.assert_allclose(r[::-1], sr[:-1])
    assert np.isclose(roc_auc(y, s), metrics.roc_auc_score(y, s))
