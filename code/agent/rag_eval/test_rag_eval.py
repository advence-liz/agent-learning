import json
import math

import pytest

from fake_llm import FakeAnthropic, text
from rag.rag import DOCS
from rag_eval.generation import (
    JUDGE_MODEL,
    CaseResult,
    Segment,
    Verdict,
    check_citations,
    evaluate_answer,
    key_fact_recall,
    review_sample,
    summarize,
)
from rag_eval.metrics import ndcg_at_k, precision_at_k, recall_at_k, reciprocal_rank
from rag_eval.retrieval import build_configs, evaluate, load_dataset, paired_diff, summarize as summarize_retrieval

# 正文里手算的例子：标注了 a、b、c 三条证据，检索前 5 名只有第 2、4 名相关
HAND = [set(), {"a"}, set(), {"b"}, set()]
GOLD = {"a", "b", "c"}


def test_metrics_hand_example():
    assert recall_at_k(HAND, GOLD, 1) == 0
    assert recall_at_k(HAND, GOLD, 3) == pytest.approx(1 / 3)
    assert recall_at_k(HAND, GOLD, 5) == pytest.approx(2 / 3)
    assert precision_at_k(HAND, 5) == pytest.approx(2 / 5)
    assert reciprocal_rank(HAND) == 0.5
    dcg = 1 / math.log2(3) + 1 / math.log2(5)
    idcg = 1 + 1 / math.log2(3) + 1 / math.log2(4)
    assert ndcg_at_k(HAND, 3, 5) == pytest.approx(dcg / idcg)
    assert ndcg_at_k(HAND, 3, 5) == pytest.approx(0.498, abs=1e-3)


def test_metrics_edges():
    assert reciprocal_rank([set(), set()]) == 0
    assert ndcg_at_k([{"a"}], 1, 5) == 1  # 唯一相关的排第一就是满分
    # 一块覆盖两条证据（大块）也只算一块相关
    assert precision_at_k([{"a", "b"}, set()], 2) == 0.5
    assert recall_at_k([{"a", "b"}, set()], {"a", "b"}, 1) == 1
    with pytest.raises(ValueError):
        recall_at_k(HAND, set(), 3)


def test_dataset_evidence_is_verbatim_and_within_one_sentence():
    corpus = {p.name: p.read_text() for p in DOCS.glob("*.md")}
    data = load_dataset()
    assert len(data) == 21 and len({c["id"] for c in data}) == 21
    for c in data:
        for e in c["evidence"]:
            assert any(e in s for d in c["gold_docs"] for s in corpus[d].split("。")), (c["id"], e)


def test_retrieval_eval_numbers_and_paired_diff():
    configs = build_configs()
    data = load_dataset()
    base = evaluate(configs["A 基线：200 字块 + 标题"], data)
    no_title = evaluate(configs["B 去掉块标题"], data)
    assert len(base) == 20  # 无答案题不参与
    s = summarize_retrieval(base)
    assert s["r3"] == 1 and s["r1"] == pytest.approx(0.75)
    worse, better = paired_diff(base, no_title)
    assert worse == ["q01", "q11"] and better == []


def test_citation_checker_catches_wrong_number_and_missing_refs():
    ctx = ["学生认证后年付可享五折。", "Pro 会员月付 39 元，年付 299 元。"]
    segs = check_citations("Pro 会员月付 39 元、年付 299 元 [1]；学生认证后年付可享五折 [2]。", ctx)
    assert segs[0].problems == ["数字 39、299 不在引用的块里"]
    assert segs[1].problems == []  # 没有数字的错引，代码查不出来，要靠评审
    segs = check_citations("能识别日语。月付 39 元 [5]。资料中没有相关说明。", ctx)
    assert segs[0].problems == ["没有标引用"]
    assert segs[1].problems == ["引用 [5] 不存在"]
    assert segs[2].problems == []
    # 数字边界：3 不能匹配到 39 里
    assert check_citations("最多 3 台 [2]", ctx)[0].problems == ["数字 3 不在引用的块里"]


def test_key_fact_recall():
    assert key_fact_recall("免费版 15 GB，Pro 2 TB", ["15 GB", "2 TB"]) == 1
    assert key_fact_recall("免费版 15 GB", ["15 GB", "2 TB"]) == 0.5


def _j(obj):
    return text(json.dumps(obj, ensure_ascii=False))


def test_judge_two_steps_and_request_shape():
    judge = FakeAnthropic([
        _j({"claims": ["退款 3 到 5 个工作日到账", "退款后云空间清空"]}),
        _j({"verdicts": [
            {"claim": "退款 3 到 5 个工作日到账", "supported": True, "reason": "doc 1"},
            {"claim": "退款后云空间清空", "supported": False, "reason": "资料未提及"},
        ]}),
    ])
    case = {"id": "q15", "question": "退款多久到账？", "key_facts": ["3 到 5 个工作日"]}
    r = evaluate_answer(judge, case, "3 到 5 个工作日到账 [1]，之后云空间清空 [1]。", ["款项会在 3 到 5 个工作日内原路退回。"])
    assert r.faithfulness == 0.5
    assert len(judge.calls) == 2
    call = judge.calls[1]
    assert call["model"] == JUDGE_MODEL
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert "<context>" in call["messages"][0]["content"] and "2. 退款后云空间清空" in call["messages"][0]["content"]


def test_refusal_has_no_claims_and_skips_verify():
    judge = FakeAnthropic([_j({"claims": []})])
    case = {"id": "q21", "question": "CEO 是谁", "key_facts": ["资料中没有相关说明"]}
    r = evaluate_answer(judge, case, "资料中没有相关说明。", ["无关"])
    assert r.faithfulness is None and len(judge.calls) == 1 and r.segments[0].problems == []


def test_judge_count_mismatch_is_an_error_not_a_pass():
    judge = FakeAnthropic([_j({"claims": ["a", "b"]}), _j({"verdicts": [{"claim": "a", "supported": True, "reason": ""}]})])
    with pytest.raises(ValueError):
        evaluate_answer(judge, {"id": "x", "question": "q", "key_facts": []}, "a [1]。b [1]。", ["a b"])


def test_summarize_and_review_sample():
    v = lambda c, ok: Verdict(c, ok, "")  # noqa: E731
    results = [
        CaseResult("q1", "", "", [Segment("x", [1])], 1.0, [v("a", True), v("b", True)]),
        CaseResult("q2", "", "", [Segment("y", [1], ["没有标引用"])], 0.5, [v("c", True), v("d", False)]),
        CaseResult("q3", "", "", [Segment("z", [])], 1.0, None),
    ]
    s = summarize(results)
    assert s["judged"] == 2
    assert s["faithfulness"] == pytest.approx(0.75)  # (1.0 + 0.5) / 2，拒答不进分母
    assert s["answers_with_unsupported"] == 1
    assert s["citation_ok"] == pytest.approx(2 / 3)
    assert s["key_fact_recall"] == pytest.approx(2.5 / 3)
    sample = review_sample(results, 2)
    assert sample[0] == ("q2", v("d", False))  # 判不支持的排最前、全拿
    assert len(sample) == 3 and all(x[1].supported for x in sample[1:])
