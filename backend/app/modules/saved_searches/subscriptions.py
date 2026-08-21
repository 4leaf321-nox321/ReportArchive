"""저장검색 구독 감지 — 구독한 필터에 '새' 보고서가 걸리면 소유자에게 알림(#2).

스케줄러 tick(scripts/scheduler_tick.py)이 `run_subscription_checks` 를 인라인 호출한다
(알림 다이제스트와 같은 패턴 — 잡 큐를 거치지 않는 값싼 SQL). 각 구독 저장검색마다:
  ① 소유자 가시성 ∩ 저장된 필터(날짜/종류/작성자/단계/엔티티/연도) = 대상 집합
  ② 그중 created_at > seen_watermark 인 **새** 보고서(+ 저장된 검색어 부분일치)
  ③ 있으면 인앱 알림 생성(create_notification 이 이메일 opt-in 팬아웃까지 처리) →
     seen_watermark·last_notified_at 을 now 로 밀어 재알림 방지.
가시성은 항상 소유자 기준(all_visible_report_ids) — 남의 안 보이는 보고서는 새지 않는다.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.reports.models import Report
from app.modules.reports.services import (
    all_visible_report_ids,
    entity_filter_report_ids,
    filtered_report_ids,
    report_ids_in_year,
    resolve_date_range,
)
from app.modules.saved_searches.models import SavedSearch

_MAX_TITLES = 5  # 알림 payload 에 실을 새 보고서 제목 수


def _column_filters_from_saved(filters: dict) -> dict:
    """저장된 filters(dict) → report_column_conditions 인자. 날짜는 상대→절대 해석."""
    f = filters or {}
    try:
        last_days = int(f["lastDays"]) if f.get("lastDays") else None
    except (ValueError, TypeError):
        last_days = None

    def _d(v):
        try:
            return date.fromisoformat(v) if v else None
        except (ValueError, TypeError):
            return None

    d_from, d_to = resolve_date_range(
        date_from=_d(f.get("dateFrom")), date_to=_d(f.get("dateTo")),
        last_days=last_days, period=(f.get("period") or None),
    )
    cf: dict = {"date_field": f.get("dateField") or "report_date"}
    if d_from is not None or d_to is not None:
        cf["date_from"], cf["date_to"] = d_from, d_to
    for src, dst in (
        ("reportTypeIds", "report_type_ids"),
        ("authorIds", "author_ids"),
        ("editorIds", "editor_ids"),
        ("phases", "phases"),
        ("lifecycles", "lifecycles"),
        ("tags", "tags"),
    ):
        val = f.get(src)
        if val:
            cf[dst] = val
    return cf


def matching_report_ids(db: Session, owner_id: int, saved: SavedSearch) -> Optional[set[int]]:
    """저장검색에 걸리는 보고서 id 집합(가시성 ∩ 필터). None = 제한 없음.

    `matching_new_reports` 가 쓰던 ①~④ 를 그대로 떼어냈다 — **같은 필터 경로**를
    써야 "구독 알림에 걸린 것" 과 "지금 실행한 결과" 가 갈라지지 않는다.
    (저쪽은 여기에 watermark·검색어를 더한다.)"""
    f = saved.filters or {}
    scope = all_visible_report_ids(db, owner_id)
    base: Optional[set[int]] = set(scope) if scope is not None else None

    cf = filtered_report_ids(db, **_column_filters_from_saved(f))
    if cf is not None:
        base = cf if base is None else (base & cf)

    ent_ids = [int(x) for x in (f.get("entityIds") or [])]
    if ent_ids:
        ef = entity_filter_report_ids(db, ent_ids, rollup=bool(f.get("entityRollup")))
        base = ef if base is None else (base & ef)

    if f.get("year") is not None:
        try:
            yf = report_ids_in_year(db, int(f["year"]))
            base = yf if base is None else (base & yf)
        except (ValueError, TypeError):
            pass
    return base


def matching_new_reports(
    db: Session, owner_id: int, saved: SavedSearch
) -> list[tuple[int, str]]:
    """구독 저장검색에 걸리는 **새** 보고서 [(id, title)] — 소유자 가시성 ∩ 필터 ∩
    (created_at > seen_watermark). watermark 없으면 지금까지 전부는 알리지 않도록
    빈 목록(구독 켤 때 watermark 를 now 로 세팅하는 계약)."""
    if saved.seen_watermark is None:
        return []

    # ①~④ 가시성·컬럼·엔티티·연도 — 실행(run)과 **같은 경로**를 쓴다.
    base = matching_report_ids(db, owner_id, saved)

    if base is not None and not base:
        return []

    # ⑤ 새 것(watermark 이후) + 검색어 부분일치 + 삭제 제외 → 최종.
    # Report.created_at 은 naive-UTC(timestamp without tz)라, tz-aware 워터마크를
    # naive-UTC 로 맞춰 비교(세션 tz 에 좌우되지 않게).
    wm = saved.seen_watermark
    if wm.tzinfo is not None:
        wm = wm.astimezone(timezone.utc).replace(tzinfo=None)
    conds = [Report.deleted_at.is_(None), Report.created_at > wm]
    if base is not None:
        conds.append(Report.id.in_(base))
    for tok in (saved.query or "").split():
        conds.append(Report.search_text.ilike(f"%{tok}%"))
    rows = db.execute(
        select(Report.id, Report.title)
        .where(*conds)
        .order_by(Report.created_at.desc())
    ).all()
    return [(rid, title) for rid, title in rows]


def run_subscription_checks(db: Session) -> dict:
    """구독 저장검색을 훑어 새 보고서를 감지·알림. 반환 {checked, notified, new_total}."""
    subs = list(
        db.execute(
            select(SavedSearch).where(SavedSearch.subscribed.is_(True))
        ).scalars()
    )
    notified = 0
    new_total = 0
    now = datetime.now(timezone.utc)
    for s in subs:
        try:
            hits = matching_new_reports(db, s.user_id, s)
        except Exception:  # noqa: BLE001 — 한 구독 실패가 전체를 막지 않게
            db.rollback()
            continue
        if hits:
            titles = [t for _, t in hits[:_MAX_TITLES]]
            create_notification(
                db,
                recipient_user_id=s.user_id,
                type=NotificationType.saved_search_hit,
                ref_table="saved_searches",
                ref_id=s.id,
                payload={
                    "search_name": s.name,
                    "new_count": len(hits),
                    "titles": titles,
                    "report_ids": [rid for rid, _ in hits[:_MAX_TITLES]],
                },
            )
            s.last_notified_at = now
            notified += 1
            new_total += len(hits)
        # 워터마크는 항상 전진 — 매 tick 마다 '지금까지'를 소비(재알림 방지).
        s.seen_watermark = now
        db.commit()
    return {"checked": len(subs), "notified": notified, "new_total": new_total}
