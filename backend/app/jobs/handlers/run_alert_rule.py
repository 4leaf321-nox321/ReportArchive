"""경보 규칙 실행 잡 핸들러 (Phase D 2단계).

스케줄러 tick 이 due 규칙을 이 잡으로 enqueue 한다. 실제 평가(프로브 → 발화/해소
diff)는 alerts.services.run_rule 재사용 — 수동 "지금 실행" 라우트와 같은 경로.

payload: { rule_id: int }
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.jobs.registry import handler


@handler("run_alert_rule")
def run_alert_rule(session: Session, payload: dict) -> dict:
    from app.modules.alerts import services

    rule_id = int(payload["rule_id"])
    rule = services.get_rule(session, rule_id)
    if rule is None:
        return {"rule_id": rule_id, "skipped": "not_found"}
    if not rule.enabled:
        return {"rule_id": rule_id, "skipped": "disabled"}

    result = services.run_rule(session, rule)  # last_run_at·last_status 갱신 포함
    return {"rule_id": rule_id, **result}
