"""RAG 평가 하네스 — 지표 계산·집계(결정적). 실측 품질이 아니라 하네스 로직 검증."""
from __future__ import annotations

from app.ai import eval as rag_eval


def test_recall_at_k():
    assert rag_eval.recall_at_k([1, 2, 3], {2, 5}, 3) == 0.5   # 2 중 1개
    assert rag_eval.recall_at_k([1, 2, 3], {1, 2}, 2) == 1.0
    assert rag_eval.recall_at_k([9, 8], {1}, 2) == 0.0
    assert rag_eval.recall_at_k([1], set(), 2) is None          # 정답 없음 → 제외


def test_precision_at_k():
    assert rag_eval.precision_at_k([1, 2, 3, 4], {2, 4}, 4) == 0.5
    assert rag_eval.precision_at_k([1, 2], {1, 2, 9}, 5) == 1.0  # 분모=검색수(2)
    assert rag_eval.precision_at_k([], {1}, 5) == 0.0
    assert rag_eval.precision_at_k([1], set(), 5) is None


def test_reciprocal_rank():
    assert rag_eval.reciprocal_rank([9, 8, 2, 1], {2}) == 1 / 3  # 3번째
    assert rag_eval.reciprocal_rank([2, 9], {2}) == 1.0
    assert rag_eval.reciprocal_rank([9, 8], {2}) == 0.0
    assert rag_eval.reciprocal_rank([1], set()) is None


def test_run_eval_aggregate(monkeypatch):
    # 검색·씨앗을 위조해 집계 산술만 검증.
    ranking = {"q1": [1, 2, 3], "q2": [9, 8, 7]}
    monkeypatch.setattr(
        rag_eval, "_ranked_report_ids",
        lambda db, actor, query, *, k, graph, rerank, hyde: ranking[query],
    )
    monkeypatch.setattr(rag_eval, "_seed_recall", lambda db, q, e: 1.0 if e else None)
    cases = [
        {"id": "q1", "query": "q1", "expect_report_ids": [2], "expect_entities": ["x"]},
        {"id": "q2", "query": "q2", "expect_report_ids": [1]},  # 정답 없음(검색에 1 없음)
    ]
    res = rag_eval.run_eval(None, None, cases, k=3)
    agg = res["aggregate"]
    assert agg["n_cases"] == 2
    # q1 recall=1.0(2 in top3), q2 recall=0.0 → 평균 0.5
    assert agg["recall@3"] == 0.5
    # mrr: q1=1/2=0.5, q2=0 → 0.25
    assert agg["mrr"] == 0.25
    # seed_recall: q1=1.0, q2=None(제외) → 1.0
    assert agg["seed_recall"] == 1.0
