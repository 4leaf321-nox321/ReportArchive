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

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ai.llm import chat
from app.config import settings
from app.modules.entities.models import Entity, EntityStatus, ReportEntity
from app.modules.entities.services import list_types
from app.modules.reports.models import Report
from app.modules.reports.services import (
    all_visible_report_ids,
    entity_filter_report_ids,
    filtered_report_ids,
    report_ids_in_year,
    resolve_date_range,
)

# 집계 신호어 — 없으면 LLM 도 안 부르고 바로 RAG.
# 집계형(개수/목록/비교) + (B) 필터형(날짜·작성자) 신호어. 후자는 "최근 일주일 작성
# 보고서"처럼 개수/목록 단어가 없어도 필터-기반 나열 의도를 잡아 라우팅한다.
_CUES = (
    "몇", "개수", "몇개", "건", "얼마나", "목록", "리스트", "총", "각각",
    "비교", "통계", "count", "list", "how many",
    # 날짜/상대기간
    "최근", "지난", "이번 주", "이번주", "저번 주", "저번주", "이번 달", "이번달",
    "요즘", "오늘", "어제", "이번 분기", "올해", "작년",
    # 작성자/단계
    "작성한", "작성된", "작성자", "누가", "내가 쓴", "작성 중", "작성중", "발행",
)
_MAX_LIST_PREVIEW = 30   # 답변 문장에 나열할 값 상한(사람이 읽는 텍스트)
_LIST_FULL_CAP = 500     # aggregate.values 로 UI 에 넘겨 "더 보기"로 펼칠 상한
_MAX_CITATIONS = 10      # 근거로 첨부할 보고서 상한

_EXTRACT_SYSTEM = (
    "너는 사내 보고서 아카이브의 질의 분석기다. 사용자 질문이 '집계형'(개수/목록/"
    "비교)인지 판별하고, 그렇다면 구조화 파라미터를 뽑아라. 출력은 JSON 하나만.\n"
    '형식: {"aggregate": true|false, "intent": "count"|"list", '
    '"target": "report" 또는 아래 타입 slug 중 하나, '
    '"filters": ["조건값", ...], "year": 정수 또는 null, '
    '"group_by": null 또는 "year" 또는 축 slug, '
    '"date": {"last_days": 정수 또는 null, "period": null 또는 '
    '"today"|"yesterday"|"this_week"|"this_month"|"this_year", '
    '"from": "YYYY-MM-DD" 또는 null, "to": "YYYY-MM-DD" 또는 null}, '
    '"report_type": 문자열 또는 null, "author": 문자열 또는 null, '
    '"phase": null 또는 "drafting"|"reviewing"|"finalized", '
    '"lifecycle": null 또는 "single_shot"|"ongoing"}\n'
    "- aggregate=false 면 나머지는 무시된다(단순 조회/설명 질문).\n"
    "- '최근 보고서·지난주·이번 달 작성' 같은 날짜/작성자 조건의 나열도 aggregate=true, "
    "intent='list' 로 본다.\n"
    "- target: 무엇을 세거나 나열하나. 보고서면 \"report\", 특정 축(과제·부품 등)의 "
    "값을 세면 그 축의 slug.\n"
    "- filters: 조건이 되는 값들(예: 시험종류·결과·모델명). 질문에 나온 표현 그대로. "
    "**날짜·작성자·단계는 여기 넣지 말고 아래 전용 필드로.**\n"
    "- year: 특정 연도 조건(없으면 null).\n"
    "- date: 상대/명시 날짜 범위. '최근 일주일/7일'→last_days=7, '지난달'은 "
    "period='this_month' 아님 주의(지난달은 from/to 로). 조건 없으면 모두 null.\n"
    "- report_type: 보고서 종류(예: '주간보고','안전점검') 조건, 없으면 null.\n"
    "- author: 작성자 사람 이름(예: '김철수','내가'→null 로 두지 말고 이름), 없으면 null.\n"
    "- phase: 협업 단계(작성중=drafting/리뷰중=reviewing/발행완료=finalized), 없으면 null.\n"
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


def _iso_date(v):
    """'YYYY-MM-DD' → date, 아니면 None(방어)."""
    from datetime import date as _date

    if not v or not isinstance(v, str):
        return None
    try:
        return _date.fromisoformat(v.strip())
    except ValueError:
        return None


def _resolve_report_type(db: Session, name: str) -> Optional[int]:
    """종류 이름 → report_type_id. 완전일치 우선, 없으면 부분일치 1건."""
    from app.modules.report_types.models import ReportType

    n = name.strip()
    if not n:
        return None
    row = db.execute(
        select(ReportType.id).where(func.lower(ReportType.name) == n.lower())
    ).scalars().first()
    if row is None:
        row = db.execute(
            select(ReportType.id).where(ReportType.name.ilike(f"%{n}%")).limit(1)
        ).scalars().first()
    return row


def _resolve_author(db: Session, name: str) -> Optional[int]:
    """작성자 이름 → user id. 완전일치 우선, 없으면 부분일치 1건(활성 우선)."""
    from app.modules.users.models import User

    n = name.strip()
    if not n:
        return None
    row = db.execute(
        select(User.id).where(func.lower(User.name) == n.lower())
        .order_by(User.is_active.desc())
    ).scalars().first()
    if row is None:
        row = db.execute(
            select(User.id).where(User.name.ilike(f"%{n}%"))
            .order_by(User.is_active.desc()).limit(1)
        ).scalars().first()
    return row


def _resolve_board(db: Session, name: str) -> Optional[str]:
    """게시판(조직) 이름 또는 slug → workspace slug.

    AI 는 "dx", "선행개발", "HW개발팀" 처럼 사람 말로 준다. slug 정확일치 → 이름
    정확일치 → 이름 부분일치 1건 순. **개인공간(personal)은 후보에서 제외** — 남의
    개인공간을 이름으로 찍어 조회하려는 시도를 막고, "조직"의 의미도 게시판이다."""
    from app.modules.workspaces.models import Workspace, WorkspaceKind

    n = (name or "").strip()
    if not n:
        return None
    base = select(Workspace.slug).where(
        Workspace.kind != WorkspaceKind.personal
    )
    row = db.execute(
        base.where(func.lower(Workspace.slug) == n.lower())
    ).scalars().first()
    if row is None:
        row = db.execute(
            base.where(func.lower(Workspace.name) == n.lower())
        ).scalars().first()
    if row is None:
        row = db.execute(
            base.where(Workspace.name.ilike(f"%{n}%")).limit(1)
        ).scalars().first()
    return row


def _resolve_folder_ids(
    db: Session, name: str, board_slugs: Optional[list[str]] = None
) -> list[int]:
    """폴더 이름(또는 숫자 id) → folder id 목록. org 폴더만.

    이름은 게시판마다 겹칠 수 있으므로(모든 게시판에 '진행 중'이 있다) board 가
    주어지면 그 게시판(들)으로 한정한다. board 가 없으면 이름이 같은 폴더를 전부
    돌려준다 — 필터가 OR 라 "여러 부서의 '진행 중'"이라는 자연스러운 해석이 된다."""
    from app.modules.folders.models import Folder, FolderKind

    n = (name or "").strip()
    if not n:
        return []
    if n.isdigit():
        return [int(n)]
    q = select(Folder.id).where(Folder.kind == FolderKind.org)
    if board_slugs:
        q = q.where(Folder.workspace_slug.in_(board_slugs))
    rows = db.execute(
        q.where(func.lower(Folder.name) == n.lower())
    ).scalars().all()
    if not rows:
        rows = db.execute(
            q.where(Folder.name.ilike(f"%{n}%")).limit(20)
        ).scalars().all()
    return [int(r) for r in rows]


def _resolve_org_author_ids(db: Session, name: str) -> list[int]:
    """부서 이름/slug → 그 부서(및 하위) 소속 사용자 id 목록.

    "특정 조직의 글"의 두 번째 해석 — *그 조직 사람이 쓴* 글(게시 여부 무관).
    기본 해석인 board(게시된 곳)와 달리 작성자 축이라 author_ids 로 환원된다."""
    from app.modules.users.models import WorkspaceMember
    from app.modules.workspaces import services as ws_services

    slug = _resolve_board(db, name)
    if not slug:
        return []
    scope = ws_services.get_descendants_inclusive(db, slug)
    rows = db.execute(
        select(WorkspaceMember.user_id).where(
            WorkspaceMember.workspace_slug.in_(scope)
        )
    ).scalars().all()
    return sorted({int(r) for r in rows})


def _resolve_column_filters(db: Session, spec: dict) -> Optional[dict]:
    """LLM spec 의 (B) 날짜·종류·작성자·단계·진행상태 → report_column_conditions
    인자 dict. 아무 필터도 없으면 None. 종류/작성자는 이름→id 로 해석하고, 못 풀면
    그 필터만 조용히 생략(전체로 새지 않게 나머지 조건은 유지)."""
    cf: dict = {}
    date = spec.get("date")
    if isinstance(date, dict):
        try:
            last_days = int(date["last_days"]) if date.get("last_days") else None
        except (ValueError, TypeError):
            last_days = None
        d_from, d_to = resolve_date_range(
            date_from=_iso_date(date.get("from")), date_to=_iso_date(date.get("to")),
            last_days=last_days, period=(date.get("period") or None),
        )
        if d_from is not None or d_to is not None:
            cf["date_from"], cf["date_to"] = d_from, d_to
    rt = spec.get("report_type")
    if isinstance(rt, str) and rt.strip():
        tid = _resolve_report_type(db, rt)
        if tid is not None:
            cf["report_type_ids"] = [tid]
    au = spec.get("author")
    if isinstance(au, str) and au.strip():
        uid = _resolve_author(db, au)
        if uid is not None:
            cf["author_ids"] = [uid]
    if spec.get("phase") in ("drafting", "reviewing", "finalized"):
        cf["phases"] = [spec["phase"]]
    if spec.get("lifecycle") in ("single_shot", "ongoing"):
        cf["lifecycles"] = [spec["lifecycle"]]
    return cf or None


def _base_reports(
    db: Session, actor, ent_ids: list[int], year, column_filters: Optional[dict] = None
) -> set[int]:
    """가시성 ∩ 엔티티필터(rollup) ∩ 연도 ∩ (B)컬럼필터 = 집계 대상 보고서 id
    (소프트삭제 제외). column_filters=날짜/종류/작성자/단계 등(filtered_report_ids)."""
    scope = all_visible_report_ids(db, actor.user.id)
    base = set(scope) if scope is not None else None
    if ent_ids:
        f = entity_filter_report_ids(db, ent_ids, rollup=True)
        base = f if base is None else (base & f)
    if year is not None:
        y = report_ids_in_year(db, int(year))
        base = y if base is None else (base & y)
    if column_filters:
        c = filtered_report_ids(db, **column_filters)
        if c is not None:
            base = c if base is None else (base & c)
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
    db: Session, actor, filters: list[str], year=None, target: str = "report",
    column_filters: Optional[dict] = None,
) -> Optional[dict]:
    """온톨로지 집계 코어(답변 조립·에이전트 도구 공유). filters(문자열)를 엔티티로
    해석 → 가시성∩엔티티필터∩연도∩(B)컬럼필터 = base 보고서 → target(보고서 또는
    축) 개수/목록. column_filters=날짜/종류/작성자/단계(filtered_report_ids 인자).

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
    base = _base_reports(db, actor, ent_ids, year, column_filters)

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
    db: Session, actor, filters: list[str], year, target: str, group_by: str,
    column_filters: Optional[dict] = None,
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
    base = _base_reports(db, actor, ent_ids, year, column_filters)
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


_PHASE_KO = {"drafting": "작성중", "reviewing": "리뷰중", "finalized": "발행완료"}
_LIFE_KO = {"single_shot": "단발", "ongoing": "진행중"}
_PERIOD_KO = {
    "today": "오늘", "yesterday": "어제", "this_week": "이번 주",
    "this_month": "이번 달", "this_year": "올해",
}


def _column_cond_labels(spec: dict, cf: Optional[dict]) -> list[str]:
    """(B) 컬럼 필터를 조건 설명 문자열로(투명성). 실제 적용된(cf 에 들어간) 것만."""
    if not cf:
        return []
    labels: list[str] = []
    date = spec.get("date") if isinstance(spec.get("date"), dict) else {}
    if "date_from" in cf:
        if date.get("last_days"):
            labels.append(f"최근 {int(date['last_days'])}일")
        elif date.get("period") in _PERIOD_KO:
            labels.append(_PERIOD_KO[date["period"]])
        else:
            df, dt = cf.get("date_from"), cf.get("date_to")
            labels.append(f"{df or '~'}~{dt or ''}".rstrip("~") or "날짜범위")
    if cf.get("report_type_ids") and isinstance(spec.get("report_type"), str):
        labels.append(f"종류:{spec['report_type'].strip()}")
    if cf.get("author_ids") and isinstance(spec.get("author"), str):
        labels.append(f"작성자:{spec['author'].strip()}")
    for p in cf.get("phases", []):
        labels.append(_PHASE_KO.get(p, p))
    for lc in cf.get("lifecycles", []):
        labels.append(_LIFE_KO.get(lc, lc))
    return labels


def _execute_grouped(db, actor, filters, spec, group_by) -> Optional[dict]:
    """group-by/compare(v2) — 차원별 그룹 집계 + 막대 렌더용 groups 반환."""
    cf = _resolve_column_filters(db, spec)
    agg = aggregate_grouped(
        db, actor, filters, spec.get("year"), spec.get("target") or "report",
        group_by, column_filters=cf,
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
    cond_parts.extend(_column_cond_labels(spec, cf))
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
    cf = _resolve_column_filters(db, spec)
    agg = aggregate(
        db, actor, filters, spec.get("year"), spec.get("target") or "report",
        column_filters=cf,
    )
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

    # 조건 설명(투명성) — 엔티티필터·연도 + (B)날짜/종류/작성자/단계.
    cond_parts = list(filter_labels)
    if year is not None:
        cond_parts.append(f"{year}년")
    cond_parts.extend(_column_cond_labels(spec, cf))
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
            # 답변 문장은 30개까지만 나열하지만, UI 가 "더 보기"로 펼칠 수 있게
            # 전체 목록(상한)과 총계를 함께 넘긴다 — 코어가 이미 full 을 계산했으므로
            # 재쿼리 없음(_MAX_LIST_PREVIEW 로 잘려 뒤를 못 보던 것 해소).
            "values": values[:_LIST_FULL_CAP],
            "values_total": len(values),
        },
        "backend": "structured",
    }
