"""시맨틱 + 하이브리드 검색 — report_chunks(벡터)를 쓰되 권한(가시성)을 그대로 존중.

가시성 게이팅은 기존 키워드 검색(reports.services.search_reports)이 쓰는
visible_report_ids / public_viewer / virtual 로직을 **그대로 재사용**한다 — 권한
판정을 두 곳에 두지 않기 위해서. 즉 시맨틱 검색이 권한 밖 보고서를 노출할 수 없다.

- semantic_search: 질의 임베딩 → report_chunks 코사인 KNN(HNSW) → 보고서별 최적 청크.
- hybrid_search:   semantic + keyword 를 RRF(reciprocal rank fusion)로 합산.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import and_, case, desc, select
from sqlalchemy.orm import Session

from app.ai.embeddings import embed_one
from app.ai.models import ReportChunk
from app.config import settings
from app.modules.reports.models import Report
from app.modules.reports.services import (
    all_visible_report_ids,
    entity_filter_report_ids,
    list_public_reports_on_board,
)

# scope 인자 미지정 vs 명시적 None(무스코프) 구분용 센티넬.
_UNSET: object = object()


def _apply_entity_scope(db, scope, entity_ids, entity_rollup):
    """엔티티 태그 필터를 가시 scope 에 교집합으로 얹는다. 벡터 경로(시맨틱)는
    쿼리에 EXISTS 를 엮기 번거로워, 매칭 report id 집합을 미리 계산해 scope 와
    AND 한다(권한은 그대로 존중). entity_ids 없으면 scope 그대로."""
    if not entity_ids:
        return scope
    efilter = entity_filter_report_ids(db, entity_ids, rollup=entity_rollup)
    return efilter if scope is None else (scope & efilter)


def _visible_scope_ids(db: Session, actor) -> Optional[set[int]]:
    """검색이 볼 수 있는 report id 집합. None = 무스코프(전체 가시), 빈 set = 없음.

    **사용자 중심 가시성**(all_visible_report_ids) — 활성 ws 무관, 멤버십 기반. 검색은
    "내가 실제 entitle 된 것"이어야 하고(MCP 가 보낸 활성 ws 에 좌우되지 않게), 동시에
    상위 부문 게시판에 *게시만* 된 글은 새지 않아야 한다(게시 누수 제외). public_viewer
    (비멤버 외부 열람)는 해당 게시판 공개분으로 한정."""
    if getattr(actor, "public_viewer", False):
        return {r.id for r in list_public_reports_on_board(db, actor.workspace.slug)}
    if getattr(actor.workspace, "virtual", False):
        return None
    return all_visible_report_ids(db, actor.user.id)


def _hydrate_meta(db: Session, report_ids: list[int]) -> dict[int, dict]:
    """결과로 내보낼 보고서별 표시 메타(제목 + 워크스페이스 slug).

    workspace_slug 는 프론트가 결과 클릭 시 `/w/{slug}/reports/{id}` 로 이동하는 데
    필요하다(키워드 검색의 ReportSummary 와 동일 역할). 추가 필드이므로 MCP 등
    기존 소비자에 무해.
    """
    if not report_ids:
        return {}
    rows = db.execute(
        select(Report.id, Report.title, Report.workspace_slug).where(
            Report.id.in_(report_ids)
        )
    ).all()
    return {rid: {"title": title, "workspace_slug": slug} for rid, title, slug in rows}


def semantic_search(
    db: Session,
    query: str,
    actor,
    *,
    limit: int = 20,
    candidate_chunks: int = 200,
    min_score: float = 0.0,
    scope=_UNSET,
    entity_ids: Optional[list[int]] = None,
    entity_rollup: bool = False,
) -> list[dict]:
    """벡터 유사도 검색 — 보고서별 최적(최근접) 청크 기준 상위 limit 개.

    candidate_chunks = 코사인 KNN 으로 먼저 끌어올 청크 수(이 안에서 보고서별
    1개로 접는다). 권한 스코프로 사전 필터. min_score 미만(약한 매치)은 제외 —
    하이브리드에서 노이즈/mock 결과가 키워드를 오염시키지 않게. scope 를 주면
    (hybrid 가 한 번 계산해 전달) 재계산하지 않는다.
    """
    q = (query or "").strip()
    if not q:
        return []
    if scope is _UNSET:
        scope = _visible_scope_ids(db, actor)
        # 직접 호출 경로에서만 엔티티 필터 적용 — hybrid 는 미리 필터한 scope 를 넘긴다.
        scope = _apply_entity_scope(db, scope, entity_ids, entity_rollup)
    if scope is not None and not scope:
        return []

    qvec = embed_one(q)
    dist = ReportChunk.embedding.cosine_distance(qvec).label("dist")
    stmt = (
        select(
            ReportChunk.report_id,
            ReportChunk.block_id,
            ReportChunk.page_idx,
            ReportChunk.text,
            dist,
        )
        .join(Report, Report.id == ReportChunk.report_id)
        .where(Report.deleted_at.is_(None))
    )
    if scope is not None:
        stmt = stmt.where(Report.id.in_(scope))
    stmt = stmt.order_by(dist).limit(candidate_chunks)

    best: dict[int, dict] = {}
    for report_id, block_id, page_idx, text, d in db.execute(stmt).all():
        score = 1.0 - float(d)  # 코사인 유사도(1=동일)
        if score < min_score:
            continue  # 약한 매치 제외
        if report_id not in best:  # 거리 오름차순 → 첫 등장이 그 보고서 최적 청크
            best[report_id] = {
                "report_id": report_id,
                "score": round(score, 4),
                "block_id": block_id,
                "page_idx": page_idx,
                "snippet": (text or "")[:200],
            }
        if len(best) >= limit:
            break

    results = list(best.values())[:limit]
    meta = _hydrate_meta(db, [r["report_id"] for r in results])
    for r in results:
        m = meta.get(r["report_id"], {})
        r["title"] = m.get("title")
        r["workspace_slug"] = m.get("workspace_slug")
    return results


def _keyword_search(db: Session, query: str, scope: Optional[set[int]], *, limit: int):
    """pg_trgm 부분일치 키워드 검색 — 주어진 scope(권한) 안에서. (id, title) 랭킹 리스트.

    search_reports(웹용, 활성 ws 기준)와 달리 hybrid 가 계산한 *넓은* scope 를 그대로
    받아 쓴다 — 키워드 절반도 시맨틱과 같은(전 워크스페이스) 범위를 보도록.
    """
    tokens = [t for t in (query or "").split() if t]
    if not tokens:
        return []
    conds = [Report.deleted_at.is_(None), Report.search_text.isnot(None)]
    for tok in tokens:
        conds.append(Report.search_text.ilike(f"%{tok}%"))
    if scope is not None:
        conds.append(Report.id.in_(scope))
    title_rank = case(
        (and_(*[Report.title.ilike(f"%{t}%") for t in tokens]), 0), else_=1
    )
    return db.execute(
        select(Report.id, Report.title)
        .where(*conds)
        .order_by(title_rank, desc(Report.updated_at))
        .limit(limit)
    ).all()


def hybrid_search(
    db: Session,
    query: str,
    actor,
    *,
    limit: int = 20,
    rrf_k: int = 60,
    entity_ids: Optional[list[int]] = None,
    entity_rollup: bool = False,
) -> list[dict]:
    """semantic + keyword 를 RRF 로 합산. 한쪽에만 잡혀도 상위로 끌어올린다.

    RRF: score(report) = Σ 1/(rrf_k + rank) over 각 랭킹(0-base rank).
    의미(벡터)와 정확 단어(pg_trgm) 양쪽 강점을 모두 취한다. 권한 스코프(전
    워크스페이스 합집합)를 한 번 계산해 양쪽에 동일 적용한다. entity_ids 필터도
    scope 에 한 번 얹어 시맨틱·키워드 양쪽이 같은 엔티티 필터를 본다.
    """
    scope = _visible_scope_ids(db, actor)
    scope = _apply_entity_scope(db, scope, entity_ids, entity_rollup)
    if scope is not None and not scope:
        return []

    # 약한/노이즈 시맨틱이 키워드 결과를 오염시키지 않도록 임계값 적용.
    sem = semantic_search(
        db, query, actor, limit=max(limit, 50),
        min_score=settings.embedding_hybrid_min_score, scope=scope,
    )
    kw_rows = _keyword_search(db, query, scope, limit=max(limit, 50))

    sem_ids = {item["report_id"] for item in sem}
    kw_ids = {rid for rid, _ in kw_rows}

    scores: dict[int, float] = {}
    meta: dict[int, dict] = {}
    for rank, item in enumerate(sem):
        rid = item["report_id"]
        scores[rid] = scores.get(rid, 0.0) + 1.0 / (rrf_k + rank)
        meta[rid] = dict(item)
    for rank, (rid, title) in enumerate(kw_rows):
        scores[rid] = scores.get(rid, 0.0) + 1.0 / (rrf_k + rank)
        meta.setdefault(rid, {"report_id": rid, "title": title, "snippet": None})

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    # 키워드 전용 히트는 workspace_slug 가 없으므로(=_keyword_search 가 id,title 만 반환)
    # 최종 랭킹 id 에 대해 표시 메타를 한 번에 보강한다.
    hydrated = _hydrate_meta(db, [rid for rid, _ in ranked])
    out = []
    for rid, sc in ranked:
        m = meta.get(rid, {"report_id": rid})
        h = hydrated.get(rid, {})
        out.append(
            {
                "report_id": rid,
                "title": h.get("title") or m.get("title"),
                "workspace_slug": h.get("workspace_slug"),
                "snippet": m.get("snippet"),
                "block_id": m.get("block_id"),
                "page_idx": m.get("page_idx"),
                "rrf_score": round(sc, 6),
                "in_semantic": rid in sem_ids,
                "in_keyword": rid in kw_ids,
            }
        )
    return out
