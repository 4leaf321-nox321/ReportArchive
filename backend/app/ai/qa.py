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
# 한 보고서에서 인용할 최대 청크(구절) 수 — 긴 보고서의 여러 관련 문단을 각각
# 인용하되, 한 보고서가 출처를 독식하지 않게 상한. breadth-first 로 채워 넓이 우선.
_CHUNKS_PER_REPORT = 3
# 재랭킹 후보 배수 — limit×배수 만큼 뽑아 재채점 후 상위 limit.
_RERANK_MULT = 3
# 재랭킹 프롬프트에 넣는 청크당 본문 길이 상한(토큰 폭주 방지).
_RERANK_SNIPPET_CHARS = 500
_RERANK_SYSTEM = (
    "당신은 검색 결과 재랭커다. 사용자 질문에 대해 각 문단이 '답의 근거'로 "
    "얼마나 적합한지 0~10 정수로 채점하라. 관련 없으면 0. 출력은 JSON 배열만: "
    '[{"i": 번호, "score": 점수}, ...]. 다른 말·설명 없이 JSON 만 출력하라.'
)
# HyDE 가상 답변 문단 생성 프롬프트 — 검색 임베딩용(사실 정확성 불필요).
_HYDE_SYSTEM = (
    "당신은 사내 CAE 보고서 아카이브를 돕는다. 사용자 질문에 대해, 실제 보고서에 "
    "있을 법한 이상적인 '답변 문단'을 한국어로 3~4문장 지어내라. 사실 여부는 중요치 "
    "않다(검색용 가상 문단이다). 질문의 핵심 용어·동의어·관련 개념을 풍부히 담되, "
    "머리말 없이 문단만 출력하라."
)

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


def _retrieve(
    db: Session, actor, query: str, *, limit: int, graph: bool = False,
    rerank: Optional[bool] = None, hyde: Optional[bool] = None,
):
    """질문 → (질문문, citations, blocks, seeds) 또는 근거 없음 dict.

    graph=True 면 씨앗 객체 링킹 → 이웃 확장 → 그래프 근거를 순수 벡터와 블렌드
    (GraphRAG_설계.md §2). rerank/hyde 는 요청별 override(None=설정 기본값).
    동기/비동기 ask 양쪽이 공유한다."""
    q = (query or "").strip()
    if not q:
        return {"answer": "", "citations": [], "no_evidence": True, "seeds": []}

    seeds: list[dict] = []
    expanded_ids: set[int] = set()
    graph_hits: list[dict] = []

    # 재랭킹이 켜져 있으면 후보를 넉넉히(limit×배수) 뽑아 2차 재채점 후 상위 limit
    # 로 절단한다 — 재랭킹이 #9 를 #1 로 끌어올리려면 후보 풀이 넓어야 한다.
    rerank_on = _rerank_enabled(rerank)
    pool = limit * _RERANK_MULT if rerank_on else limit

    # HyDE — 시맨틱 검색용 임베딩 텍스트를 가상 답변 문단으로 대체(키워드·씨앗은 원 질문).
    embed_q = _hyde(q) if _hyde_enabled(hyde) else None

    # 하이브리드(시맨틱+키워드 RRF) + 청크 전문(snippet_chars=None). 근거 가드
    # 임계(embedding_hybrid_min_score)는 hybrid_search 내부 적용.
    plain = ai_search.hybrid_search(
        db, q, actor, limit=pool, snippet_chars=None, embed_query=embed_q
    )

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
                    db, q, actor, limit=pool,
                    entity_ids=list(expanded_ids), snippet_chars=None,
                    embed_query=embed_q,
                )
                # 텍스트-무관 이웃 — 씨앗/이웃 객체를 **직접 언급하는 구절**(청크↔객체
                # 링크, p74)도 근거로. 질문과 벡터 안 닮아도 그 객체가 나온 문단을 끌어온다.
                graph_hits += ai_search.chunks_for_entities(
                    db, list(expanded_ids), actor, limit=pool,
                )

    hits = _blend(plain, graph_hits, pool)
    if not hits:
        return {
            "answer": "관련 보고서를 찾지 못했습니다.",
            "citations": [],
            "no_evidence": True,
            "seeds": seeds,
        }

    # 보고서 단위 랭킹(hits)을 청크 단위 인용으로 넓힌다 — 긴 보고서의 여러 관련
    # 문단을 각각 근거로. 승자 보고서별 청크 목록을 만들고 breadth-first 로 채운다.
    order = [h["report_id"] for h in hits]
    picked = _pick_chunks(db, q, hits, graph_hits, order, pool, embed_query=embed_q)
    # 2차 재랭킹 — 넓은 후보를 LLM 적합도로 재정렬해 상위 limit 만 인용.
    if rerank_on:
        picked = _rerank(q, picked, limit)

    report_ids = [rid for rid, _ in picked]
    authors = _hydrate_authors(db, list(dict.fromkeys(report_ids)))
    graph_reports = {h["report_id"] for h in hits if h.get("graph")}
    objs = _graph_objects(db, list(graph_reports), expanded_ids)

    titles = {h["report_id"]: h.get("title") for h in hits}
    slugs = {h["report_id"]: h.get("workspace_slug") for h in hits}

    citations, blocks = [], []
    for i, (rid, c) in enumerate(picked, start=1):
        full = c.get("snippet") or ""
        title = titles.get(rid) or f"보고서 {rid}"
        meta = authors.get(rid, {})
        author = meta.get("author")
        date = meta.get("date")
        linked = objs.get(rid, [])
        is_graph = rid in graph_reports
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
                "title": titles.get(rid),
                "workspace_slug": slugs.get(rid),
                "block_id": c.get("block_id"),
                "page_idx": c.get("page_idx"),
                "chunk_index": c.get("chunk_index"),
                "snippet": full[:200],
                "author": author,
                "date": date,
                "graph": is_graph,
                "objects": linked,
            }
        )
    return q, citations, blocks, seeds


def _rerank_enabled(override: Optional[bool] = None) -> bool:
    """재랭킹 on 여부. 생성 LLM 이 mock 이면 항상 무효(무의미). 그 외엔 요청별
    override(있으면) 우선, 없으면 설정 기본값. → 사용자가 질문마다 켜고 끌 수 있다."""
    from app.config import settings

    if (settings.llm_backend or "mock").lower() == "mock":
        return False
    if override is not None:
        return bool(override)
    return bool(settings.rag_rerank_enabled)


def _hyde_enabled(override: Optional[bool] = None) -> bool:
    """HyDE on 여부. mock 이면 무효. override(요청별) 우선, 없으면 설정 기본값."""
    from app.config import settings

    if (settings.llm_backend or "mock").lower() == "mock":
        return False
    if override is not None:
        return bool(override)
    return bool(settings.rag_hyde_enabled)


def _hyde(q: str) -> Optional[str]:
    """질문 → 시맨틱 검색용 임베딩 텍스트('원 질문 + 가상 답변 문단').

    가상 문단은 문서 공간에 가까워 실제 청크와 매칭이 좋다. 원 질문을 함께 앞에
    붙여, HyDE 가 엉뚱하게 새더라도 질문 신호를 잃지 않게 앵커링한다. 보강 레이어라
    LLM 오류·mock 이면 None(호출부가 원 질문 임베딩으로 폴백)."""
    try:
        res = chat([
            {"role": "system", "content": _HYDE_SYSTEM},
            {"role": "user", "content": q},
        ])
    except Exception:  # noqa: BLE001 — 보강 레이어, 어떤 실패든 폴백
        return None
    if getattr(res, "backend", "") == "mock":
        return None
    text = (res.content or "").strip()
    return f"{q}\n{text}" if text else None


def _parse_rerank_scores(text: str, n: int) -> dict[int, float]:
    """LLM 응답에서 [{"i","score"}] JSON 배열 파싱 → {i: score}. 실패/범위밖은 무시."""
    import json

    m = re.search(r"\[.*\]", text or "", re.DOTALL)
    if not m:
        return {}
    try:
        arr = json.loads(m.group(0))
    except (ValueError, TypeError):
        return {}
    out: dict[int, float] = {}
    for item in arr if isinstance(arr, list) else []:
        try:
            i = int(item["i"])
            s = float(item["score"])
        except (KeyError, TypeError, ValueError):
            continue
        if 1 <= i <= n:
            out[i] = s
    return out


def _rerank(q: str, candidates: list[tuple[int, dict]], limit: int) -> list[tuple[int, dict]]:
    """후보 청크를 생성 LLM 으로 질문 적합도 재채점 → 상위 limit.

    재랭킹은 **보강 레이어**다 — LLM 오류·파싱 실패·mock 응답이면 1차 순서 상위
    limit 로 조용히 폴백해 검색이 절대 죽지 않게 한다(최종 답변 생성과 달리 예외를
    위로 던지지 않는다)."""
    if len(candidates) <= limit:
        return candidates  # 재정렬 이득 없음
    lines = []
    for i, (_rid, c) in enumerate(candidates, start=1):
        snip = (c.get("snippet") or "").replace("\n", " ")[:_RERANK_SNIPPET_CHARS]
        lines.append(f"[{i}] {snip}")
    messages = [
        {"role": "system", "content": _RERANK_SYSTEM},
        {"role": "user", "content": f"질문: {q}\n\n문단들:\n" + "\n".join(lines)},
    ]
    try:
        res = chat(messages)
    except Exception:  # noqa: BLE001 — 보강 레이어, 어떤 실패든 폴백
        return candidates[:limit]
    if getattr(res, "backend", "") == "mock":
        return candidates[:limit]
    scores = _parse_rerank_scores(res.content or "", len(candidates))
    if not scores:
        return candidates[:limit]
    # 점수 desc, 동점은 1차 순서 유지(안정). 점수 없는 후보는 0 취급 → 뒤로.
    order = sorted(range(len(candidates)), key=lambda k: (-scores.get(k + 1, 0.0), k))
    return [candidates[k] for k in order[:limit]]


def _pick_chunks(
    db: Session, q: str, hits: list[dict], graph_hits: list[dict],
    order: list[int], limit: int, *, embed_query: Optional[str] = None,
) -> list[tuple[int, dict]]:
    """승자 보고서들에서 인용할 청크를 고른다 — 보고서당 여러 문단, breadth-first.

    ① 각 보고서의 질문-근접 청크(top_chunks_for_reports) + ② 그 보고서를 통과한
    그래프(객체-언급) 청크를 합쳐 보고서별 순서목록을 만든 뒤, 라운드로빈으로
    채운다: 1라운드=각 보고서의 최적 1개(넓이 우선), 이후=상위 보고서의 추가 문단
    (깊이). limit 개까지. 보고서가 hits 뿐이던(청크 없는) 경우 그 대표 스니펫 폴백."""
    sem = ai_search.top_chunks_for_reports(
        db, q, order, per_report=_CHUNKS_PER_REPORT, embed_query=embed_query
    )
    rset = set(order)
    by_report: dict[int, list[dict]] = {rid: [] for rid in order}
    seen: set[tuple[int, int]] = set()

    def _add(rid, c):
        ci = c.get("chunk_index")
        key = (rid, ci if ci is not None else -1 - len(seen))
        if key in seen or len(by_report[rid]) >= _CHUNKS_PER_REPORT:
            return
        seen.add(key)
        by_report[rid].append(c)

    for c in sem:  # 시맨틱 근접 순
        if c["report_id"] in rset:
            _add(c["report_id"], c)
    # 그래프(객체-언급) 청크 — 질문과 벡터 안 닮아도 그 객체가 나온 문단.
    for g in sorted(graph_hits, key=lambda x: x.get("rrf_score", 0.0), reverse=True):
        rid = g.get("report_id")
        if rid in rset and g.get("chunk_index") is not None:
            _add(rid, g)
    # 청크가 하나도 안 잡힌 보고서: 블렌드 히트의 대표 스니펫으로 폴백(빈 출처 방지).
    hit_by_id = {h["report_id"]: h for h in hits}
    for rid in order:
        if not by_report[rid]:
            h = hit_by_id.get(rid, {})
            by_report[rid].append({
                "report_id": rid, "chunk_index": h.get("chunk_index"),
                "block_id": h.get("block_id"), "page_idx": h.get("page_idx"),
                "snippet": h.get("snippet") or "",
            })

    picked: list[tuple[int, dict]] = []
    round_i = 0
    while len(picked) < limit:
        added = False
        for rid in order:
            lst = by_report[rid]
            if round_i < len(lst):
                picked.append((rid, lst[round_i]))
                added = True
                if len(picked) >= limit:
                    break
        if not added:
            break
        round_i += 1
    return picked


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
    db: Session, actor, query: str, *, limit: int = 8, graph: bool = False,
    rerank: Optional[bool] = None, hyde: Optional[bool] = None,
) -> dict:
    """질문 → {answer, citations, no_evidence, seeds, ...}. actor 는 검색 권한
    scope 용(.user.id 기반 가시 보고서). 기능 권한 게이트는 호출부에서 이미 통과.
    graph=True 면 GraphRAG(온톨로지 그래프 근거 블렌드). rerank/hyde=요청별 override."""
    retrieved = _retrieve(
        db, actor, query, limit=limit, graph=graph, rerank=rerank, hyde=hyde
    )
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
    rerank: Optional[bool] = None,
    hyde: Optional[bool] = None,
    should_cancel: Optional[CancelCheck] = None,
) -> dict:
    """ask_archive 의 비동기·취소 가능 버전(라우트가 클라이언트 연결 끊김을
    should_cancel 로 넘긴다). 검색은 동기지만 짧고, 긴 LLM 생성만 스트리밍해
    중간 취소된다. 결과 형태는 ask_archive 와 동일."""
    retrieved = _retrieve(
        db, actor, query, limit=limit, graph=graph, rerank=rerank, hyde=hyde
    )
    if isinstance(retrieved, dict):
        return retrieved
    q, citations, blocks, seeds = retrieved
    res = await chat_cancellable(_qa_messages(q, blocks), should_cancel=should_cancel)
    return _finalize(res.content or "", citations, res, seeds=seeds)
