"""第 10 章 分类模型的评估：准确率在类别不均衡时会骗人。"""
import numpy as np

from .ch09_doodles import draw_apple, draw_banana, train_doodle_model


def confusion(y_true, y_pred):
    """返回 (TN, FP, FN, TP)，正类 = 1。"""
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    tp = int(np.sum((y_true == 1) & (y_pred == 1)))
    fp = int(np.sum((y_true == 0) & (y_pred == 1)))
    fn = int(np.sum((y_true == 1) & (y_pred == 0)))
    tn = int(np.sum((y_true == 0) & (y_pred == 0)))
    return tn, fp, fn, tp


def precision(y_true, y_pred):
    _, fp, _, tp = confusion(y_true, y_pred)
    return tp / (tp + fp) if tp + fp else 0.0


def recall(y_true, y_pred):
    _, _, fn, tp = confusion(y_true, y_pred)
    return tp / (tp + fn) if tp + fn else 0.0


def f1(y_true, y_pred):
    p, r = precision(y_true, y_pred), recall(y_true, y_pred)
    return 2 * p * r / (p + r) if p + r else 0.0


def false_positive_rate(y_true, y_pred):
    tn, fp, _, _ = confusion(y_true, y_pred)
    return fp / (fp + tn) if fp + tn else 0.0


def pr_curve(y_true, scores):
    """把每个不同的分数都当一次阈值（score >= t 判正），返回 precision, recall, thresholds。"""
    y_true, scores = np.asarray(y_true), np.asarray(scores)
    order = np.argsort(-scores, kind="mergesort")
    s, y = scores[order], y_true[order]
    tp = np.cumsum(y)
    fp = np.cumsum(1 - y)
    last = np.r_[np.diff(s) != 0, True]  # 同分只在最后一个位置结算
    tp, fp, th = tp[last], fp[last], s[last]
    prec = tp / (tp + fp)
    rec = tp / y.sum()
    return prec, rec, th


def roc_auc(y_true, scores):
    """AUC = 随机挑一个正样本、一个负样本，正样本分数更高的概率（同分算 0.5）。"""
    y_true, scores = np.asarray(y_true), np.asarray(scores)
    pos, neg = scores[y_true == 1], scores[y_true == 0]
    diff = pos[:, None] - neg[None, :]
    return float(np.mean((diff > 0) + 0.5 * (diff == 0)))


def imbalanced_test_set(n_apple=30, n_banana=970, seed=123):
    rng = np.random.default_rng(seed)
    X = np.array([draw_apple(rng).ravel() for _ in range(n_apple)] + [draw_banana(rng).ravel() for _ in range(n_banana)])
    y = np.array([1] * n_apple + [0] * n_banana)
    return X, y


def report(name, y, pred):
    tn, fp, fn, tp = confusion(y, pred)
    print(f"{name:<18} acc={np.mean(y == pred):.3f}  P={precision(y, pred):.3f}  R={recall(y, pred):.3f}  "
          f"F1={f1(y, pred):.3f}  [TP={tp} FP={fp} FN={fn} TN={tn}]")


def main():
    from .common import plt, save

    model, _ = train_doodle_model()
    X, y = imbalanced_test_set()
    scores = model.predict_proba(X)[:, 1]
    print(f"测试集：苹果 {y.sum()} 张，香蕉 {(1 - y).sum()} 张")
    report("全猜香蕉", y, np.zeros_like(y))
    for t in [0.5, 0.8, 0.95]:
        report(f"模型 阈值={t}", y, (scores >= t).astype(int))
    print(f"ROC-AUC = {roc_auc(y, scores):.4f}")

    prec, rec, th = pr_curve(y, scores)
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.8))
    axes[0].plot(th, prec, label="精确率 Precision")
    axes[0].plot(th, rec, label="召回率 Recall")
    axes[0].set_xlabel("阈值")
    axes[0].set_title("阈值越高：越准，但越不全")
    axes[0].legend()
    axes[1].plot(rec, prec, "k")
    for t in [0.5, 0.8, 0.95]:
        i = np.argmin(np.abs(th - t))
        axes[1].plot(rec[i], prec[i], "o", label=f"阈值≈{t}")
    axes[1].set_xlabel("召回率")
    axes[1].set_ylabel("精确率")
    axes[1].set_title("PR 曲线（30 苹果 vs 970 香蕉）")
    axes[1].legend()
    save(fig, "10-pr-tradeoff.png")

    tn, fp, fn, tp = confusion(y, (scores >= 0.5).astype(int))
    fig, ax = plt.subplots(figsize=(4, 3.6))
    M = np.array([[tn, fp], [fn, tp]])
    ax.imshow(M, cmap="Blues")
    for i in range(2):
        for j in range(2):
            ax.text(j, i, f"{['TN', 'FP'][j] if i == 0 else ['FN', 'TP'][j]}\n{M[i, j]}",
                    ha="center", va="center", color="white" if M[i, j] > 500 else "black", fontsize=12)
    ax.set_xticks([0, 1], ["预测香蕉", "预测苹果"])
    ax.set_yticks([0, 1], ["真香蕉", "真苹果"])
    ax.set_title("混淆矩阵（阈值 0.5）")
    save(fig, "10-confusion.png")


if __name__ == "__main__":
    main()
