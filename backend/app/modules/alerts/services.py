"""경보 서비스 — 프로브 레지스트리 + 발화/해소 diff 기계 (Phase D 1단계).

핵심 흐름(설계 §4):
  프로브가 "현재 걸리는 대상" 리스트 반환 → 직전 발화 상태와 diff →
  신규 진입=발화 / 이탈=해소 / 잔류=침묵. 재실행해도 중복 발화하지 않는다.

1단계는 수동 실행(run_rule)만. 주기 스캔·알림·이메일은 후속. 프로브는 명시적
화이트리스트(PROBES)로만 — 임의 SQL 금지.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.alerts.models import AlertRule, AlertRuleState

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
               Report.phase, Report.created_at)
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

    params: {days:int=30, mounted_only:bool=False}. phase != finalized(작성중·리뷰중)
    이면서 **마지막 수정 후 N일** 경과(=활동 없이 방치). updated_at 기준이라 지금도
    편집 중인 보고서엔 안 뜬다. 휴지통 제외. mounted_only 면 게시된 것만.
    """
    from app.modules.mounts.models import ReportMount  # noqa: F401 (via _boards_for)
    from app.modules.reports.models import Report, ReportPhase

    days = int(params.get("days", 30))
    mounted_only = bool(params.get("mounted_only", False))
    cutoff = datetime.utcnow() - timedelta(days=days)

    conds = [
        Report.deleted_at.is_(None),
        Report.phase != ReportPhase.finalized,
        Report.updated_at < cutoff,
    ]
    if mounted_only:
        conds.append(
            select(ReportMount.report_id)
            .where(ReportMount.report_id == Report.id)
            .exists()
        )

    stmt = (
        select(Report.id, Report.title, Report.workspace_slug,
               Report.phase, Report.created_at, Report.updated_at)
        .where(*conds)
        .order_by(Report.updated_at.asc())
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
                "phase": r.phase.value if r.phase else None,
                "boards": boards.get(r.id, []),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
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


def update_rule(db: Session, rule: AlertRule, *, enabled=None, params=None) -> AlertRule:
    """프론트 조정 — enabled 토글, params(days·finalized_only) 병합."""
    if enabled is not None:
        rule.enabled = bool(enabled)
    if params is not None:
        merged = dict(rule.params or {})
        merged.update(params)
        rule.params = merged
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


def run_rule(db: Session, rule: AlertRule) -> dict:
    """규칙 1회 실행 — 프로브 → 직전 상태와 diff → 발화/해소 반영.
    RunResult 형태의 dict 반환. 비활성 규칙은 평가하지 않는다(발화 0)."""
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
        else:
            if s.state != "firing":  # resolved 였다가 다시 걸림 = 재발화
                s.state = "firing"
                s.first_fired_at = now
                fired += 1
            s.context = t["context"]
            s.last_seen_at = now

    # 이탈 — 직전 firing 인데 이번 매칭에 없으면 해소.
    for key, s in prev.items():
        if key not in new_by_key and s.state == "firing":
            s.state = "resolved"
            s.last_seen_at = now
            resolved += 1

    db.commit()

    return {
        "checked": len(targets),
        "fired": fired,
        "resolved": resolved,
        "firing": firing_count(db, rule.id),
        "capped": capped,
    }
