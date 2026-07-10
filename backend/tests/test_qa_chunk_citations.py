"""청크 단위 인용 — _pick_chunks 의 breadth-first→depth 채우기·폴백·그래프 청크 포함."""
from __future__ import annotations

from app.ai import qa


def _sem_patch(monkeypatch, sem):
    monkeypatch.setattr(
        qa.ai_search, "top_chunks_for_reports",
        lambda db, q, order, per_report=3: sem,
    )


def test_breadth_first_then_depth(monkeypatch):
    hits = [
        {"report_id": 1, "graph": False, "title": "A"},
        {"report_id": 2, "graph": False, "title": "B"},
    ]
    sem = [
        {"report_id": 1, "chunk_index": 0, "block_id": "b10", "page_idx": 0, "snippet": "a0"},
        {"report_id": 1, "chunk_index": 1, "block_id": "b11", "page_idx": 0, "snippet": "a1"},
        {"report_id": 2, "chunk_index": 0, "block_id": "b20", "page_idx": 0, "snippet": "c0"},
        {"report_id": 1, "chunk_index": 2, "block_id": "b12", "page_idx": 0, "snippet": "a2"},
    ]
    _sem_patch(monkeypatch, sem)
    picked = qa._pick_chunks(None, "q", hits, [], [1, 2], limit=5)
    seq = [(rid, c["chunk_index"]) for rid, c in picked]
    # 넓이 우선: (1,0)·(2,0) 먼저 → 깊이: (1,1)·(1,2). report2 는 1개뿐.
    assert seq == [(1, 0), (2, 0), (1, 1), (1, 2)], seq


def test_limit_caps_total(monkeypatch):
    hits = [{"report_id": r, "graph": False, "title": str(r)} for r in (1, 2, 3)]
    sem = [
        {"report_id": r, "chunk_index": i, "block_id": f"b{r}{i}", "page_idx": 0, "snippet": f"{r}-{i}"}
        for r in (1, 2, 3) for i in range(3)
    ]
    _sem_patch(monkeypatch, sem)
    picked = qa._pick_chunks(None, "q", hits, [], [1, 2, 3], limit=3)
    # limit=3 → 각 보고서 최적 1개씩(넓이 우선)에서 멈춤.
    assert [rid for rid, _ in picked] == [1, 2, 3], picked


def test_fallback_to_hit_snippet(monkeypatch):
    hits = [{
        "report_id": 3, "graph": True, "title": "C", "snippet": "c-hit",
        "block_id": "bx", "page_idx": 1, "chunk_index": None,
    }]
    _sem_patch(monkeypatch, [])
    picked = qa._pick_chunks(None, "q", hits, [], [3], limit=5)
    assert len(picked) == 1
    rid, c = picked[0]
    assert rid == 3 and c["snippet"] == "c-hit" and c["block_id"] == "bx"


def test_includes_graph_chunk(monkeypatch):
    hits = [{"report_id": 1, "graph": True, "title": "A"}]
    graph = [{"report_id": 1, "chunk_index": 5, "block_id": "b5",
              "page_idx": 2, "snippet": "g5", "rrf_score": 0.7}]
    _sem_patch(monkeypatch, [])
    picked = qa._pick_chunks(None, "q", hits, graph, [1], limit=5)
    assert [c["chunk_index"] for _, c in picked] == [5], picked


def _cands(n):
    return [(i, {"report_id": i, "chunk_index": 0, "snippet": f"snippet {i}"})
            for i in range(1, n + 1)]


def test_parse_rerank_scores():
    from app.ai.qa import _parse_rerank_scores

    txt = '설명 무시... [{"i": 2, "score": 9}, {"i": 1, "score": 3}, {"i": 5, "score": 7}]'
    got = _parse_rerank_scores(txt, n=4)
    # i=5 는 범위밖(n=4) → 제외.
    assert got == {2: 9.0, 1: 3.0}, got
    assert _parse_rerank_scores("JSON 아님", 4) == {}
    assert _parse_rerank_scores("[깨진 json", 4) == {}


def test_rerank_reorders_by_llm_score(monkeypatch):
    from types import SimpleNamespace
    from app.ai import qa

    cands = _cands(4)
    fake = SimpleNamespace(backend="openai",
                           content='[{"i":3,"score":9},{"i":1,"score":5},{"i":2,"score":1}]')
    monkeypatch.setattr(qa, "chat", lambda messages: fake)
    out = qa._rerank("q", cands, limit=2)
    # 점수: 3→9, 1→5, 2→1, 4→0 → 상위2 = 후보3, 후보1.
    assert [rid for rid, _ in out] == [3, 1], out


def test_rerank_fallback_on_mock_and_error(monkeypatch):
    from types import SimpleNamespace
    from app.ai import qa

    cands = _cands(4)
    # mock 백엔드 → 1차 순서 상위 limit.
    monkeypatch.setattr(qa, "chat",
                        lambda m: SimpleNamespace(backend="mock", content="[]"))
    assert [r for r, _ in qa._rerank("q", cands, 2)] == [1, 2]

    # LLM 예외 → 폴백.
    def _boom(m):
        raise RuntimeError("llm down")
    monkeypatch.setattr(qa, "chat", _boom)
    assert [r for r, _ in qa._rerank("q", cands, 2)] == [1, 2]

    # 후보가 limit 이하 → 그대로.
    assert qa._rerank("q", cands[:2], 2) == cands[:2]
