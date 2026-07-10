"""주기 스케줄러 tick — due 한 interval 소스만 sync 잡으로 적재 + dedup.

- interval 소스가 due(next_run 과거)면 sync_data_source 잡 1건 적재 + next_run 미룸.
- manual 소스·비활성 소스·미래 next_run 소스는 적재 안 함.
- 이미 대기 중 잡이 있으면(dedup) 재적재 안 함(skipped).
서비스/스케줄러 직접(세션) — 워커 불필요. 끝나면 정리.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import select

from app.database import SessionLocal
from app.jobs.models import Job
from app.jobs.scheduler import run_scheduler_tick
from app.modules.connectors import services as conn
from app.modules.connectors.models import DataSource
from app.modules.connectors.schemas import DataSourceCreate

_CFG = {
    "connection": {"base_url": "http://x.test"},
    "streams": [{"endpoint_path": "/a", "target_type_id": 1, "value_path": "name"}],
}


def _mk(db, name, *, schedule_kind, interval, enabled=True):
    return conn.create_source(
        db,
        DataSourceCreate(
            name=name, kind="rest_json", enabled=enabled, config=_CFG,
            schedule_kind=schedule_kind, interval_minutes=interval,
        ),
        user_id=2,
    )


def _jobs_for(db, source_id):
    return list(
        db.scalars(
            select(Job).where(
                Job.type == "sync_data_source",
                Job.dedup_key == f"sync-source-{source_id}",
            )
        ).all()
    )


def test_scheduler_enqueues_due_and_dedups():
    db = SessionLocal()
    sfx = uuid.uuid4().hex[:8]
    src = man = dis = None
    made_job_ids = []
    try:
        src = _mk(db, "sch-int-" + sfx, schedule_kind="interval", interval=60)
        man = _mk(db, "sch-man-" + sfx, schedule_kind="manual", interval=None)
        dis = _mk(db, "sch-dis-" + sfx, schedule_kind="interval", interval=60, enabled=False)

        # src·dis 를 due 로(과거). man 은 manual 이라 next_run 없음.
        past = datetime.utcnow() - timedelta(minutes=5)
        src.next_run_at = past
        dis.next_run_at = past
        db.commit()

        # tick — src 만 적재(man=manual, dis=비활성 제외).
        r = run_scheduler_tick(db)
        assert r["enqueued"] == 1, r
        jobs = _jobs_for(db, src.id)
        assert len(jobs) == 1 and jobs[0].payload.get("source_id") == src.id, jobs
        made_job_ids = [j.id for j in jobs]
        assert _jobs_for(db, man.id) == [] and _jobs_for(db, dis.id) == []

        # next_run 이 미래로 밀렸다.
        db.refresh(src)
        assert src.next_run_at > datetime.utcnow(), src.next_run_at

        # dedup: 다시 due 로 만들어도 대기 중 잡이 있으니 재적재 안 함(skipped).
        src.next_run_at = past
        db.commit()
        r2 = run_scheduler_tick(db)
        assert r2["enqueued"] == 0 and r2["skipped"] == 1, r2
        assert len(_jobs_for(db, src.id)) == 1  # 여전히 1건
    finally:
        for jid in made_job_ids:
            j = db.get(Job, jid)
            if j:
                db.delete(j)
        db.commit()
        for s in (src, man, dis):
            if s:
                obj = db.get(DataSource, s.id)
                if obj:
                    conn.delete_source(db, obj)
        db.close()
