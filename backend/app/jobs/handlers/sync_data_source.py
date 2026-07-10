"""외부 데이터소스 동기화 잡 핸들러 — v2 스케줄러/비동기 경로.

수동 "지금 동기화"는 라우트가 run_sync 를 동기 실행하지만, v2 범용 스케줄러는 due 한
소스를 이 잡으로 enqueue 한다. 실제 동기화 로직은 connectors.services.run_sync 재사용.

payload: { source_id: int }
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.jobs.registry import handler
from app.modules.connectors import services
from app.modules.connectors.models import DataSource


@handler("sync_data_source")
def sync_data_source(session: Session, payload: dict) -> dict:
    source_id = int(payload["source_id"])
    source = session.get(DataSource, source_id)
    if source is None:
        return {"source_id": source_id, "skipped": "not_found"}
    if not source.enabled:
        return {"source_id": source_id, "skipped": "disabled"}

    # 스케줄 실행 주체 = 소스 등록자(그의 권한으로 온톨로지에 쓴다).
    user_id = source.created_by_user_id
    if user_id is None:
        return {"source_id": source_id, "skipped": "no_owner"}

    result = services.run_sync(
        session, source, dry_run=False, triggered_by="schedule", user_id=user_id
    )
    return {"source_id": source_id, **(result.get("summary") or {})}
