"""질문 → 씨앗 객체 링킹 (GraphRAG ①) — GraphRAG_설계.md §3.1.

GraphRAG Q&A 의 진입점: "이 질문이 어떤 온톨로지 객체를 다루나"를 찾는다. 찾은
씨앗에서 `expand_related` 로 그래프 이웃까지 넓혀 근거 검색 범위를 만든다.

두 신호를 섞는다(autotag 와 같은 철학, 결정적 우선):

  1. **키워드** — 엔티티 값이 질문 문자열에 그대로 등장하면 강한 신호(점수 1.0).
     후보는 `Entity.value ILIKE %토큰%` (status=active) 로 좁혀 스캔 비용을 bound.

  2. **임베딩** — 질문 임베딩 ↔ 후보 값 임베딩 코사인으로 의미적 후보를 보강.
     임베딩 백엔드가 mock(개발 기본)이면 노이즈만 되므로 건너뛴다(autotag 동일).

엔티티는 전역 온톨로지라 grant 스코프가 없다(여기선 가시성 필터 없음). 씨앗으로
검색하는 **보고서**는 hybrid_search 가 이미 grant 게이팅하므로 근거는 새지 않는다.
신규 테이블 없음.
"""
from __future__ import annotations

import re

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.entities.models import Entity, EntityStatus, EntityType

# ILIKE 후보 스캔 상한(값 트라이그램 인덱스가 없으므로 seq scan bound).
_MAX_CANDIDATES = 300
# 너무 짧은 토큰/값은 우연히 잡혀 노이즈가 된다(autotag 와 동일 하한).
_MIN_TERM_LEN = 2
# 임베딩 후보 상한(임베딩 호출 비용 bound).
_MAX_EMBED_CANDIDATES = 200

_TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣]+")


def _tokens(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text or "") if len(t) >= _MIN_TERM_LEN]


def link_query_entities(db: Session, query: str, *, limit: int = 6) -> list[dict]:
    """질문 → 씨앗 객체 리스트 `[{id, value, type_slug, type_label, via}]`.

    키워드 강한 신호(값이 질문에 등장)를 우선하고, 남는 슬롯을 임베딩 코사인으로
    채운다. 후보 0이면 빈 리스트(호출부가 그래프 근거를 생략하고 순수 벡터 폴백)."""
    q = (query or "").strip()
    toks = _tokens(q)
    if not toks:
        return []

    # 후보군: 질문 토큰 중 하나라도 값에 포함되는 active 엔티티(상한).
    rows = db.execute(
        select(Entity.id, Entity.value, EntityType.slug, EntityType.label)
        .join(EntityType, EntityType.id == Entity.type_id)
        .where(
            Entity.status == EntityStatus.active,
            or_(*[Entity.value.ilike(f"%{t}%") for t in toks]),
        )
        .limit(_MAX_CANDIDATES)
    ).all()
    if not rows:
        return []

    q_low = q.lower()
    seeds: dict[int, dict] = {}
    scores: dict[int, float] = {}
    # 1) 키워드 강한 신호 — 값이 질문에 통째로 등장.
    for eid, value, tslug, tlabel in rows:
        if value and value.lower() in q_low:
            seeds[eid] = {
                "id": eid, "value": value, "type_slug": tslug,
                "type_label": tlabel, "via": "keyword",
            }
            scores[eid] = 1.0

    # 2) 임베딩 보강 — 아직 안 잡힌 후보를 의미 유사도로. mock 백엔드면 생략.
    if (settings.embedding_backend or "mock").lower() != "mock":
        pool = [(eid, v, s, l) for (eid, v, s, l) in rows if eid not in seeds]
        pool = pool[:_MAX_EMBED_CANDIDATES]
        if pool:
            _embed_augment(q, pool, seeds, scores)

    ranked = sorted(seeds.values(), key=lambda s: scores[s["id"]], reverse=True)
    return ranked[:limit]


def _embed_augment(query: str, pool, seeds: dict, scores: dict) -> None:
    """질문 임베딩 ↔ 후보 값 임베딩 코사인으로 seeds/scores 를 채운다(임계 이상만)."""
    import numpy as np

    # 지연 import — mock 경로에선 임베딩 모듈을 건드리지 않게(autotag 동일).
    from app.ai.embeddings import EmbeddingError, embed_texts

    try:
        vecs = embed_texts([query] + [v for _, v, _, _ in pool])
    except EmbeddingError:
        return  # 임베딩 장애 — 유사도 레이어만 조용히 포기(키워드 결과는 유지).

    mat = np.asarray(vecs, dtype=np.float32)
    norm = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-8)
    qv = norm[0]
    sims = norm[1:] @ qv  # (C,)

    min_score = settings.embedding_suggest_min_score
    for (eid, value, tslug, tlabel), sim in zip(pool, sims):
        s = float(sim)
        if s < min_score:
            continue
        seeds[eid] = {
            "id": eid, "value": value, "type_slug": tslug,
            "type_label": tlabel, "via": "embedding",
        }
        scores[eid] = s
