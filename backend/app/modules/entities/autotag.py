"""자동태깅 — 보고서 본문에서 엔티티(통제어휘) 후보를 추천.

엔티티관리개선_설계.md §3.4 / §4.4 의 C 단계. **자동 태깅이 아니라 "제안"** 이다:
여기서 나온 후보는 칩으로 띄우고 사용자가 수락해야 `report_entities` 에 들어간다.

두 레이어로 후보를 모은다(설계: 결정적 우선, 유사도 후순위):

  1. **결정적 매칭** — 본문 평문에 기존 엔티티의 값/코드/별칭 문자열이 그대로
     등장하면 매칭. 환각 0(없는 값을 만들어내지 않음). 코드(A1234·8자리 BOM)는
     영숫자 경계로 감싸 부분일치 오탐(`A12` ⊂ `A1234`)을 막는다.

  2. **유사도 매칭** — report_chunks 임베딩(이미 계산됨) ↔ 엔티티 값 임베딩의
     코사인 top-k. 결정적으로 못 잡은 의미적 후보를 보강. 임베딩 백엔드가
     mock(개발 기본)이면 의미가 없어 노이즈만 되므로 **건너뛴다**.

신규 테이블 없음(설계 §3.4) — 기존 `entities`/`entity_aliases`/`report_chunks` 만
사용. 제안 수락 로그가 필요해지면 후속에 `entity_tag_suggestions` 추가 검토(§9).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.models import ReportChunk
from app.config import settings
from app.modules.entities.models import (
    Entity,
    EntityAlias,
    EntityStatus,
    EntityType,
    ReportEntity,
)
from app.widgets.text_extraction import extract_chunks_for_report

# 매칭 텍스트 상한 — 추출 평문이 길어도 앞부분만으로 충분(검색 인덱스와 동일 철학).
_MAX_MATCH_CHARS = 200_000
# 결정적 매칭에서 무시할 너무 짧은 문자열(오탐 방지). 1글자 값/코드는 본문 어디서나
# 우연히 잡혀 노이즈가 된다.
_MIN_TERM_LEN = 2
# 유사도 후보로 임베딩할 엔티티 수 상한(임베딩 호출 비용 bound). 초과분은 잘리며
# 그 사실을 result meta 로 알린다(silent truncation 금지).
_MAX_SIMILARITY_CANDIDATES = 400
# 유사도 임계치는 config(embedding_suggest_min_score, 기본 0.45)에서 읽는다 —
# 운영에서 .env 로 튜닝 가능. 짧은 값↔청크라 검색용 hybrid 임계(0.2)보다 높지만
# 0.55 는 실제 관련 항목까지 걸러내 너무 박했음(§4.4 구현 메모).
# 축(axis)별 제안 칩 상한 — 한 축에 수십 개가 쏟아지지 않게.
_MAX_PER_AXIS = 8


@dataclass
class Suggestion:
    """제안 1건 — EntityRefMini + 출처/점수. 라우트가 스키마로 직렬화."""

    id: int
    type_id: int
    type_slug: str
    value: str
    code: Optional[str]
    status: EntityStatus
    source: str  # 'deterministic' | 'similarity'
    score: float


def _report_text(report) -> str:
    """보고서 본문 → 매칭용 단일 평문(소문자). 청크 추출을 재사용해 위젯 구조에
    결합하지 않는다(검색/임베딩과 동일 토대)."""
    chunks = extract_chunks_for_report(report)
    joined = "\n".join(c.text for c in chunks)
    if len(joined) > _MAX_MATCH_CHARS:
        joined = joined[:_MAX_MATCH_CHARS]
    return joined.lower()


def _boundary_hit(term: str, text_lower: str) -> bool:
    """`term`(이미 소문자)이 본문에 '경계가 선' 채로 등장하는지.

    빠른 substring 선검사 후, 영숫자 경계 정규식으로 부분일치 오탐을 거른다:
    `a1234` 는 `a12345` 안에서 매칭되면 안 된다. 한글·기호 값은 영숫자 인접만
    막고 그 외는 substring 으로 허용(한글 단어는 보통 독립적이라 충분)."""
    if term not in text_lower:
        return False
    pat = re.compile(r"(?<![0-9a-z])" + re.escape(term) + r"(?![0-9a-z])")
    return pat.search(text_lower) is not None


def _deterministic(
    db: Session,
    *,
    text_lower: str,
    candidates: list[tuple[Entity, EntityType]],
    alias_map: dict[int, list[str]],
) -> dict[int, Suggestion]:
    """본문에 값/코드/별칭이 그대로 등장하는 엔티티 → 제안(score=1.0)."""
    out: dict[int, Suggestion] = {}
    for ent, etype in candidates:
        terms: list[str] = []
        if ent.value:
            terms.append(ent.value.strip().lower())
        if ent.code:
            terms.append(ent.code.strip().lower())
        terms.extend(alias_map.get(ent.id, []))
        seen: set[str] = set()
        for term in terms:
            if not term or len(term) < _MIN_TERM_LEN or term in seen:
                continue
            seen.add(term)
            if _boundary_hit(term, text_lower):
                out[ent.id] = Suggestion(
                    id=ent.id,
                    type_id=ent.type_id,
                    type_slug=etype.slug,
                    value=ent.value,
                    code=ent.code,
                    status=ent.status,
                    source="deterministic",
                    score=1.0,
                )
                break
    return out


def _similarity(
    db: Session,
    *,
    report_id: int,
    candidates: list[tuple[Entity, EntityType]],
    exclude_ids: set[int],
) -> tuple[dict[int, Suggestion], bool]:
    """report_chunks 임베딩 ↔ 엔티티 값 임베딩 코사인 top-k.

    반환: (제안맵, truncated). truncated=True 면 후보가 상한을 넘어 일부만 평가됨.
    임베딩 백엔드가 mock 이거나 청크가 없으면 빈 결과(False)."""
    if (settings.embedding_backend or "mock").lower() == "mock":
        return {}, False

    rows = db.execute(
        select(ReportChunk.embedding).where(ReportChunk.report_id == report_id)
    ).all()
    if not rows:
        return {}, False  # 아직 임베딩 안 됨 — 결정적 매칭만으로 충분

    chunk_mat = np.asarray([r[0] for r in rows], dtype=np.float32)
    chunk_norm = chunk_mat / (
        np.linalg.norm(chunk_mat, axis=1, keepdims=True) + 1e-8
    )

    pool = [(e, t) for (e, t) in candidates if e.id not in exclude_ids]
    truncated = len(pool) > _MAX_SIMILARITY_CANDIDATES
    pool = pool[:_MAX_SIMILARITY_CANDIDATES]
    if not pool:
        return {}, truncated

    # 지연 import — mock 경로(개발 기본)에선 임베딩 모듈을 건드리지 않게.
    from app.ai.embeddings import EmbeddingError, embed_texts

    try:
        ent_vecs = embed_texts([e.value for e, _ in pool])
    except EmbeddingError:
        # 임베딩 백엔드 장애 — 유사도 레이어만 조용히 포기(결정적 결과는 유지).
        return {}, truncated

    ent_mat = np.asarray(ent_vecs, dtype=np.float32)
    ent_norm = ent_mat / (np.linalg.norm(ent_mat, axis=1, keepdims=True) + 1e-8)
    # (E, D) @ (D, C) → (E, C); 청크 중 최고 유사도가 그 엔티티의 점수.
    best = (ent_norm @ chunk_norm.T).max(axis=1)

    min_score = settings.embedding_suggest_min_score
    out: dict[int, Suggestion] = {}
    for (ent, etype), score in zip(pool, best):
        s = float(score)
        if s < min_score:
            continue
        out[ent.id] = Suggestion(
            id=ent.id,
            type_id=ent.type_id,
            type_slug=etype.slug,
            value=ent.value,
            code=ent.code,
            status=ent.status,
            source="similarity",
            score=round(s, 4),
        )
    return out, truncated


def suggest_entities(db: Session, report) -> dict:
    """보고서 1건의 엔티티 추천 후보. 자동 태깅 아님 — 제안 칩 데이터.

    이미 태깅된 값·deprecated 값은 제외. 결정적 매칭(score=1.0)이 같은 엔티티를
    유사도보다 우선. 축별 최대 _MAX_PER_AXIS 개로 잘라 칩이 폭주하지 않게 한다.

    반환: {"items": [Suggestion...], "truncated": bool, "current": [현재 태그...]}
    `current` = 보고서가 이미 가진 태그(중복 추가 방지용 표시). 일괄 검토 화면이
    "기존 태그" 칼럼에 그대로 그린다.
    """
    text_lower = _report_text(report)

    current_tags = [
        {
            "id": e.id,
            "type_id": e.type_id,
            "type_slug": e.entity_type.slug if e.entity_type else None,
            "value": e.value,
            "code": e.code,
            "status": e.status,
        }
        for e in (report.entities or [])
    ]
    already = {e.id for e in (report.entities or [])}

    # 후보 = 활성 엔티티 전체(+축). 통제어휘라 수백~수천 규모로 한 번에 로드 가능.
    candidates: list[tuple[Entity, EntityType]] = list(
        db.execute(
            select(Entity, EntityType)
            .join(EntityType, EntityType.id == Entity.type_id)
            .where(Entity.status == EntityStatus.active)
        ).all()
    )

    # 별칭 맵(entity_id → [normalized...]) — 활성 엔티티 한정 한 번에.
    alias_map: dict[int, list[str]] = {}
    for ent_id, normalized in db.execute(
        select(EntityAlias.entity_id, EntityAlias.normalized).where(
            EntityAlias.entity_id.in_([e.id for e, _ in candidates])
        )
    ).all() if candidates else []:
        alias_map.setdefault(ent_id, []).append(normalized)

    det = _deterministic(
        db, text_lower=text_lower, candidates=candidates, alias_map=alias_map
    )
    # 유사도는 결정적으로 이미 잡은 것/이미 태깅된 것은 평가에서 제외.
    sim, truncated = _similarity(
        db,
        report_id=report.id,
        candidates=candidates,
        exclude_ids=already | set(det.keys()),
    )

    # 병합 — 결정적이 같은 id 를 이기게(score=1.0). 이미 태깅된 건 빼기.
    merged: dict[int, Suggestion] = {}
    for sid, sug in {**sim, **det}.items():
        if sid in already:
            continue
        merged[sid] = sug

    # 축별 점수 내림차순으로 자르기.
    by_axis: dict[str, list[Suggestion]] = {}
    for sug in merged.values():
        by_axis.setdefault(sug.type_slug, []).append(sug)

    items: list[Suggestion] = []
    for slug in by_axis:
        ranked = sorted(
            by_axis[slug], key=lambda s: (s.score, s.value), reverse=True
        )
        items.extend(ranked[:_MAX_PER_AXIS])

    # 결정적(1.0) → 유사도 순, 값 알파벳으로 안정 정렬.
    items.sort(key=lambda s: (-s.score, s.type_slug, s.value))
    return {"items": items, "truncated": truncated, "current": current_tags}
