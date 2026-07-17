"""경보 서비스 — 프로브 레지스트리 + 발화/해소 diff 기계 (Phase D 1단계).

핵심 흐름(설계 §4):
  프로브가 "현재 걸리는 대상" 리스트 반환 → 직전 발화 상태와 diff →
  신규 진입=발화 / 이탈=해소 / 잔류=침묵. 재실행해도 중복 발화하지 않는다.

주기 스캔(jobs/scheduler.py)·인앱 알림(_notify_new_firings)·이메일 다이제스트
(alerts/digest.py)·작성자 통보(_notify_owners)까지 구현됨 — run_rule 수동 실행은
그 중 하나일 뿐이다. 잔여는 `[일부] Phase D_경보_설계.md` 참조. 프로브는 명시적
화이트리스트(PROBES)로만 — 임의 SQL 금지.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Callable, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.alerts.models import AlertRule, AlertRuleState

logger = logging.getLogger(__name__)

# 프로브가 한 번에 반환하는 대상 상한(폭주 방지). 초과 시 잘리고 capped=True.
_PROBE_LIMIT = 500


# --------------------------------------------------------------------------- #
# 프로브 — 조건을 코드로 꽂는 자리. 각 프로브는 db+params 를 받아
# [{target_type, target_id, context}] 리스트를 반환한다.
# --------------------------------------------------------------------------- #
def _boards_for(db: Session, ids: list[int]) -> dict[int, list[str]]:
    """report_id → [게시된 조직 게시판 부서명]. Report.workspace_slug 는 작성자의
    개인 워크스페이스라 위치 안내가 안 됨 → 실제 게시된 게시판을 배치 조회한다."""
    from app.modules.mounts.models import ReportMount
    from app.modules.workspaces.models import Workspace

    out: dict[int, list[str]] = {}
    if not ids:
        return out
    rows = db.execute(
        select(ReportMount.report_id, Workspace.name)
        .join(Workspace, Workspace.slug == ReportMount.workspace_slug)
        .where(ReportMount.report_id.in_(ids))
    ).all()
    for rid, wname in rows:
        out.setdefault(rid, []).append(wname)
    return out


def _probe_untagged_reports(db: Session, params: dict) -> list[dict]:
    """미태깅 보고서 — 엔티티 태그가 0개인 보고서 중 생성 후 N일 경과.

    params: {days:int=7, mounted_only:bool=True}. mounted_only 면 게시판에 게시된
    (mount 된) 보고서만 — 개인 공간에만 있는 보고서는 아직 태그 없어도 온톨로지
    거버넌스 대상이 아니라 제외. 휴지통(deleted_at) 제외.

    ⚠️ phase(finalized) 로 거르지 않는다 — 게시(mount)는 phase 를 reviewing 으로
    만들 뿐 finalized 는 별도라, finalized_only 로 걸면 게시된 보고서 대부분을
    놓친다(관측: DX 부문 게시 ~894건 중 finalized 11건뿐). 공유 여부의 기준은
    phase 가 아니라 "게시판에 올라갔는가".
    """
    # 순환 import 회피 — reports/entities 서비스가 이 계층을 참조할 수 있어 지연 import.
    from app.modules.entities.models import ReportEntity
    from app.modules.mounts.models import ReportMount
    from app.modules.reports.models import Report

    days = int(params.get("days", 7))
    # 하위호환: 옛 finalized_only 값이 남아 있어도 mounted_only 기본 True 로 동작.
    mounted_only = bool(params.get("mounted_only", True))
    cutoff = datetime.utcnow() - timedelta(days=days)

    no_tag = ~(
        select(ReportEntity.report_id)
        .where(ReportEntity.report_id == Report.id)
        .exists()
    )
    conds = [Report.deleted_at.is_(None), Report.created_at < cutoff, no_tag]
    if mounted_only:
        conds.append(
            select(ReportMount.report_id)
            .where(ReportMount.report_id == Report.id)
            .exists()
        )

    stmt = (
        select(Report.id, Report.title, Report.workspace_slug,
               Report.owner_user_id, Report.phase, Report.created_at)
        .where(*conds)
        .order_by(Report.created_at.asc())
        .limit(_PROBE_LIMIT + 1)  # +1 로 잘림 감지
    )
    rows = db.execute(stmt).all()
    boards = _boards_for(db, [r.id for r in rows])

    return [
        {
            "target_type": "report",
            "target_id": str(r.id),
            "context": {
                "title": r.title,
                # 링크용 — 보고서 소유 워크스페이스(/w/{slug}/reports/{id}).
                "workspace_slug": r.workspace_slug,
                # 작성자 통보(3c)용 — owner 는 자기 보고서를 항상 봄(가시성 안전).
                "owner_user_id": r.owner_user_id,
                "phase": r.phase.value if r.phase else None,
                # 표시용 — 실제 게시된 조직 게시판(없으면 미게시).
                "boards": boards.get(r.id, []),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            },
        }
        for r in rows
    ]


def _probe_stale_unpublished(db: Session, params: dict) -> list[dict]:
    """미발행 보고서 — 발행(finalized)되지 않은 채 오래 방치된 보고서.

    params: {days:int=30, mounted_only:bool=True}. phase != finalized(작성중·리뷰중)
    이면서 **사람이 마지막으로 편집한 지 N일** 경과(=활동 없이 방치). 방치 기준은
    last_edited_at(실제 편집 시각, 구 보고서는 NULL → created_at 폴백)을 쓴다.
    ⚠️ Report.updated_at 을 쓰면 안 된다 — onupdate=utcnow 라 search_text 재색인·
    마이그레이션 등 사람이 아닌 저장에도 갱신돼, 그걸 기준 삼으면 게시된 리뷰중
    보고서가 통째로 방치 판정에서 빠진다(운영 관측). 휴지통 제외. mounted_only
    (기본 True) 면 게시된(mount 된) 보고서만 — 개인 공간 미게시 보고서는 제외
    (미태깅 프로브와 동일 기본값). 개인 초안까지 보려면 규칙에서 mounted_only=false.
    """
    from app.modules.mounts.models import ReportMount  # noqa: F401 (via _boards_for)
    from app.modules.reports.models import Report, ReportPhase

    days = int(params.get("days", 30))
    mounted_only = bool(params.get("mounted_only", True))
    cutoff = datetime.utcnow() - timedelta(days=days)

    # 방치 기준 = 사람이 마지막으로 손댄 시각. last_edited_at(실제 편집)을 우선하고,
    # 편집 이력이 없는(구·미편집) 보고서는 created_at 으로 폴백. updated_at 은 비-사람
    # 저장에도 튀어(§docstring) 방치 판정을 리셋하므로 쓰지 않는다.
    last_touch = func.coalesce(Report.last_edited_at, Report.created_at)

    conds = [
        Report.deleted_at.is_(None),
        Report.phase != ReportPhase.finalized,
        last_touch < cutoff,
    ]
    if mounted_only:
        conds.append(
            select(ReportMount.report_id)
            .where(ReportMount.report_id == Report.id)
            .exists()
        )

    stmt = (
        select(Report.id, Report.title, Report.workspace_slug,
               Report.owner_user_id, Report.phase, Report.created_at,
               Report.updated_at, Report.last_edited_at)
        .where(*conds)
        .order_by(last_touch.asc())
        .limit(_PROBE_LIMIT + 1)
    )
    rows = db.execute(stmt).all()
    boards = _boards_for(db, [r.id for r in rows])

    return [
        {
            "target_type": "report",
            "target_id": str(r.id),
            "context": {
                "title": r.title,
                "workspace_slug": r.workspace_slug,
                "owner_user_id": r.owner_user_id,
                "phase": r.phase.value if r.phase else None,
                "boards": boards.get(r.id, []),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                "last_edited_at": (
                    r.last_edited_at.isoformat() if r.last_edited_at else None
                ),
                # 방치 판정에 실제로 쓴 기준시각(편집 없으면 생성) — 표시용.
                "stale_since": (
                    (r.last_edited_at or r.created_at).isoformat()
                    if (r.last_edited_at or r.created_at) else None
                ),
            },
        }
        for r in rows
    ]


PROBES: dict[str, Callable[[Session, dict], list[dict]]] = {
    "untagged_reports": _probe_untagged_reports,
    "stale_unpublished": _probe_stale_unpublished,
}


# --------------------------------------------------------------------------- #
# 순수 diff — 테스트 결정적. 발화 기계의 심장.
# --------------------------------------------------------------------------- #
def diff_keys(prev_firing: set, current: set) -> dict:
    """직전 발화 키 집합 vs 이번 매칭 키 집합.
    new=새로 발화 / gone=해소 / kept=계속(침묵)."""
    return {
        "new": current - prev_firing,
        "gone": prev_firing - current,
        "kept": current & prev_firing,
    }


# --------------------------------------------------------------------------- #
# 규칙 CRUD (읽기 + 조정 가능한 값 PATCH)
# --------------------------------------------------------------------------- #
def get_rule(db: Session, rule_id: int) -> Optional[AlertRule]:
    return db.get(AlertRule, rule_id)


def list_rules(db: Session) -> list[AlertRule]:
    return list(db.execute(select(AlertRule).order_by(AlertRule.id)).scalars())


def firing_count(db: Session, rule_id: int) -> int:
    return int(
        db.execute(
            select(func.count())
            .select_from(AlertRuleState)
            .where(AlertRuleState.rule_id == rule_id,
                   AlertRuleState.state == "firing")
        ).scalar_one()
    )


def update_rule(
    db: Session,
    rule: AlertRule,
    *,
    enabled=None,
    params=None,
    schedule_kind=None,
    interval_minutes=None,
    notify_owner=None,
) -> AlertRule:
    """프론트 조정 — enabled 토글, params 병합, 스케줄·작성자 통보 설정."""
    if enabled is not None:
        rule.enabled = bool(enabled)
    if notify_owner is not None:
        rule.notify_owner = bool(notify_owner)
    if params is not None:
        merged = dict(rule.params or {})
        merged.update(params)
        rule.params = merged
    if schedule_kind is not None:
        rule.schedule_kind = schedule_kind
        # 자동 실행으로 켜는데 다음 실행 시각이 없으면 즉시 due 로(첫 실행 바로).
        if schedule_kind in ("interval", "weekly", "monthly") and rule.next_run_at is None:
            rule.next_run_at = datetime.utcnow()
    if interval_minutes is not None:
        rule.interval_minutes = int(interval_minutes)
    db.commit()
    db.refresh(rule)
    return rule


def list_firing(
    db: Session, rule_id: int, *, limit: int = 50, offset: int = 0
) -> list[AlertRuleState]:
    stmt = (
        select(AlertRuleState)
        .where(AlertRuleState.rule_id == rule_id, AlertRuleState.state == "firing")
        .order_by(AlertRuleState.first_fired_at.asc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 200)))
    )
    return list(db.execute(stmt).scalars())


# --------------------------------------------------------------------------- #
# 평가 + 발화 (수동 실행)
# --------------------------------------------------------------------------- #
def evaluate_rule(db: Session, rule: AlertRule) -> list[dict]:
    """규칙의 프로브를 실행해 현재 매칭 대상 리스트를 반환. 미등록 프로브는 빈 리스트."""
    probe = PROBES.get(rule.probe_key)
    if probe is None:
        return []
    return probe(db, rule.params or {})


def _notify_new_firings(db: Session, rule: AlertRule, fired: int, firing_total: int,
                        actor_user_id) -> None:
    """새 발화(신규 진입)가 있으면 시스템 관리자에게 인앱 알림(요약) 1건씩.
    이메일 팬아웃은 create_notification 내부에서 옵트인 사용자에게 자동 처리.
    새로 걸린 것만 알리므로 기존 백로그·반복 실행으로 스팸 나지 않는다(diff)."""
    if fired <= 0:
        return
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification
    from app.modules.users.models import User

    admins = list(
        db.execute(select(User.id).where(User.is_system_admin.is_(True))).scalars()
    )
    payload = {
        "rule_name": rule.name,
        "fired": fired,
        "firing": firing_total,
        "probe_key": rule.probe_key,
        # NotificationRow 가 읽는 표시 필드(제목=규칙명, 요약=건수).
        "report_title": rule.name,
        "excerpt": f"새로 감지 {fired}건 · 현재 {firing_total}건",
    }
    for uid in admins:
        create_notification(
            db,
            recipient_user_id=uid,
            type=NotificationType.alert_firing,
            ref_table="alert_rules",
            ref_id=rule.id,
            actor_user_id=actor_user_id,
            payload=payload,
        )


# 실행 1회당 작성자 알림 상한 — 파라미터 급변으로 대량 발화 시 사용자 폭주 방지.
_OWNER_NOTIFY_CAP = 100

_OWNER_MESSAGES = {
    "untagged_reports": "이 보고서에 엔티티 태그가 없습니다. 태그를 추가해 주세요.",
    "stale_unpublished": "오래 미발행 상태인 보고서입니다. 발행하거나 정리해 주세요.",
}


def _notify_owners(db: Session, rule: AlertRule, newly_fired: list[dict],
                   actor_user_id) -> None:
    """새로 발화한 보고서의 작성자(owner)에게 인앱 알림 (규칙별 옵트인 notify_owner).
    owner 는 자기 보고서를 항상 볼 수 있어 가시성 게이트 불필요. ref_table='reports'
    라 알림 클릭 시 기존 딥링크가 그 보고서로 보낸다(새 프론트 렌더 불필요).
    폭주 방지: 한 실행에 상한 초과면 통째로 생략(설정 급변 방어)."""
    reports = [
        t for t in newly_fired
        if t["target_type"] == "report" and t["context"].get("owner_user_id")
    ]
    if not reports:
        return
    if len(reports) > _OWNER_NOTIFY_CAP:
        logger.warning(
            "alert rule %s: 새 발화 %d건 > 상한 %d — 작성자 알림 생략",
            rule.id, len(reports), _OWNER_NOTIFY_CAP,
        )
        return
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification

    msg = _OWNER_MESSAGES.get(rule.probe_key, "경보 대상 보고서입니다. 확인해 주세요.")
    for t in reports:
        ctx = t["context"]
        try:
            rid = int(t["target_id"])
        except (TypeError, ValueError):
            continue
        create_notification(
            db,
            recipient_user_id=ctx["owner_user_id"],
            type=NotificationType.alert_firing,
            ref_table="reports",
            ref_id=rid,
            workspace_slug=ctx.get("workspace_slug"),
            actor_user_id=actor_user_id,
            payload={
                "report_title": ctx.get("title"),
                "excerpt": msg,
                "rule_name": rule.name,
            },
        )


def run_rule(db: Session, rule: AlertRule, *, actor_user_id=None) -> dict:
    """규칙 1회 실행 — 프로브 → 직전 상태와 diff → 발화/해소 반영.
    RunResult 형태의 dict 반환. 비활성 규칙은 평가하지 않는다(발화 0).
    새 발화가 있으면 관리자에게 알림(actor 는 self-skip — 수동 실행자 본인 제외)."""
    now = datetime.utcnow()

    targets = evaluate_rule(db, rule) if rule.enabled else []
    capped = len(targets) > _PROBE_LIMIT
    if capped:
        targets = targets[:_PROBE_LIMIT]

    new_by_key = {(t["target_type"], t["target_id"]): t for t in targets}
    prev = {
        (s.target_type, s.target_id): s
        for s in db.execute(
            select(AlertRuleState).where(AlertRuleState.rule_id == rule.id)
        ).scalars()
    }

    fired = 0
    resolved = 0
    newly_fired: list[dict] = []  # 이번에 새로 발화(신규 진입·재발화)한 대상 — 작성자 통보용

    # 이번 매칭 — 신규 진입은 발화, 잔류는 last_seen 갱신(침묵).
    for key, t in new_by_key.items():
        s = prev.get(key)
        if s is None:
            db.add(
                AlertRuleState(
                    rule_id=rule.id,
                    target_type=key[0],
                    target_id=key[1],
                    state="firing",
                    context=t["context"],
                    first_fired_at=now,
                    last_seen_at=now,
                )
            )
            fired += 1
            newly_fired.append(t)
        else:
            if s.state != "firing":  # resolved 였다가 다시 걸림 = 재발화
                s.state = "firing"
                s.first_fired_at = now
                fired += 1
                newly_fired.append(t)
            s.context = t["context"]
            s.last_seen_at = now

    # 이탈 — 직전 firing 인데 이번 매칭에 없으면 해소.
    for key, s in prev.items():
        if key not in new_by_key and s.state == "firing":
            s.state = "resolved"
            s.last_seen_at = now
            resolved += 1

    rule.last_run_at = now
    rule.last_status = "ok"
    db.flush()  # 방금 add/변경한 발화 상태를 반영해야 카운트가 맞다(autoflush off 대비).
    firing_total = firing_count(db, rule.id)
    _notify_new_firings(db, rule, fired, firing_total, actor_user_id)
    if rule.notify_owner:  # 규칙별 옵트인(기본 off) — 새 발화 보고서 작성자에게도.
        _notify_owners(db, rule, newly_fired, actor_user_id)
    db.commit()

    return {
        "checked": len(targets),
        "fired": fired,
        "resolved": resolved,
        "firing": firing_total,
        "capped": capped,
    }
