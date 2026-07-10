"""커넥터 계보(provenance) — 동기화가 채운 객체의 출처 기록·조회.

(객체, 소스) 당 1행 upsert. "이 객체는 어느 소스가 언제 채웠나" 역추적용.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.modules.connectors.models import DataSource, EntityProvenance


def record_provenance(
    db: Session, *, entity_ids, data_source_id: int, sync_run_id: int | None
) -> None:
    """(객체, 소스) 계보 upsert — first_seen 은 최초에만, last_seen/last_run 은 매번 갱신."""
    ids = {e for e in entity_ids if e}
    if not ids:
        return
    now = datetime.now(timezone.utc)
    for eid in ids:
        stmt = (
            pg_insert(EntityProvenance)
            .values(
                entity_id=eid, data_source_id=data_source_id,
                last_sync_run_id=sync_run_id, first_seen=now, last_seen=now,
            )
            .on_conflict_do_update(
                constraint="uq_entity_provenance",
                set_={"last_seen": now, "last_sync_run_id": sync_run_id},
            )
        )
        db.execute(stmt)
    db.commit()


def list_provenance_for_entity(db: Session, entity_id: int) -> list[dict]:
    """이 객체를 채운 소스들(최근 순)."""
    rows = db.execute(
        select(EntityProvenance, DataSource.name)
        .join(DataSource, DataSource.id == EntityProvenance.data_source_id)
        .where(EntityProvenance.entity_id == entity_id)
        .order_by(EntityProvenance.last_seen.desc())
    ).all()
    return [
        {
            "data_source_id": p.data_source_id,
            "source_name": name,
            "last_sync_run_id": p.last_sync_run_id,
            "first_seen": p.first_seen.isoformat(),
            "last_seen": p.last_seen.isoformat(),
        }
        for p, name in rows
    ]


def count_objects_for_source(db: Session, data_source_id: int) -> int:
    """이 소스가 채운(태깅된) 객체 수."""
    return int(
        db.execute(
            select(func.count())
            .select_from(EntityProvenance)
            .where(EntityProvenance.data_source_id == data_source_id)
        ).scalar_one()
    )
