"""질문→씨앗 링킹의 의미검색(_rank_by_cosine) — lexical 무관 순수 코사인 랭킹."""
from __future__ import annotations


def test_rank_by_cosine_threshold_and_order():
    from app.ai.graph_link import _rank_by_cosine

    ids = [10, 20, 30]
    ent = [[1, 0], [0, 1], [0.9, 0.1]]  # 10·30 은 [1,0] 방향, 20 은 직교
    q = [1, 0]
    ranked = _rank_by_cosine(q, ids, ent, 0.5)
    got_ids = [i for i, _ in ranked]
    # 20(코사인 0)은 임계 미만 → 제외. 10(1.0)이 30(~0.994)보다 앞.
    assert got_ids == [10, 30], ranked
    assert ranked[0][1] >= ranked[1][1]


def test_rank_by_cosine_all_below_threshold():
    from app.ai.graph_link import _rank_by_cosine

    assert _rank_by_cosine([1, 0], [1], [[0, 1]], 0.5) == []
