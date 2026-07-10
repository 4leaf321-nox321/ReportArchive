"""질문 → 씨앗 객체 링킹 (GraphRAG ①) — GraphRAG_설계.md §3.1.

GraphRAG Q&A 의 진입점: "이 질문이 어떤 온톨로지 객체를 다루나"를 찾는다. 찾은
씨앗에서 `expand_related` 로 그래프 이웃까지 넓혀 근거 검색 범위를 만든다.

두 신호를 섞는다(autotag 와 같은 철학, 결정적 우선):

  1. **키워드** — 엔티티 값이 질문 문자열에 그대로 등장하면 강한 신호(점수 1.0).
     후보는 `Entity.value ILIKE %토큰%` (status=active) 로 좁혀 스캔 비용을 bound.

  2. **임베딩** — 질문 임베딩 ↔ **전체 엔티티 풀**(캐시) 값 임베딩 코사인으로
     의미 씨앗을 보강. lexical(키워드) 겹침과 무관하게 잡으므로, 값이 질문에 한
     글자도 안 나와도 뜻이 가까우면 씨앗이 된다(예: "셀 용량" → 배터리 객체).
     풀 임베딩은 autotag 의 청크 L1 링크와 캐시를 공유(entity_pool_vectors)해
     반복 질문에도 재계산이 없다. 임베딩 백엔드가 mock 이면 건너뛴다.

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

    # 2) 임베딩 보강 — **lexical 겹침과 무관하게** 전체 엔티티 풀(캐시)과 질문을
    #    비교해 의미 씨앗을 찾는다. rows(ILIKE)로 좁히지 않으므로, 값이 질문에
    #    한 글자도 안 나와도 뜻이 가까우면 잡힌다(예: "셀 용량" → 배터리). mock 이면 생략.
    if (settings.embedding_backend or "mock").lower() != "mock":
        _embed_augment(db, q, seeds, scores, limit=limit)

    ranked = sorted(seeds.values(), key=lambda s: scores[s["id"]], reverse=True)
    return ranked[:limit]


def _rank_by_cosine(query_vec, ids, ent_vecs, min_score) -> list[tuple[int, float]]:
    """질문 벡터 ↔ 엔티티 값 벡터 코사인 → 임계 이상 (id, 점수) 내림차순. 순수(테스트용)."""
    import numpy as np

    ent = np.asarray(ent_vecs, dtype=np.float32)
    ent_norm = ent / (np.linalg.norm(ent, axis=1, keepdims=True) + 1e-8)
    qv = np.asarray(query_vec, dtype=np.float32)
    qn = qv / (np.linalg.norm(qv) + 1e-8)
    sims = ent_norm @ qn  # (N,)
    hits = [(ids[i], float(sims[i])) for i in range(len(ids)) if float(sims[i]) >= min_score]
    hits.sort(key=lambda t: t[1], reverse=True)
    return hits


def _embed_augment(db: Session, query: str, seeds: dict, scores: dict, *, limit: int) -> None:
    """질문 ↔ 전체 엔티티 풀(캐시) 코사인으로 의미 씨앗을 채운다(임계 이상 상위만).

    풀 임베딩은 autotag 와 공유하는 프로세스 캐시(entity_pool_vectors)라 반복 질문에도
    엔티티 임베딩을 다시 계산하지 않는다. 이미 키워드로 잡힌 엔티티는 건너뛴다."""
    from app.ai.embeddings import EmbeddingError, embed_texts
    from app.modules.entities.autotag import entity_pool_vectors

    ids, ent_vecs = entity_pool_vectors(db)
    if not ids:
        return
    try:
        qvec = embed_texts([query])[0]
    except EmbeddingError:
        return  # 임베딩 장애 — 유사도 레이어만 조용히 포기(키워드 결과는 유지).

    from app.modules.app_settings import store

    ranked = _rank_by_cosine(qvec, ids, ent_vecs, store.get("seed_link_min_score"))
    new_ids = [eid for eid, _ in ranked if eid not in seeds][:limit]
    if not new_ids:
        return

    # 상위 의미 후보의 표시 메타(값·타입)만 한 번에 로드.
    meta = {
        eid: (value, tslug, tlabel)
        for eid, value, tslug, tlabel in db.execute(
            select(Entity.id, Entity.value, EntityType.slug, EntityType.label)
            .join(EntityType, EntityType.id == Entity.type_id)
            .where(Entity.id.in_(new_ids))
        ).all()
    }
    score_of = dict(ranked)
    for eid in new_ids:
        if eid not in meta:
            continue
        value, tslug, tlabel = meta[eid]
        seeds[eid] = {
            "id": eid, "value": value, "type_slug": tslug,
            "type_label": tlabel, "via": "embedding",
        }
        scores[eid] = score_of[eid]
