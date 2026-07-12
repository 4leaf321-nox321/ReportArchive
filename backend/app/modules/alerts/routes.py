"""경보 라우트 — /api/alerts. 전부 시스템 관리자 전용 (Phase D 1단계).

  GET   /rules              → 규칙 목록(각 규칙의 현재 발화 수 포함)
  PATCH /rules/{id}         → 조정(enabled, params: days·finalized_only)
  POST  /rules/{id}/run     → 수동 실행(프로브 평가 + 발화/해소) → 요약
  GET   /rules/{id}/firing  → 현재 발화 목록(인박스)

1단계는 수동 실행만 — 워커·알림·이메일 없음. 프로브 쿼리가 도는 run 은 동기 def
핸들러로 둬 FastAPI 가 스레드풀에서 실행(이벤트 루프 블로킹 방지).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.alerts import services
from app.modules.alerts.schemas import (
    AlertRuleListResponse,
    AlertRuleRead,
    AlertRuleUpdate,
    FiringItem,
    FiringListResponse,
    RunResult,
)
from app.modules.users.models import User
from app.shared.auth import require_system_admin
from app.shared.responses import not_found_response, success_response

router = APIRouter()


def _to_read(db: Session, rule) -> AlertRuleRead:
    return AlertRuleRead(
        id=rule.id,
        name=rule.name,
        enabled=rule.enabled,
        probe_key=rule.probe_key,
        params=rule.params or {},
        severity=rule.severity,
        schedule_kind=rule.schedule_kind,
        interval_minutes=rule.interval_minutes,
        next_run_at=rule.next_run_at,
        last_run_at=rule.last_run_at,
        last_status=rule.last_status,
        firing_count=services.firing_count(db, rule.id),
    )


@router.get("/rules")
def list_rules(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    items = [_to_read(db, r) for r in services.list_rules(db)]
    return success_response(data=AlertRuleListResponse(items=items).model_dump())


@router.patch("/rules/{rule_id}")
def update_rule(
    rule_id: int,
    payload: AlertRuleUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    rule = services.get_rule(db, rule_id)
    if rule is None:
        return not_found_response("규칙을 찾을 수 없습니다.")
    patch = payload.model_dump(exclude_unset=True)
    rule = services.update_rule(
        db, rule,
        enabled=patch.get("enabled"),
        params=patch.get("params"),
        schedule_kind=patch.get("schedule_kind"),
        interval_minutes=patch.get("interval_minutes"),
    )
    return success_response(data=_to_read(db, rule).model_dump())


@router.post("/rules/{rule_id}/run")
def run_rule(
    rule_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    rule = services.get_rule(db, rule_id)
    if rule is None:
        return not_found_response("규칙을 찾을 수 없습니다.")
    result = services.run_rule(db, rule)
    return success_response(data=RunResult(**result).model_dump())


@router.get("/rules/{rule_id}/firing")
def list_firing(
    rule_id: int,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    rule = services.get_rule(db, rule_id)
    if rule is None:
        return not_found_response("규칙을 찾을 수 없습니다.")
    total = services.firing_count(db, rule_id)
    items = [
        FiringItem(
            target_type=s.target_type,
            target_id=s.target_id,
            context=s.context or {},
            first_fired_at=s.first_fired_at,
            last_seen_at=s.last_seen_at,
        )
        for s in services.list_firing(db, rule_id, limit=limit, offset=offset)
    ]
    return success_response(
        data=FiringListResponse(items=items, total=total).model_dump()
    )
