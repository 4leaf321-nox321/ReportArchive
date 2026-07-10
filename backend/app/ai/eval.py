"""RAG 검색 평가 하네스 (AI검색 지능화 로드맵 7).

골든셋(질문 + 기대 근거 보고서/객체)에 대해 현재 검색 파이프라인을 돌려
recall@k·precision@k·MRR 을 산출한다. 임계·로직·설정을 바꾼 뒤 재실행해 **좋아졌는지
측정**하는 토대(감 튜닝 종식). 실측은 임베딩/LLM 백엔드가 켜진 운영에서 유의미하고
(dev mock 은 검색이 결정적이지 않음), 지표 계산 로직 자체는 결정적이라 테스트한다.

골든셋 형식(JSON):
  {"cases": [
    {"id": "q1", "query": "낙하시험 실패 사례",
     "expect_report_ids": [123, 456],      // 관련 보고서(정답)
     "expect_entities": ["배터리"],          // (선택) 질문이 다뤄야 할 씨앗 객체값
     "graph": true},                        // (선택) 이 케이스만 그래프 모드
  ]}
report_id 는 배포마다 다르므로 골든셋은 **그 배포 데이터로 작성**한다(example 제공).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session


# --- 지표(순수 함수) ---------------------------------------------------------
def recall_at_k(retrieved: list[int], relevant: set[int], k: int) -> Optional[float]:
    """top-k 안에 든 정답 비율. 정답이 없으면 None(집계에서 제외)."""
    if not relevant:
        return None
    hits = sum(1 for r in retrieved[:k] if r in relevant)
    return hits / len(relevant)


def precision_at_k(retrieved: list[int], relevant: set[int], k: int) -> Optional[float]:
    """top-k 중 정답 비율. 분모는 실제 검색된 수(≤k) — 희소 결과 과벌 방지."""
    top = retrieved[:k]
    if not top:
        return 0.0 if relevant else None
    if not relevant:
        return None
    return sum(1 for r in top if r in relevant) / len(top)


def reciprocal_rank(retrieved: list[int], relevant: set[int]) -> Optional[float]:
    """첫 정답의 역순위(1/rank). 정답이 top 에 없으면 0. 정답 세트 없으면 None."""
    if not relevant:
        return None
    for i, r in enumerate(retrieved, start=1):
        if r in relevant:
            return 1.0 / i
    return 0.0


def _mean(xs: list[float]) -> Optional[float]:
    vals = [x for x in xs if x is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


# --- 실행 -------------------------------------------------------------------
def _ranked_report_ids(db, actor, query, *, k, graph, rerank, hyde) -> list[int]:
    """현재 파이프라인이 이 질문에 매기는 보고서 순위(중복 제거, 순서 유지)."""
    from app.ai import qa

    res = qa._retrieve(
        db, actor, query, limit=max(k, 10), graph=graph, rerank=rerank, hyde=hyde
    )
    if isinstance(res, dict):  # 근거 없음
        return []
    _, citations, _, _ = res
    out: list[int] = []
    for c in citations:
        rid = c.get("report_id")
        if rid is not None and rid not in out:
            out.append(rid)
    return out


def _seed_recall(db, query, expect_entities: list[str]) -> Optional[float]:
    """질문→씨앗 링킹이 기대 객체(값)를 얼마나 잡나(부분일치, 대소문자 무시)."""
    if not expect_entities:
        return None
    from app.ai import graph_link

    seeds = graph_link.link_query_entities(db, query, limit=10)
    got = {(s.get("value") or "").lower() for s in seeds}
    hit = sum(1 for e in expect_entities if any(e.lower() in g or g in e.lower() for g in got))
    return hit / len(expect_entities)


def evaluate_case(
    db: Session, actor, case: dict, *, k: int,
    graph: bool = False, rerank: Optional[bool] = None, hyde: Optional[bool] = None,
) -> dict:
    """한 케이스 평가 → 지표 dict. 케이스의 graph 플래그가 있으면 그걸 우선."""
    query = case.get("query", "")
    relevant = {int(r) for r in (case.get("expect_report_ids") or [])}
    g = bool(case.get("graph", graph))
    retrieved = _ranked_report_ids(db, actor, query, k=k, graph=g, rerank=rerank, hyde=hyde)
    return {
        "id": case.get("id"),
        "query": query,
        "retrieved": retrieved[:k],
        f"recall@{k}": recall_at_k(retrieved, relevant, k),
        f"precision@{k}": precision_at_k(retrieved, relevant, k),
        "mrr": reciprocal_rank(retrieved, relevant),
        "seed_recall": _seed_recall(db, query, case.get("expect_entities") or []),
    }


def run_eval(
    db: Session, actor, cases: list[dict], *, k: int = 5,
    graph: bool = False, rerank: Optional[bool] = None, hyde: Optional[bool] = None,
) -> dict:
    """골든셋 전체 평가 → {cases:[...], aggregate:{...}, config:{...}}."""
    rows = [
        evaluate_case(db, actor, c, k=k, graph=graph, rerank=rerank, hyde=hyde)
        for c in cases
    ]
    agg = {
        f"recall@{k}": _mean([r[f"recall@{k}"] for r in rows]),
        f"precision@{k}": _mean([r[f"precision@{k}"] for r in rows]),
        "mrr": _mean([r["mrr"] for r in rows]),
        "seed_recall": _mean([r["seed_recall"] for r in rows]),
        "n_cases": len(rows),
    }
    return {
        "cases": rows,
        "aggregate": agg,
        "config": {"k": k, "graph": graph, "rerank": rerank, "hyde": hyde},
    }


def load_golden(path: str | Path) -> list[dict]:
    """골든셋 JSON 로드 → cases 리스트. {cases:[...]} 또는 [...] 둘 다 허용."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    cases = data.get("cases") if isinstance(data, dict) else data
    if not isinstance(cases, list):
        raise ValueError("골든셋은 cases 배열이어야 합니다.")
    return cases
