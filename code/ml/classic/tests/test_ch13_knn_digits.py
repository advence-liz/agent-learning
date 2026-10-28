import numpy as np
from sklearn.metrics import confusion_matrix as sk_cm
from sklearn.neighbors import KNeighborsClassifier

from classic.ch12_knn import KNNClassifier
from classic.ch13_knn_digits import confusion_matrix, load_split


def test_digits_same_as_sklearn():
    Xtr, Xte, ytr, yte = load_split()
    for k in (1, 3, 5):
        ours = KNNClassifier(k).fit(Xtr, ytr).predict(Xte)
        sk = KNeighborsClassifier(k).fit(Xtr, ytr).predict(Xte)
        # 像素是整数，距离可能并列；允许极少数并列导致的差异
        assert np.mean(ours == sk) >= 0.995
        assert np.mean(ours == yte) > 0.97


def test_confusion_matrix():
    Xtr, Xte, ytr, yte = load_split()
    pred = KNNClassifier(3).fit(Xtr, ytr).predict(Xte)
    np.testing.assert_array_equal(confusion_matrix(yte, pred), sk_cm(yte, pred))
