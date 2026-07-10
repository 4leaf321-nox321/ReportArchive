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
