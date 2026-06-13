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
from app.modules.reports.models import ReportPhase
from app.modules.templates.models import Template
from app.modules.workspaces.models import Workspace, WorkspaceKind

# 며칠 이상 미수정 'drafting' 을 정체로 본다 — 프런트 STALE_DRAFT_DAYS 와 동일.
STALE_DRAFT_DAYS = 14
AUTHOR_TOP_N = 8
DIST_TOP_N = 12  # 분포 차원당 상위 N 값


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
    """이 보고서가 쓰는 distinct template_id(멀티페이지는 페이지별까지)."""
    out: set[str] = set()
    pages = r.pages if isinstance(r.pages, list) else []
    if not pages:
        if r.template_id:
            out.add(r.template_id)
        return out
    for p in pages:
        if isinstance(p, dict) and p.get("template_id"):
            out.add(p["template_id"])
    return out


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
) -> dict:
    """부서 대시보드 집계 묶음. 스코프=현재 부서(헤더). 가상(_global)은 무스코프."""
    ws = actor.workspace
    is_global = bool(getattr(ws, "virtual", False))
    reports = report_services.list_reports_in_workspace(
        db, ws.slug, is_global_view=is_global
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

    # 1) 엔티티 축별 — type 단위로 묶고 value 빈도.
    axes: dict[int, dict] = {}
    for r in in_range:
        for e in getattr(r, "entities", None) or []:
            et = getattr(e, "entity_type", None)
            a = axes.setdefault(
                e.type_id,
                {
                    "slug": getattr(et, "slug", None) or str(e.type_id),
                    "label": getattr(et, "label", None) or str(e.type_id),
                    "values": {},
                    "reports": set(),
                },
            )
            a["values"][e.value] = a["values"].get(e.value, 0) + 1
            a["reports"].add(r.id)
    for a in sorted(axes.values(), key=lambda x: -sum(x["values"].values())):
        items = sorted(
            ({"label": k or "(빈값)", "count": v} for k, v in a["values"].items()),
            key=lambda x: -x["count"],
        )[:DIST_TOP_N]
        distributions.append(
            {
                "key": f"entity:{a['slug']}",
                "label": a["label"],
                "items": items,
                "no_value": total_in - len(a["reports"]),
            }
        )

    # 2) 종류(report_type)
    rt: dict[str, int] = {}
    rt_none = 0
    for r in in_range:
        name = getattr(getattr(r, "report_type", None), "name", None)
        if name:
            rt[name] = rt.get(name, 0) + 1
        else:
            rt_none += 1
    if rt:
        distributions.append(
            {
                "key": "report_type",
                "label": "종류",
                "items": sorted(
                    ({"label": k, "count": v} for k, v in rt.items()),
                    key=lambda x: -x["count"],
                )[:DIST_TOP_N],
                "no_value": rt_none,
            }
        )

    # 3) 템플릿
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
                        {"label": tmap.get(tid, tid), "count": v}
                        for tid, v in tcount.items()
                    ),
                    key=lambda x: -x["count"],
                )[:DIST_TOP_N],
                "no_value": 0,
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
