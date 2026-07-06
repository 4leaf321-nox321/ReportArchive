"""아카이브 RAG Q&A (A, B300_보조AI_설계.md §A) — 질문 → 검색 → 인용 답변.

hybrid_search(시맨틱 벡터 + pg_trgm 키워드 RRF)로 권한 게이팅된 상위 청크를
모아 번호 출처 프롬프트를 만들고 B300(llm.chat)에게 **출처만 근거로** 답하게
한다. 하이브리드라 품번·코드·고유명사 같은 정확매치 질문도 누락 없이 근거로
끌어온다(시맨틱 단독이 약한 부분). 근거가 약하면(검색 0건) LLM 을 호출하지 않아
환각을 막는다. 데이터 권한은 hybrid_search 의 가시 scope 가 이미 보장(권한 밖
보고서는 컨텍스트에 못 들어가 인용 불가) — 기능 권한 게이트(§E)는 호출부에서
통과시킨다.

**GraphRAG(graph=True, GraphRAG_설계.md):** 질문이 다루는 온톨로지 객체를 찾아
(link_query_entities) → 연결 이웃까지 넓히고(expand_related) → 그 이웃에 연결된
보고서 근거를 가중치로 끌어올려 순수 벡터 결과와 블렌드한다. 출처엔 작성자·
날짜와 (그래프 근거의 경우) 연결 객체를 함께 단다.
"""
from __future__ import annotations

import re

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai import search as ai_search
from app.ai.llm import CancelCheck, chat, chat_cancellable
from app.modules.entities.models import Entity, ReportEntity
from app.modules.reports.models import Report
from app.modules.users.models import User

# 컨텍스트 토큰 폭주 방지 — 출처 1개당 본문 길이 상한(문자).
_MAX_CHARS_PER_SOURCE = 1200
# 그래프 근거 가중 — 연결 이웃에 걸린 보고서를 순수 벡터 히트보다 우선.
_GRAPH_BOOST = 1.5
# 질문당 씨앗 객체 상한.
_MAX_SEEDS = 6
# 출처에 표시할 연결 객체값 상한.
_MAX_OBJECTS_PER_SOURCE = 5

_SYSTEM = (
    "당신은 사내 CAE 보고서 아카이브 어시스턴트다. 아래 [출처]에 있는 내용만 "
    "근거로, 한국어로 간결히 답하라. 각 주장 끝에 근거 출처를 [번호] 로 인용하라. "
    "출처에 없는 내용은 '해당 내용은 아카이브에서 찾지 못했습니다' 라고 답하고 "
    "추측하지 마라."
)

_CITE_RE = re.compile(r"\[(\d+)\]")


def _blend(plain: list[dict], graph_hits: list[dict], limit: int) -> list[dict]:
    """순수 벡터 히트 + 그래프 근거 히트를 report_id 로 병합.

    그래프 히트는 rrf_score×_GRAPH_BOOST 로 끌어올리고 `graph=True` 로 표시한다.
    양쪽에 있으면 graph=True + max(점수). 정렬 후 상위 `limit`."""
    by_id: dict[int, dict] = {}
    for h in plain:
        by_id[h["report_id"]] = {
            "hit": h, "score": h.get("rrf_score", 0.0), "graph": False,
        }
    for h in graph_hits:
        rid = h["report_id"]
        boosted = h.get("rrf_score", 0.0) * _GRAPH_BOOST
        cur = by_id.get(rid)
        if cur:
            cur["graph"] = True
            if boosted > cur["score"]:
                cur["score"] = boosted
                cur["hit"] = h
        else:
            by_id[rid] = {"hit": h, "score": boosted, "graph": True}
    ranked = sorted(by_id.values(), key=lambda x: x["score"], reverse=True)[:limit]
    return [{**x["hit"], "graph": x["graph"]} for x in ranked]


def _hydrate_authors(db: Session, report_ids: list[int]) -> dict[int, dict]:
    """보고서별 작성자(owner.name)·날짜(updated_at) — 출처 강화용(1 JOIN)."""
    if not report_ids:
        return {}
    rows = db.execute(
        select(Report.id, User.name, Report.updated_at)
        .join(User, User.id == Report.owner_user_id, isouter=True)
        .where(Report.id.in_(report_ids))
    ).all()
    return {
        rid: {
            "author": name,
            "date": dt.date().isoformat() if dt is not None else None,
        }
        for rid, name, dt in rows
    }


def _graph_objects(
    db: Session, report_ids: list[int], expanded_ids: set[int]
) -> dict[int, list[str]]:
    """그래프 근거 보고서 → 그 보고서가 링크한 '연결 이웃' 객체값(왜 관련인지)."""
    if not report_ids or not expanded_ids:
        return {}
    rows = db.execute(
        select(ReportEntity.report_id, Entity.value)
        .join(Entity, Entity.id == ReportEntity.entity_id)
        .where(
            ReportEntity.report_id.in_(report_ids),
            ReportEntity.entity_id.in_(list(expanded_ids)),
        )
    ).all()
    out: dict[int, list[str]] = {}
    for rid, val in rows:
        vals = out.setdefault(rid, [])
        if val not in vals and len(vals) < _MAX_OBJECTS_PER_SOURCE:
            vals.append(val)
    return out


def _retrieve(db: Session, actor, query: str, *, limit: int, graph: bool = False):
    """질문 → (질문문, citations, blocks, seeds) 또는 근거 없음 dict.

    graph=True 면 씨앗 객체 링킹 → 이웃 확장 → 그래프 근거를 순수 벡터와 블렌드
    (GraphRAG_설계.md §2). 동기/비동기 ask 양쪽이 공유한다."""
    q = (query or "").strip()
    if not q:
        return {"answer": "", "citations": [], "no_evidence": True, "seeds": []}

    seeds: list[dict] = []
    expanded_ids: set[int] = set()
    graph_hits: list[dict] = []

    # 하이브리드(시맨틱+키워드 RRF) + 청크 전문(snippet_chars=None). 근거 가드
    # 임계(embedding_hybrid_min_score)는 hybrid_search 내부 적용.
    plain = ai_search.hybrid_search(db, q, actor, limit=limit, snippet_chars=None)

    if graph:
        # 지연 import — 순수 벡터 경로(graph=False)엔 온톨로지 의존을 끌어들이지 않게.
        from app.ai import graph_link
        from app.modules.entities.services import expand_related

        seeds = graph_link.link_query_entities(db, q, limit=_MAX_SEEDS)
        if seeds:
            expanded = expand_related(db, entity_ids=[s["id"] for s in seeds])
            expanded_ids = set(expanded)
            if expanded_ids:
                graph_hits = ai_search.hybrid_search(
                    db, q, actor, limit=limit,
                    entity_ids=list(expanded_ids), snippet_chars=None,
                )

    hits = _blend(plain, graph_hits, limit)
    if not hits:
        return {
            "answer": "관련 보고서를 찾지 못했습니다.",
            "citations": [],
            "no_evidence": True,
            "seeds": seeds,
        }

    report_ids = [h["report_id"] for h in hits]
    authors = _hydrate_authors(db, report_ids)
    objs = _graph_objects(
        db, [h["report_id"] for h in hits if h.get("graph")], expanded_ids
    )

    citations, blocks = [], []
    for i, h in enumerate(hits, start=1):
        rid = h["report_id"]
        full = h.get("snippet") or ""
        title = h.get("title") or f"보고서 {rid}"
        meta = authors.get(rid, {})
        author = meta.get("author")
        date = meta.get("date")
        linked = objs.get(rid, [])
        # 출처 헤더에 작성자·날짜(+그래프 근거면 연결객체)를 실어 LLM 도 provenance 인지.
        head = f"보고서: {title}"
        if author:
            head += f" · 작성자 {author}"
        if date:
            head += f" · {date}"
        if linked:
            head += f" · 관련객체 {', '.join(linked)}"
        blocks.append(f"[{i}] ({head})\n{full[:_MAX_CHARS_PER_SOURCE]}")
        citations.append(
            {
                "n": i,
                "report_id": rid,
                "title": h.get("title"),
                "workspace_slug": h.get("workspace_slug"),
                "block_id": h.get("block_id"),
                "page_idx": h.get("page_idx"),
                "snippet": full[:200],
                "author": author,
                "date": date,
                "graph": bool(h.get("graph")),
                "objects": linked,
            }
        )
    return q, citations, blocks, seeds


def _qa_messages(q: str, blocks: list[str]) -> list[dict]:
    user_msg = "[출처]\n" + "\n\n".join(blocks) + f"\n\n질문: {q}"
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user_msg},
    ]


def _finalize(
    answer: str, citations: list[dict], res, *, seeds: Optional[list[dict]] = None
) -> dict:
    # 답변에 실제 인용된 번호만 표시용 마킹(LLM 이 누락/오기해도 출처는 전부 반환).
    used = {int(n) for n in _CITE_RE.findall(answer or "")}
    for c in citations:
        c["used"] = c["n"] in used
    return {
        "answer": answer or "",
        "citations": citations,
        "no_evidence": False,
        "model": res.model,
        "backend": res.backend,
        "seeds": seeds or [],
    }


def ask_archive(
    db: Session, actor, query: str, *, limit: int = 8, graph: bool = False
) -> dict:
    """질문 → {answer, citations, no_evidence, seeds, ...}. actor 는 검색 권한
    scope 용(.user.id 기반 가시 보고서). 기능 권한 게이트는 호출부에서 이미 통과.
    graph=True 면 GraphRAG(온톨로지 그래프 근거 블렌드)."""
    retrieved = _retrieve(db, actor, query, limit=limit, graph=graph)
    if isinstance(retrieved, dict):
        return retrieved
    q, citations, blocks, seeds = retrieved
    # LLM 호출 — 실패(LLMError)는 위로 전파(라우트가 502). 검색·앱은 무영향.
    res = chat(_qa_messages(q, blocks))
    return _finalize(res.content or "", citations, res, seeds=seeds)


async def ask_archive_cancellable(
    db: Session,
    actor,
    query: str,
    *,
    limit: int = 8,
    graph: bool = False,
    should_cancel: Optional[CancelCheck] = None,
) -> dict:
    """ask_archive 의 비동기·취소 가능 버전(라우트가 클라이언트 연결 끊김을
    should_cancel 로 넘긴다). 검색은 동기지만 짧고, 긴 LLM 생성만 스트리밍해
    중간 취소된다. 결과 형태는 ask_archive 와 동일."""
    retrieved = _retrieve(db, actor, query, limit=limit, graph=graph)
    if isinstance(retrieved, dict):
        return retrieved
    q, citations, blocks, seeds = retrieved
    res = await chat_cancellable(_qa_messages(q, blocks), should_cancel=should_cancel)
    return _finalize(res.content or "", citations, res, seeds=seeds)
