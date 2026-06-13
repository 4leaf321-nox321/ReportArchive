"""Dashboard aggregation — server-side compute of the per-workspace
dashboard (Phase 3A).

MVP aggregates in Python over the workspace's scoped reports (reusing
`list_reports_in_workspace` so visibility/permission matches the report
list exactly). The win over the old client path: the client no longer
downloads every report to compute these — it gets compact aggregates.
SQL GROUP BY / JSONB extraction is a noted follow-up (D5/D8) if this
gets slow on very large orgs; the response contract stays identical.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.comments import services as comment_services
from app.modules.folders import services as folder_services
from app.modules.reports import services as report_services
from app.modules.entities.models import EntityType
from app.modules.reports.models import ReportPhase
from app.modules.templates.models import Template
from app.modules.workspaces import services as ws_services
from app.modules.workspaces.models import Workspace, WorkspaceKind

# 며칠 이상 미수정 'drafting' 을 정체로 본다 — 프런트 STALE_DRAFT_DAYS 와 동일.
STALE_DRAFT_DAYS = 14
AUTHOR_TOP_N = 8
# 분포는 차원당 최대 N 개까지 내려주고(프런트가 기본 12개로 접고 '전체 보기'로
# 펼침), 그 이상은 잘림(total 로 표기). 교차표는 기본 8행/열, '전체 보기' 시 확대.
DIST_MAX = 100
CROSSTAB_TOP_N = 8
CROSSTAB_FULL_N = 40


def _template_name_map(db: Session) -> dict[str, str]:
    rows = db.execute(
        select(Template.template_id, Template.name).where(Template.is_latest.is_(True))
    ).all()
    return {tid: name for tid, name in rows}


# ── 보고서 1건에서 값 뽑기 ────────────────────────────────────────────────
def _effective_date(r) -> Optional[date]:
    """집계 기준일 — report_date 우선, 없으면 created_at 날짜(프런트 parseReportDate
    와 동일 규칙)."""
    if r.report_date:
        return r.report_date
    if r.created_at:
        return r.created_at.date()
    return None


def _template_ids(r) -> set[str]:
    """이 보고서의 대표 template_id. 대시보드는 본문(pages)을 로드하지 않으므로
    (defer_body) 멀티페이지 페이지별 템플릿이 아니라 top-level template_id 만
    쓴다 — 대시보드 지표로는 '이 보고서의 템플릿' 이 더 자연스럽고, pages JSONB
    를 안 건드려 성능에 유리."""
    return {r.template_id} if r.template_id else set()


# ── 시간 버킷 ────────────────────────────────────────────────────────────
def _week_key(d: date) -> tuple[str, str]:
    iso = d.isocalendar()  # (ISO year, ISO week, weekday)
    return f"{iso[0]}-W{iso[1]:02d}", f"W{iso[1]:02d}"


def _month_key(d: date) -> tuple[str, str]:
    return f"{d.year}-{d.month:02d}", f"{d.month}월"


def _year_key(d: date) -> tuple[str, str]:
    return str(d.year), f"{d.year}년"


def _enumerate_buckets(
    start: date, end: date, unit: str
) -> list[tuple[str, str]]:
    """start..end 구간의 (key, label) 버킷 목록 — 빈 버킷도 채워 연속 보장."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    if unit == "week":
        cur = start - timedelta(days=start.weekday())  # 그 주 월요일
        step = timedelta(days=7)
        while cur <= end:
            key, label = _week_key(cur)
            if key not in seen:
                seen.add(key)
                out.append((key, label))
            cur = cur + step
    elif unit == "year":
        for y in range(start.year, end.year + 1):
            out.append((str(y), f"{y}년"))
    else:  # month
        y, m = start.year, start.month
        while (y, m) <= (end.year, end.month):
            key, label = _month_key(date(y, m, 1))
            out.append((key, label))
            m += 1
            if m > 12:
                m = 1
                y += 1
    return out


def _bucket_key(d: date, unit: str) -> str:
    if unit == "week":
        return _week_key(d)[0]
    if unit == "year":
        return _year_key(d)[0]
    return _month_key(d)[0]


# ── KPI(총·작성자·템플릿) — 한 보고서 리스트에 대해 ──────────────────────
def _kpi_for(reports) -> dict:
    authors: set[int] = set()
    templates: set[str] = set()
    total = 0
    for r in reports:
        total += 1
        if r.owner_user_id is not None:
            authors.add(r.owner_user_id)
        templates |= _template_ids(r)
    return {"total": total, "authors": len(authors), "templates": len(templates)}


def _scope_slugs(db: Session, ws, is_global: bool, include_descendants: bool):
    """게시판(mount) 차원에서 셀/막대에 포함할 부서 슬러그 집합. None=무제한
    (가상/_global). 하위부서 포함이면 자손까지, 아니면 자기 부서만."""
    if is_global:
        return None
    if include_descendants:
        return set(ws_services.get_descendants_inclusive(db, ws.slug))
    return {ws.slug}


def _uncategorized_count(db: Session, ws: Workspace) -> int:
    if ws.kind == WorkspaceKind.personal:
        uid = ws.personal_owner_user_id
        return folder_services.count_uncategorized_personal(db, uid) if uid else 0
    if ws.kind == WorkspaceKind.org:
        return folder_services.count_uncategorized_org(db, ws.slug)
    return 0


def compute_dashboard(
    db: Session,
    *,
    actor,
    date_from: Optional[date],
    date_to: Optional[date],
    unit: str,
    include_descendants: bool = False,
) -> dict:
    """부서 대시보드 집계 묶음. 스코프=현재 부서(헤더). 가상(_global)은 무스코프.
    include_descendants=True 면 하위(자손) 부서 게시판까지 롤업."""
    ws = actor.workspace
    is_global = bool(getattr(ws, "virtual", False))
    reports = report_services.list_reports_in_workspace(
        db,
        ws.slug,
        is_global_view=is_global,
        include_descendants=include_descendants,
        defer_body=True,
    )

    # 기간 필터 — from/to 둘 다 있을 때만(없으면 전체).
    def in_window(r, lo: date, hi: date) -> bool:
        d = _effective_date(r)
        return d is not None and lo <= d <= hi

    if date_from and date_to:
        in_range = [r for r in reports if in_window(r, date_from, date_to)]
    else:
        in_range = list(reports)

    # KPI + 직전 동일 길이 기간 Δ
    kpis = _kpi_for(in_range)
    prev = None
    if date_from and date_to:
        span = date_to - date_from
        prev_to = date_from - timedelta(days=1)
        prev_from = prev_to - span
        prev = _kpi_for(
            [r for r in reports if in_window(r, prev_from, prev_to)]
        )
    kpis["prev"] = prev

    # 단계별
    phase = {"drafting": 0, "reviewing": 0, "finalized": 0}
    for r in in_range:
        key = r.phase.value if isinstance(r.phase, ReportPhase) else str(r.phase)
        if key in phase:
            phase[key] += 1

    # 추세 버킷
    trend: list[dict] = []
    dates = [d for d in (_effective_date(r) for r in in_range) if d]
    start = date_from or (min(dates) if dates else None)
    end = date_to or (max(dates) if dates else None)
    if start and end:
        counts: dict[str, int] = {}
        for d in dates:
            k = _bucket_key(d, unit)
            counts[k] = counts.get(k, 0) + 1
        for key, label in _enumerate_buckets(start, end, unit):
            trend.append({"key": key, "label": label, "count": counts.get(key, 0)})

    # 건강도 — 현재 상태 기준(기간 무관, 전체 보고서에서)
    stale_cutoff = datetime.utcnow() - timedelta(days=STALE_DRAFT_DAYS)
    stale = 0
    for r in reports:
        is_draft = (
            r.phase == ReportPhase.drafting
            if isinstance(r.phase, ReportPhase)
            else str(r.phase) == "drafting"
        )
        if is_draft and r.updated_at and r.updated_at < stale_cutoff:
            stale += 1
    open_comments = 0
    if not is_global:
        open_comments = comment_services.count_open_threads_for_reports(
            db, report_ids=[r.id for r in reports]
        )
    health = {
        "stale_drafts": stale,
        "uncategorized": 0 if is_global else _uncategorized_count(db, ws),
        "open_comments": open_comments,
    }

    # ── 분포(메타데이터 통계) — 차원별 보고서 수, 기간 내 ──────────────────
    # 콘텐츠 수치 대신 보고서 메타데이터로 통계. 차원 = 엔티티 축(모델·불량·
    # 개발단계…) + 종류 + 템플릿. 프런트는 드롭다운으로 차원을 골라 본다.
    total_in = len(in_range)
    distributions: list[dict] = []

    # 1) 엔티티 축별 — type 단위로 묶고 엔티티 id 빈도(드릴다운에 id 필요).
    axes: dict[int, dict] = {}
    for r in in_range:
        for e in getattr(r, "entities", None) or []:
            et = getattr(e, "entity_type", None)
            a = axes.setdefault(
                e.type_id,
                {
                    "slug": getattr(et, "slug", None) or str(e.type_id),
                    "label": getattr(et, "label", None) or str(e.type_id),
                    "byid": {},
                    "reports": set(),
                },
            )
            cur = a["byid"].setdefault(
                e.id,
                {"entity_id": e.id, "label": e.value or str(e.id), "count": 0},
            )
            cur["count"] += 1
            a["reports"].add(r.id)
    for a in sorted(axes.values(), key=lambda x: -sum(c["count"] for c in x["byid"].values())):
        items = sorted(a["byid"].values(), key=lambda x: -x["count"])[:DIST_MAX]
        distributions.append(
            {
                "key": f"entity:{a['slug']}",
                "label": a["label"],
                "items": items,
                "no_value": total_in - len(a["reports"]),
                "total": len(a["byid"]),
            }
        )

    # 2) 종류(report_type) — id 기준(드릴다운에 id 사용)
    rt: dict[int, dict] = {}
    rt_none = 0
    for r in in_range:
        rtobj = getattr(r, "report_type", None)
        rid = getattr(rtobj, "id", None)
        if rid is not None:
            cur = rt.setdefault(
                rid, {"report_type_id": rid, "label": rtobj.name, "count": 0}
            )
            cur["count"] += 1
        else:
            rt_none += 1
    if rt:
        distributions.append(
            {
                "key": "report_type",
                "label": "종류",
                "items": sorted(rt.values(), key=lambda x: -x["count"])[:DIST_MAX],
                "no_value": rt_none,
                "total": len(rt),
            }
        )

    # 3) 템플릿 — template_id 보관(드릴다운)
    tcount: dict[str, int] = {}
    for r in in_range:
        for tid in _template_ids(r):
            tcount[tid] = tcount.get(tid, 0) + 1
    if tcount:
        tmap = _template_name_map(db)
        distributions.append(
            {
                "key": "template",
                "label": "템플릿",
                "items": sorted(
                    (
                        {"template_id": tid, "label": tmap.get(tid, tid), "count": v}
                        for tid, v in tcount.items()
                    ),
                    key=lambda x: -x["count"],
                )[:DIST_MAX],
                "no_value": 0,
                "total": len(tcount),
            }
        )

    # 4) 게시판(mount) — 스코프 내 게시판별. 하위부서 포함일 때 특히 유용
    #    (게시판이 하나뿐이면 의미 없어 생략).
    scope = _scope_slugs(db, ws, is_global, include_descendants)
    bcount: dict[str, dict] = {}
    for r in in_range:
        seen_boards = set()
        for m in getattr(r, "mounts", None) or []:
            slug = m.workspace_slug
            if scope is not None and slug not in scope:
                continue
            if slug in seen_boards:
                continue
            seen_boards.add(slug)
            name = getattr(getattr(m, "workspace", None), "name", None) or slug
            cur = bcount.setdefault(
                slug, {"mount_slug": slug, "label": name, "count": 0}
            )
            cur["count"] += 1
    if len(bcount) > 1:
        distributions.append(
            {
                "key": "mount",
                "label": "게시판",
                "items": sorted(bcount.values(), key=lambda x: -x["count"])[
                    :DIST_MAX
                ],
                "no_value": 0,
                "total": len(bcount),
            }
        )

    # 작성자 Top — 기간 내
    auth_freq: dict[str, dict] = {}
    unknown = 0
    for r in in_range:
        uid = r.owner_user_id
        name = getattr(getattr(r, "owner", None), "name", None)
        if uid is None and not name:
            unknown += 1
            continue
        key = f"u:{uid}" if uid is not None else f"n:{name}"
        cur = auth_freq.setdefault(key, {"label": name or "(알 수 없음)", "count": 0})
        cur["count"] += 1
    auth_top = sorted(auth_freq.values(), key=lambda x: x["count"], reverse=True)[
        :AUTHOR_TOP_N
    ]
    author_top = {
        "top": auth_top,
        "distinct": len(auth_freq),
        "unknown": unknown,
    }

    return {
        "kpis": kpis,
        "phase_breakdown": phase,
        "trend": trend,
        "health": health,
        "distributions": distributions,
        "author_top": author_top,
        "content_metrics": [],
    }


# ── 교차표(두 차원) ──────────────────────────────────────────────────────
def _dim_values(dimkey: str, r, tmap: dict, scope=None) -> list[dict]:
    """보고서 r 의 차원 dimkey 값 목록 — 각 {key, label, <drill id>}. 멀티값
    (엔티티 다중태그·여러 게시판 게시)은 여러 개를 반환."""
    if dimkey == "mount":
        out = []
        seen = set()
        for m in getattr(r, "mounts", None) or []:
            slug = m.workspace_slug
            if scope is not None and slug not in scope:
                continue
            if slug in seen:
                continue
            seen.add(slug)
            name = getattr(getattr(m, "workspace", None), "name", None) or slug
            out.append({"key": f"m:{slug}", "label": name, "mount_slug": slug})
        return out
    if dimkey.startswith("entity:"):
        slug = dimkey.split(":", 1)[1]
        out = []
        for e in getattr(r, "entities", None) or []:
            et = getattr(e, "entity_type", None)
            if (getattr(et, "slug", None) or "") == slug:
                out.append(
                    {"key": f"e{e.id}", "label": e.value or str(e.id), "entity_id": e.id}
                )
        return out
    if dimkey == "report_type":
        rtobj = getattr(r, "report_type", None)
        rid = getattr(rtobj, "id", None)
        if rid is None:
            return []
        return [{"key": f"rt{rid}", "label": rtobj.name, "report_type_id": rid}]
    if dimkey == "template":
        return [
            {"key": f"t:{tid}", "label": tmap.get(tid, tid), "template_id": tid}
            for tid in _template_ids(r)
        ]
    return []


def _dim_label(dimkey: str, axis_labels: dict) -> str:
    if dimkey.startswith("entity:"):
        slug = dimkey.split(":", 1)[1]
        return axis_labels.get(slug, slug)
    if dimkey == "report_type":
        return "종류"
    if dimkey == "template":
        return "템플릿"
    if dimkey == "mount":
        return "게시판"
    return dimkey


def compute_crosstab(
    db: Session,
    *,
    actor,
    date_from: Optional[date],
    date_to: Optional[date],
    row: str,
    col: str,
    include_descendants: bool = False,
    top: int = CROSSTAB_TOP_N,
) -> dict:
    """두 차원 교차표. 행/열은 차원 키(entity:slug | report_type | template).
    한 보고서가 행·열 각각 여러 값을 가지면 그 조합 셀들에 모두 +1.
    top: 행/열로 보여줄 최대 개수('전체 보기' 시 확대)."""
    ws = actor.workspace
    is_global = bool(getattr(ws, "virtual", False))
    reports = report_services.list_reports_in_workspace(
        db,
        ws.slug,
        is_global_view=is_global,
        include_descendants=include_descendants,
        defer_body=True,
    )
    if date_from and date_to:
        in_range = [
            r
            for r in reports
            if (_effective_date(r) and date_from <= _effective_date(r) <= date_to)
        ]
    else:
        in_range = list(reports)

    tmap = _template_name_map(db)
    scope = _scope_slugs(db, ws, is_global, include_descendants)
    axis_labels = {
        slug: label
        for slug, label in db.execute(
            select(EntityType.slug, EntityType.label)
        ).all()
    }

    row_hdr: dict[str, dict] = {}
    col_hdr: dict[str, dict] = {}
    cells: dict[str, dict[str, int]] = {}
    row_tot: dict[str, int] = {}
    col_tot: dict[str, int] = {}
    for r in in_range:
        rv = _dim_values(row, r, tmap, scope)
        cv = _dim_values(col, r, tmap, scope)
        if not rv or not cv:
            continue
        for rh in rv:
            row_hdr.setdefault(rh["key"], rh)
            for ch in cv:
                col_hdr.setdefault(ch["key"], ch)
                cells.setdefault(rh["key"], {})
                cells[rh["key"]][ch["key"]] = cells[rh["key"]].get(ch["key"], 0) + 1
                row_tot[rh["key"]] = row_tot.get(rh["key"], 0) + 1
                col_tot[ch["key"]] = col_tot.get(ch["key"], 0) + 1

    # 행/열 상위 N 만(표가 너무 커지지 않게) — 건수순으로 N 개를 고른 뒤,
    # 게시판(mount) 차원은 상위부서가 왼쪽/위로 오도록 부서 트리 순서로 재정렬.
    top_rows = sorted(row_hdr.values(), key=lambda h: -row_tot.get(h["key"], 0))[
        :top
    ]
    top_cols = sorted(col_hdr.values(), key=lambda h: -col_tot.get(h["key"], 0))[
        :top
    ]

    def _order_by_tree(headers, dimkey):
        if dimkey != "mount":
            return headers
        # 부서 트리 순서(부모 먼저). get_descendants_inclusive 는 depth-first 라
        # 부모가 자식보다 앞선다 — 그 index 를 정렬 키로.
        order = {
            slug: i
            for i, slug in enumerate(
                ws_services.get_descendants_inclusive(db, ws.slug)
            )
        }
        return sorted(headers, key=lambda h: order.get(h.get("mount_slug"), 1 << 30))

    top_rows = _order_by_tree(top_rows, row)
    top_cols = _order_by_tree(top_cols, col)

    row_keys = {h["key"] for h in top_rows}
    col_keys = {h["key"] for h in top_cols}
    trimmed = {
        rk: {ck: v for ck, v in row.items() if ck in col_keys}
        for rk, row in cells.items()
        if rk in row_keys
    }
    return {
        "row_label": _dim_label(row, axis_labels),
        "col_label": _dim_label(col, axis_labels),
        "rows": top_rows,
        "cols": top_cols,
        "cells": trimmed,
        "row_total": len(row_hdr),
        "col_total": len(col_hdr),
    }
