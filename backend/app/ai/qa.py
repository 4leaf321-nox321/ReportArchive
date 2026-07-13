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
# 질문 분해 — 복합 질문을 독립 검색 가능한 하위 질문들로.
_MAX_SUBQUESTIONS = 3
_DECOMPOSE_SYSTEM = (
    "복합 질문을 독립적으로 검색 가능한 하위 질문들로 분해하라. 단순 질문이면 그대로 "
    "1개만 반환한다. 최대 3개, 각 하위질문은 완결된 한국어 문장. 출력은 JSON 문자열 "
    '배열만: ["하위질문1", "하위질문2"]. 다른 말·설명 없이 JSON 만 출력하라.'
)
# 별칭 확장 시 질문에 덧붙일 표기 상한(질의 폭주 방지).
_MAX_ALIAS_TERMS = 12
# 근거 검증 — 답변의 각 주장이 출처에 뒷받침되는지 사후 판정.
_VERIFY_SYSTEM = (
    "너는 엄격한 팩트체커다. [답변]의 각 주장이 [출처]에 실제로 적혀 있어 "
    "뒷받침되는지만 판정하라. 출처에 없으면 supported=false(추론·상식으로 채우지 "
    "말 것). 각 주장마다 뒷받침되면 supported=true·출처번호(source)·출처에서 근거가 "
    "되는 문장(quote)을 원문 그대로. 출력은 JSON 하나만:\n"
    '{"claims":[{"text":"주장","supported":true,"source":2,"quote":"근거 문장"}]}\n'
    "설명 없이 JSON 만 출력하라."
)

_SYSTEM = (
    "당신은 사내 CAE 보고서 아카이브 어시스턴트다. 아래 [출처]에 있는 내용만 "
    "근거로, 한국어로 간결히 답하라. 각 주장 끝에 근거 출처를 [번호] 로 인용하라. "
    "출처에 없는 내용은 '해당 내용은 아카이브에서 찾지 못했습니다' 라고 답하고 "
    "추측하지 마라."
)

_CITE_RE = re.compile(r"\[(\d+)\]")


def _blend(
    plain: list[dict], graph_hits: list[dict], limit: int,
    boosts: Optional[dict] = None,
) -> list[dict]:
    """순수 벡터 히트 + 그래프 근거 히트를 report_id 로 병합.

    그래프 히트는 rrf_score×_GRAPH_BOOST 로 끌어올리고 `graph=True` 로 표시한다.
    양쪽에 있으면 graph=True + max(점수). boosts(랭킹 신호=최신성·권위)가 오면 최종
    점수에 곱한다(관련도 × 신호). 정렬 후 상위 `limit`."""
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
    if boosts:
        for rid, x in by_id.items():
            x["score"] *= boosts.get(rid, 1.0)
    ranked = sorted(by_id.values(), key=lambda x: x["score"], reverse=True)[:limit]
    return [{**x["hit"], "graph": x["graph"]} for x in ranked]


# 권위 포화 상수 — 피인용 count/(count+K) 로 0..1 정규화(몇 건이면 이미 상당).
_AUTHORITY_SATURATION = 3.0


def _boost_value(recency: float, authority: float, w_rec: float, w_auth: float) -> float:
    """관련도에 곱할 랭킹 신호 배수 = 1 + w_rec·recency + w_auth·authority. 순수(테스트용)."""
    return 1.0 + w_rec * recency + w_auth * authority


def _ranking_boosts(db: Session, report_ids: list[int]) -> dict[int, float]:
    """report_id → 랭킹 신호 배수(최신성·권위). 가중치가 모두 0이면 {}(무효과 빠른 경로).

    최신성 = 0.5**(경과일/반감기) ∈ (0,1]. 권위 = 피인용수/(피인용수+K) ∈ [0,1)."""
    from app.modules.app_settings import store

    w_rec = float(store.get("rag_recency_weight") or 0.0)
    w_auth = float(store.get("rag_authority_weight") or 0.0)
    if (w_rec <= 0 and w_auth <= 0) or not report_ids:
        return {}
    ids = list(report_ids)

    recency: dict[int, float] = {}
    if w_rec > 0:
        from datetime import date

        half = max(1, int(store.get("rag_recency_halflife_days") or 365))
        today = date.today()
        for rid, rdate in db.execute(
            select(Report.id, Report.report_date).where(Report.id.in_(ids))
        ).all():
            if rdate is None:
                continue
            age = max(0, (today - rdate).days)
            recency[rid] = 0.5 ** (age / half)

    authority: dict[int, float] = {}
    if w_auth > 0:
        from sqlalchemy import func as safunc

        from app.modules.reports.models import ReportLink
        for rid, cnt in db.execute(
            select(ReportLink.to_report_id, safunc.count())
            .where(ReportLink.to_report_id.in_(ids))
            .group_by(ReportLink.to_report_id)
        ).all():
            authority[rid] = cnt / (cnt + _AUTHORITY_SATURATION)

    return {
        rid: _boost_value(recency.get(rid, 0.0), authority.get(rid, 0.0), w_rec, w_auth)
        for rid in ids
    }


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

    # 질문 이해 — 분해(복합질문→하위질문 union) vs HyDE(가상답변 임베딩). 둘 다 켜지면
    # 분해 우선(하위질문이 이미 구체적이라 HyDE 불필요). 별칭 확장은 독립(키워드만 보강).
    alias_on = _alias_expand_enabled()
    if _decompose_enabled():
        subqs = _decompose(q)          # 최대 N, 실패 시 [q]
        embed_q = None                 # 청크 랭킹은 원 질문 벡터
        embed_of: dict[str, Optional[str]] = {sq: None for sq in subqs}
    else:
        embed_q = _hyde(q) if _hyde_enabled(hyde) else None
        subqs = [q]
        embed_of = {q: embed_q}
    kw_full = _alias_expand(db, q) if alias_on else None

    # 하이브리드(시맨틱+키워드 RRF) + 청크 전문(snippet_chars=None). (분해된) 하위질문
    # 마다 검색해 report_id 로 union(최대 rrf 점수). 근거 가드 임계는 hybrid_search 내부.
    plain_by_report: dict[int, dict] = {}
    for sq in subqs:
        kw_q = kw_full if sq == q else (_alias_expand(db, sq) if alias_on else None)
        for h in ai_search.hybrid_search(
            db, sq, actor, limit=pool, snippet_chars=None,
            embed_query=embed_of.get(sq), keyword_query=kw_q,
        ):
            rid = h["report_id"]
            cur = plain_by_report.get(rid)
            if cur is None or h.get("rrf_score", 0.0) > cur.get("rrf_score", 0.0):
                plain_by_report[rid] = h
    plain = list(plain_by_report.values())

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
                    embed_query=embed_q, keyword_query=kw_full,
                )
                # 텍스트-무관 이웃 — 씨앗/이웃 객체를 **직접 언급하는 구절**(청크↔객체
                # 링크, p74)도 근거로. 질문과 벡터 안 닮아도 그 객체가 나온 문단을 끌어온다.
                graph_hits += ai_search.chunks_for_entities(
                    db, list(expanded_ids), actor, limit=pool,
                )

    # 랭킹 신호(최신성·권위) — 후보 보고서에 배수 계산(가중치 0이면 무효과).
    cand_ids = {h["report_id"] for h in plain} | {h["report_id"] for h in graph_hits}
    boosts = _ranking_boosts(db, list(cand_ids))
    hits = _blend(plain, graph_hits, pool, boosts=boosts)
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
    override(있으면) 우선, 없으면 런타임 설정 기본값. → 사용자가 질문마다 켜고 끈다."""
    from app.config import settings
    from app.modules.app_settings import store

    if (settings.llm_backend or "mock").lower() == "mock":
        return False
    if override is not None:
        return bool(override)
    return bool(store.get("rag_rerank_enabled"))


def _hyde_enabled(override: Optional[bool] = None) -> bool:
    """HyDE on 여부. mock 이면 무효. override(요청별) 우선, 없으면 런타임 설정 기본값."""
    from app.config import settings
    from app.modules.app_settings import store

    if (settings.llm_backend or "mock").lower() == "mock":
        return False
    if override is not None:
        return bool(override)
    return bool(store.get("rag_hyde_enabled"))


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


_CONTEXTUALIZE_SYSTEM = (
    "너는 검색 질의 재작성기다. 아래 대화를 참고해, 사용자의 마지막 질문을 그것만 "
    "떼어놓아도 검색되는 '완전한 독립 질문'으로 바꿔라. 지시어(그거·그것·그 중·그 과제 "
    "등)를 대화 속 구체 대상으로 풀고, 생략된 조건(연도·종류·부서 등)을 채워라. "
    "이미 독립적이면 거의 그대로 두라. 설명 없이 재작성된 질문 한 줄만 출력."
)


def _contextualize(history: Optional[list], followup: str) -> str:
    """대화 히스토리로 후속 질문을 독립형(self-contained) 질문으로 재작성한다.
    히스토리 없으면(첫 턴) 원 질문 그대로 — LLM 호출 안 함. 보강 레이어라
    mock/오류/빈 결과면 원 질문 폴백(대화가 죽지 않게)."""
    fq = (followup or "").strip()
    if not history or not fq:
        return fq
    msgs = [{"role": "system", "content": _CONTEXTUALIZE_SYSTEM}]
    for m in history:
        role = (m or {}).get("role")
        content = ((m or {}).get("content") or "").strip()
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    msgs.append({
        "role": "user",
        "content": f"방금 이 질문을 독립형 질문으로 재작성해줘(질문만): {fq}",
    })
    try:
        res = chat(msgs)
    except Exception:  # noqa: BLE001 — 보강 레이어, 어떤 실패든 폴백
        return fq
    if getattr(res, "backend", "") == "mock":
        return fq
    rewritten = (res.content or "").strip()
    return rewritten or fq


def _decompose_enabled() -> bool:
    from app.config import settings
    from app.modules.app_settings import store

    return bool(store.get("rag_decompose_enabled")) and (
        (settings.llm_backend or "mock").lower() != "mock"
    )


def _alias_expand_enabled() -> bool:
    from app.modules.app_settings import store

    return bool(store.get("rag_alias_expand_enabled"))


def _verify_enabled(override: Optional[bool] = None) -> bool:
    """근거 검증 on 여부. mock 이면 무효. override(요청별) 우선, 없으면 설정 기본값."""
    from app.config import settings
    from app.modules.app_settings import store

    if (settings.llm_backend or "mock").lower() == "mock":
        return False
    if override is not None:
        return bool(override)
    return bool(store.get("rag_verify_enabled"))


def _verify(answer: str, blocks: list[str]) -> Optional[dict]:
    """답변의 각 주장을 출처(blocks)와 대조 → {claims:[{text,supported,source,quote}],
    unsupported}. 보강 레이어라 mock/오류/파싱실패면 None(답변은 그대로 나간다)."""
    import json

    if not (answer or "").strip() or not blocks:
        return None
    try:
        res = chat([
            {"role": "system", "content": _VERIFY_SYSTEM},
            {"role": "user", "content": f"[출처]\n" + "\n\n".join(blocks) + f"\n\n[답변]\n{answer}"},
        ])
    except Exception:  # noqa: BLE001 — 보강 레이어, 어떤 실패든 검증 생략
        return None
    if getattr(res, "backend", "") == "mock":
        return None
    m = re.search(r"\{.*\}", res.content or "", re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except (ValueError, TypeError):
        return None
    claims: list[dict] = []
    for c in (data.get("claims") if isinstance(data, dict) else None) or []:
        if not isinstance(c, dict):
            continue
        text = str(c.get("text", "")).strip()
        if not text:
            continue
        src_n = c.get("source")
        try:
            src_n = int(src_n) if src_n is not None else None
        except (ValueError, TypeError):
            src_n = None
        claims.append({
            "text": text,
            "supported": bool(c.get("supported")),
            "source": src_n,
            "quote": str(c.get("quote", "")).strip(),
        })
    if not claims:
        return None
    return {"claims": claims, "unsupported": sum(1 for c in claims if not c["supported"])}


def _parse_json_list(text: str) -> list[str]:
    """LLM 응답에서 JSON 문자열 배열 추출. 실패 시 []."""
    import json

    m = re.search(r"\[.*\]", text or "", re.DOTALL)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except (ValueError, TypeError):
        return []
    return [s for s in arr if isinstance(s, str)] if isinstance(arr, list) else []


def _decompose(q: str) -> list[str]:
    """복합 질문 → 하위 질문 리스트(최대 _MAX_SUBQUESTIONS). 보강 레이어라 mock/오류/
    빈응답이면 [q](원 질문 1개)로 폴백 — 검색이 죽지 않게."""
    try:
        res = chat([
            {"role": "system", "content": _DECOMPOSE_SYSTEM},
            {"role": "user", "content": q},
        ])
    except Exception:  # noqa: BLE001 — 보강 레이어, 어떤 실패든 폴백
        return [q]
    if getattr(res, "backend", "") == "mock":
        return [q]
    subs = [s.strip() for s in _parse_json_list(res.content or "") if s.strip()]
    return subs[:_MAX_SUBQUESTIONS] or [q]


def _alias_expand(db: Session, q: str) -> Optional[str]:
    """질문이 언급한 엔티티의 다른 표기(정식명·코드·별칭)를 질문에 덧붙인다.

    온톨로지 별칭 재사용(LLM 불필요) — 질문이 약어로 물어도 정식명만 쓴 보고서를
    키워드로 찾게 한다. 언급 판정은 경계매칭(부분문자열 오탐 방지). 없으면 None."""
    from sqlalchemy import or_, select as sa_select

    from app.modules.entities.autotag import _boundary_hit
    from app.modules.entities.models import Entity, EntityAlias, EntityStatus

    ql = q.lower()
    toks = [t for t in re.findall(r"[0-9A-Za-z가-힣]+", q) if len(t) >= 2]
    if not toks:
        return None
    like = [f"%{t}%" for t in toks]
    # 후보 엔티티(값/코드 또는 별칭이 질문 토큰과 겹침) — 상한으로 스캔 bound.
    cand: set[int] = set()
    for (eid,) in db.execute(
        sa_select(Entity.id).where(
            Entity.status == EntityStatus.active,
            or_(*[Entity.value.ilike(p) for p in like]),
        ).limit(200)
    ).all():
        cand.add(eid)
    for (eid,) in db.execute(
        sa_select(EntityAlias.entity_id).where(
            or_(*[EntityAlias.alias.ilike(p) for p in like])
        ).limit(200)
    ).all():
        cand.add(eid)
    if not cand:
        return None
    # 후보들의 모든 표기(값·코드·별칭) 로드.
    names: dict[int, set[str]] = {}
    for eid, value, code in db.execute(
        sa_select(Entity.id, Entity.value, Entity.code).where(Entity.id.in_(cand))
    ).all():
        s = names.setdefault(eid, set())
        for n in (value, code):
            if n:
                s.add(n)
    for eid, alias in db.execute(
        sa_select(EntityAlias.entity_id, EntityAlias.alias).where(
            EntityAlias.entity_id.in_(cand)
        )
    ).all():
        names.setdefault(eid, set()).add(alias)
    # 실제 언급된 엔티티(표기 하나라도 경계매칭)의 '아직 질문에 없는' 표기를 확장.
    extra: list[str] = []
    for nameset in names.values():
        if not any(_boundary_hit(n.lower(), ql) for n in nameset):
            continue
        for n in nameset:
            if n.lower() not in ql and n not in extra:
                extra.append(n)
    extra = extra[:_MAX_ALIAS_TERMS]
    return q + " " + " ".join(extra) if extra else None


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
    verify: Optional[bool] = None,
) -> dict:
    """질문 → {answer, citations, no_evidence, seeds, ...}. actor 는 검색 권한
    scope 용(.user.id 기반 가시 보고서). 기능 권한 게이트는 호출부에서 이미 통과.
    graph=True 면 GraphRAG(온톨로지 그래프 근거 블렌드). rerank/hyde/verify=요청별 override."""
    from app.ai import structured_qa

    routed = structured_qa.maybe_answer(db, actor, query)
    if routed is not None:
        return routed  # 집계형 질문 → 온톨로지 SQL 집계(개수 정확). 아니면 아래 RAG.
    retrieved = _retrieve(
        db, actor, query, limit=limit, graph=graph, rerank=rerank, hyde=hyde
    )
    if isinstance(retrieved, dict):
        return retrieved
    q, citations, blocks, seeds = retrieved
    # LLM 호출 — 실패(LLMError)는 위로 전파(라우트가 502). 검색·앱은 무영향.
    res = chat(_qa_messages(q, blocks))
    result = _finalize(res.content or "", citations, res, seeds=seeds)
    if _verify_enabled(verify):
        v = _verify(result["answer"], blocks)
        if v:
            result["verification"] = v
    return result


async def ask_archive_cancellable(
    db: Session,
    actor,
    query: str,
    *,
    limit: int = 8,
    graph: bool = False,
    rerank: Optional[bool] = None,
    hyde: Optional[bool] = None,
    verify: Optional[bool] = None,
    should_cancel: Optional[CancelCheck] = None,
) -> dict:
    """ask_archive 의 비동기·취소 가능 버전(라우트가 클라이언트 연결 끊김을
    should_cancel 로 넘긴다). 검색은 동기지만 짧고, 긴 LLM 생성만 스트리밍해
    중간 취소된다. 결과 형태는 ask_archive 와 동일."""
    from app.ai import structured_qa

    routed = structured_qa.maybe_answer(db, actor, query)
    if routed is not None:
        return routed  # 집계형 질문 → 온톨로지 SQL 집계(개수 정확). 아니면 아래 RAG.
    retrieved = _retrieve(
        db, actor, query, limit=limit, graph=graph, rerank=rerank, hyde=hyde
    )
    if isinstance(retrieved, dict):
        return retrieved
    q, citations, blocks, seeds = retrieved
    res = await chat_cancellable(_qa_messages(q, blocks), should_cancel=should_cancel)
    result = _finalize(res.content or "", citations, res, seeds=seeds)
    if _verify_enabled(verify):
        v = _verify(result["answer"], blocks)  # 검증 LLM 콜(취소 후 폴백은 _verify 내부)
        if v:
            result["verification"] = v
    return result
