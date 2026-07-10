"""집계/구조화 질의 라우팅 (AI검색 지능화 로드맵 3, 팔란티어 차별점).

"2025년 낙하시험 실패한 과제 **몇 개**?", "…목록" 같은 **집계형** 질문은 문단을
긁어오는 RAG 로는 셀 수 없다. 이런 질문을 감지해 **온톨로지(report_entities·
연도 차원)에 SQL 집계**로 답한다. 개수는 **계산**하므로 환각이 없다(LLM 은 의도·
필터·타겟 추출에만 쓰고, 숫자는 DB 가 만든다).

파이프라인:
  ① 휴리스틱 게이트(집계 신호어 없으면 즉시 RAG) — LLM 비용 bound.
  ② LLM 추출: {aggregate, intent(count|list), target(report|타입slug), filters, year}.
  ③ 필터 문자열 → 엔티티 해석(link_query_entities 재사용). 하나라도 못 풀면 RAG.
  ④ 온톨로지 SQL: 가시성∩엔티티필터∩연도 = base 보고서 → 개수/목록/타깃 엔티티.
  ⑤ 답변은 결과에서 **결정적으로 조립**(숫자 정확) + 근거 보고서 인용.
불확실·실패·토글 off 면 None 을 반환해 **일반 RAG 로 폴백**한다(안전).
"""
from __future__ import annotations

import json
import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.llm import chat
from app.config import settings
from app.modules.entities.models import Entity, EntityStatus, ReportEntity
from app.modules.entities.services import list_types
from app.modules.reports.models import Report
from app.modules.reports.services import (
    all_visible_report_ids,
    entity_filter_report_ids,
    report_ids_in_year,
)

# 집계 신호어 — 없으면 LLM 도 안 부르고 바로 RAG.
_CUES = (
    "몇", "개수", "몇개", "건", "얼마나", "목록", "리스트", "총", "각각",
    "비교", "통계", "count", "list", "how many",
)
_MAX_LIST_PREVIEW = 30   # 답변에 나열할 값 상한
_MAX_CITATIONS = 10      # 근거로 첨부할 보고서 상한

_EXTRACT_SYSTEM = (
    "너는 사내 보고서 아카이브의 질의 분석기다. 사용자 질문이 '집계형'(개수/목록/"
    "비교)인지 판별하고, 그렇다면 구조화 파라미터를 뽑아라. 출력은 JSON 하나만.\n"
    '형식: {"aggregate": true|false, "intent": "count"|"list", '
    '"target": "report" 또는 아래 타입 slug 중 하나, '
    '"filters": ["조건값", ...], "year": 정수 또는 null, '
    '"group_by": null 또는 "year" 또는 축 slug}\n'
    "- aggregate=false 면 나머지는 무시된다(단순 조회/설명 질문).\n"
    "- target: 무엇을 세거나 나열하나. 보고서면 \"report\", 특정 축(과제·부품 등)의 "
    "값을 세면 그 축의 slug.\n"
    "- filters: 조건이 되는 값들(예: 시험종류·결과·모델명). 질문에 나온 표현 그대로.\n"
    "- year: 연도 조건(없으면 null).\n"
    "- group_by: '연도별·부서별·종류별' 처럼 **쪼개서/비교해서** 세라면 그 기준"
    "('year' 또는 축 slug), 아니면 null.\n"
    "설명 없이 JSON 만 출력하라."
)


def _has_aggregate_cue(q: str) -> bool:
    ql = q.lower()
    return any(c in ql for c in _CUES)


def _extract(db: Session, q: str) -> Optional[dict]:
    """LLM 으로 집계 파라미터 추출. 실패/파싱불가/mock 이면 None."""
    types = list_types(db)
    type_lines = "\n".join(f"- {t.slug}: {t.label}" for t in types)
    res = chat([
        {"role": "system", "content": _EXTRACT_SYSTEM},
        {"role": "user", "content": f"[사용 가능한 축(slug: 라벨)]\n{type_lines}\n\n질문: {q}"},
    ])
    if getattr(res, "backend", "") == "mock":
        return None
    m = re.search(r"\{.*\}", res.content or "", re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except (ValueError, TypeError):
        return None


def _resolve_filters(db: Session, filters: list[str]) -> Optional[tuple[list[int], list[str]]]:
    """필터 문자열 → 엔티티 id(link_query_entities 재사용). 하나라도 못 풀면 None
    (조건 누락된 잘못된 집계를 내느니 RAG 로 폴백)."""
    from app.ai import graph_link

    ids: list[int] = []
    labels: list[str] = []
    for term in filters:
        seeds = graph_link.link_query_entities(db, term, limit=1)
        if not seeds:
            return None
        ids.append(seeds[0]["id"])
        labels.append(seeds[0]["value"])
    return ids, labels


def _base_reports(db: Session, actor, ent_ids: list[int], year) -> set[int]:
    """가시성 ∩ 엔티티필터(rollup) ∩ 연도 = 집계 대상 보고서 id(소프트삭제 제외)."""
    scope = all_visible_report_ids(db, actor.user.id)
    base = set(scope) if scope is not None else None
    if ent_ids:
        f = entity_filter_report_ids(db, ent_ids, rollup=True)
        base = f if base is None else (base & f)
    if year is not None:
        y = report_ids_in_year(db, int(year))
        base = y if base is None else (base & y)
    if base is None:  # 필터·연도·스코프가 모두 무제한인 경우는 여기 안 온다(스코프는 항상 있음)
        return set()
    if not base:
        return set()
    # 소프트삭제 제외 + 유효 보고서만.
    rows = db.execute(
        select(Report.id).where(Report.id.in_(base), Report.deleted_at.is_(None))
    ).scalars().all()
    return set(rows)


def maybe_answer(db: Session, actor, query: str) -> Optional[dict]:
    """집계형이면 구조화 답변(dict), 아니면 None(→ 일반 RAG). 어떤 실패든 None 폴백."""
    if not _enabled():
        return None
    q = (query or "").strip()
    if not q or not _has_aggregate_cue(q):
        return None
    try:
        spec = _extract(db, q)
        if not spec or not spec.get("aggregate"):
            return None
        return _execute(db, actor, q, spec)
    except Exception:  # noqa: BLE001 — 구조화 실패는 조용히 RAG 폴백
        return None


def _enabled() -> bool:
    from app.modules.app_settings import store

    return bool(store.get("rag_aggregate_routing_enabled")) and (
        (settings.llm_backend or "mock").lower() != "mock"
    )


def aggregate(
    db: Session, actor, filters: list[str], year=None, target: str = "report"
) -> Optional[dict]:
    """온톨로지 집계 코어(답변 조립·에이전트 도구 공유). filters(문자열)를 엔티티로
    해석 → 가시성∩엔티티필터∩연도 = base 보고서 → target(보고서 또는 축) 개수/목록.

    반환 {count, unit, target_label, values(전체), report_ids(전체), filters(해석된 라벨),
    year}. 필터·타깃 해석 실패 시 None. 개수는 SQL 계산(환각 없음)·가시성 게이팅."""
    resolved = _resolve_filters(db, [str(x) for x in (filters or []) if str(x).strip()])
    if resolved is None:
        return None
    ent_ids, filter_labels = resolved
    try:
        year = int(year) if year is not None else None
    except (ValueError, TypeError):
        year = None
    base = _base_reports(db, actor, ent_ids, year)

    target_label, unit = "보고서", "건"
    if target and target != "report":
        types = {t.slug: t for t in list_types(db)}
        tt = types.get(target) or next(
            (t for t in types.values() if t.label == target), None
        )
        if tt is None:
            return None  # 타깃 축 해석 실패
        target_label, unit = tt.label, "개"
        values = list(db.execute(
            select(Entity.value)
            .join(ReportEntity, ReportEntity.entity_id == Entity.id)
            .where(
                ReportEntity.report_id.in_(base),
                Entity.type_id == tt.id,
                Entity.status == EntityStatus.active,
            ).distinct()
        ).scalars().all()) if base else []
        count = len(values)
    else:
        rep_rows = db.execute(
            select(Report.id, Report.title).where(Report.id.in_(base))
        ).all() if base else []
        values = [t or f"보고서 {rid}" for rid, t in rep_rows]
        count = len(base)

    return {
        "count": count, "unit": unit, "target_label": target_label,
        "values": values, "report_ids": list(base),
        "filters": filter_labels, "entity_ids": ent_ids, "year": year,
    }


def _resolve_target(db: Session, target: str):
    """target slug → EntityType. 'report'/빈값 → None(보고서). 축인데 못 찾으면 ValueError."""
    if not target or target == "report":
        return None
    types = {t.slug: t for t in list_types(db)}
    tt = types.get(target) or next((t for t in types.values() if t.label == target), None)
    if tt is None:
        raise ValueError(f"unknown axis: {target}")
    return tt


def _count_for(db: Session, report_ids, tt):
    """report_ids 의 (count, values). tt None → 보고서 수, 아니면 그 축 distinct 값 수."""
    if not report_ids:
        return 0, []
    if tt is None:
        return len(report_ids), []
    values = list(db.execute(
        select(Entity.value)
        .join(ReportEntity, ReportEntity.entity_id == Entity.id)
        .where(
            ReportEntity.report_id.in_(report_ids),
            Entity.type_id == tt.id,
            Entity.status == EntityStatus.active,
        ).distinct()
    ).scalars().all())
    return len(values), values


def aggregate_grouped(
    db: Session, actor, filters: list[str], year, target: str, group_by: str
) -> Optional[dict]:
    """차원(group_by='year' 또는 축 slug)으로 쪼갠 그룹별 집계(v2 group-by/compare).
    반환 {grouped, groups:[{label,count}], group_label, target_label, unit, ...}. 실패 시 None."""
    resolved = _resolve_filters(db, [str(x) for x in (filters or []) if str(x).strip()])
    if resolved is None:
        return None
    ent_ids, filter_labels = resolved
    try:
        year = int(year) if year is not None else None
    except (ValueError, TypeError):
        year = None
    base = _base_reports(db, actor, ent_ids, year)
    try:
        tt = _resolve_target(db, target)
    except ValueError:
        return None
    unit = "개" if tt else "건"
    target_label = tt.label if tt else "보고서"

    groups: dict[str, set[int]] = {}
    if group_by == "year":
        group_label = "연도"
        rows = db.execute(
            select(Report.id, Report.report_date).where(Report.id.in_(base))
        ).all() if base else []
        for rid, rdate in rows:
            groups.setdefault(str(rdate.year) if rdate else "미상", set()).add(rid)
    else:
        try:
            gt = _resolve_target(db, group_by)
        except ValueError:
            return None
        if gt is None:
            return None  # group_by='report' 는 무의미
        group_label = gt.label
        rows = db.execute(
            select(ReportEntity.report_id, Entity.value)
            .join(Entity, Entity.id == ReportEntity.entity_id)
            .where(
                ReportEntity.report_id.in_(base),
                Entity.type_id == gt.id,
                Entity.status == EntityStatus.active,
            )
        ).all() if base else []
        for rid, val in rows:
            groups.setdefault(val, set()).add(rid)

    out = [{"label": lbl, "count": _count_for(db, rids, tt)[0]}
           for lbl, rids in groups.items()]
    if group_by == "year":
        out.sort(key=lambda g: g["label"])
    else:
        out.sort(key=lambda g: g["count"], reverse=True)
    return {
        "grouped": True, "groups": out, "group_label": group_label,
        "target_label": target_label, "unit": unit,
        "filters": filter_labels, "entity_ids": ent_ids, "year": year,
        "report_ids": list(base),
    }


def _citations(db: Session, report_ids: list[int]) -> list[dict]:
    """근거 보고서 인용(상한). 집계 답변 공통."""
    cite_ids = list(report_ids)[:_MAX_CITATIONS]
    if not cite_ids:
        return []
    meta = {
        rid: (title, slug)
        for rid, title, slug in db.execute(
            select(Report.id, Report.title, Report.workspace_slug)
            .where(Report.id.in_(cite_ids))
        ).all()
    }
    out = []
    for i, rid in enumerate(cite_ids, start=1):
        title, slug = meta.get(rid, (None, None))
        out.append({"n": i, "report_id": rid, "title": title,
                    "workspace_slug": slug, "graph": True})
    return out


def _execute_grouped(db, actor, filters, spec, group_by) -> Optional[dict]:
    """group-by/compare(v2) — 차원별 그룹 집계 + 막대 렌더용 groups 반환."""
    agg = aggregate_grouped(
        db, actor, filters, spec.get("year"), spec.get("target") or "report", group_by
    )
    if agg is None:
        return None
    filter_labels = agg["filters"]
    year = agg["year"]
    groups = agg["groups"]
    tl, unit, glabel = agg["target_label"], agg["unit"], agg["group_label"]

    cond_parts = list(filter_labels)
    if year is not None:
        cond_parts.append(f"{year}년")
    cond = " · ".join(cond_parts) if cond_parts else "전체"

    if not groups:
        answer = f"조건({cond})에 해당하는 {tl}가 없습니다."
    else:
        lines = "\n".join(f"- {g['label']}: {g['count']}{unit}"
                          for g in groups[:_MAX_LIST_PREVIEW])
        answer = (f"조건({cond})에 해당하는 {tl}를 {glabel}별로 집계했습니다:\n{lines}"
                  "\n\n(볼 수 있는 보고서 기준.)")
    return {
        "answer": answer,
        "citations": _citations(db, agg["report_ids"]),
        "no_evidence": False,
        "seeds": [{"id": e, "value": lbl}
                  for e, lbl in zip(agg["entity_ids"], filter_labels)],
        "structured": True,
        "aggregate": {
            "intent": "group", "grouped": True, "group_label": glabel,
            "groups": groups, "target_label": tl, "unit": unit,
            "filters": filter_labels, "year": year,
        },
        "backend": "structured",
    }


def _execute(db: Session, actor, q: str, spec: dict) -> Optional[dict]:
    filters = [str(x) for x in (spec.get("filters") or []) if str(x).strip()]
    group_by = (spec.get("group_by") or "").strip()
    if group_by:
        return _execute_grouped(db, actor, filters, spec, group_by)
    agg = aggregate(db, actor, filters, spec.get("year"), spec.get("target") or "report")
    if agg is None:
        return None  # 해석 실패 → RAG

    ent_ids = agg["entity_ids"]
    filter_labels = agg["filters"]
    year = agg["year"]
    intent = "list" if spec.get("intent") == "list" else "count"
    target = spec.get("target") or "report"
    target_label, unit = agg["target_label"], agg["unit"]
    values, count = agg["values"], agg["count"]
    base = set(agg["report_ids"])

    # 조건 설명(투명성) — 필터·연도.
    cond_parts = list(filter_labels)
    if year is not None:
        cond_parts.append(f"{year}년")
    cond = " · ".join(cond_parts) if cond_parts else "전체"

    preview = values[:_MAX_LIST_PREVIEW]
    more = len(values) - len(preview)
    listing = ", ".join(preview) + (f" 외 {more}개" if more > 0 else "")
    if intent == "list" or (target != "report" and preview):
        body = f"조건({cond})에 해당하는 {target_label}는 {count}{unit}입니다."
        if preview:
            body += f" — {listing}"
    else:
        body = f"조건({cond})에 해당하는 {target_label}는 {count}{unit}입니다."
    answer = body + "\n\n(볼 수 있는 보고서 기준으로 집계했습니다.)"

    seeds = [
        {"id": eid, "value": lab}
        for eid, lab in zip(ent_ids, filter_labels)
    ]
    return {
        "answer": answer,
        "citations": _citations(db, list(base)),
        "no_evidence": False,
        "seeds": seeds,
        "structured": True,
        "aggregate": {
            "intent": intent,
            "count": count,
            "target_label": target_label,
            "unit": unit,
            "filters": filter_labels,
            "year": year,
        },
        "backend": "structured",
    }
