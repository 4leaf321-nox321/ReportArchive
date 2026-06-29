"""작업 큐 운영(관리자) 라우트 — 통계·헬스·재시도·취소·정리 + 권한 게이트.

시스템 관리자(user 2)만 접근, 비관리자(user 3)는 403. 잡을 직접 만들어
상태 전이(재시도/취소/정리)를 검증한다. 살아있는 워커가 테스트 잡을 집지
않도록, pending 이 필요한 케이스는 run_after 를 미래로 둔다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.jobs.models import (
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_PENDING,
    Job,
)
from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {"Authorization": f"Bearer {create_access_token(2)}"}
USER = {"Authorization": f"Bearer {create_access_token(3)}"}


def _mk_job(*, type: str, status: str, future: bool = False, old: bool = False) -> int:
    """테스트용 잡 1건 생성 후 id 반환. future=run_after 미래(워커 회피),
    old=updated_at 과거(정리 테스트용)."""
    db = SessionLocal()
    try:
        j = Job(type=type, payload={}, status=status, attempts=0, max_attempts=5)
        if future:
            j.run_after = datetime.now(timezone.utc) + timedelta(hours=1)
        db.add(j)
        db.commit()
        jid = j.id
        if old:
            db.query(Job).filter(Job.id == jid).update(
                {Job.updated_at: datetime.now(timezone.utc) - timedelta(days=30)}
            )
            db.commit()
        return jid
    finally:
        db.close()


def _drop_type(type: str) -> None:
    db = SessionLocal()
    try:
        db.query(Job).filter(Job.type == type).delete()
        db.commit()
    finally:
        db.close()


def _status(jid: int) -> str | None:
    db = SessionLocal()
    try:
        j = db.get(Job, jid)
        return j.status if j else None
    finally:
        db.close()


def test_admin_endpoints_require_system_admin():
    c = TestClient(app)
    # 비관리자(user 3) → 전부 403.
    assert c.get("/api/jobs/admin/stats", headers=USER).status_code == 403
    assert c.get("/api/jobs/admin/health", headers=USER).status_code == 403
    assert c.get("/api/jobs/admin", headers=USER).status_code == 403
    assert c.post("/api/jobs/admin/retry", headers=USER, json={}).status_code == 403
    assert c.post("/api/jobs/admin/1/cancel", headers=USER).status_code == 403


def test_stats_and_health_structure():
    c = TestClient(app)
    s = c.get("/api/jobs/admin/stats", headers=ADMIN)
    assert s.status_code == 200, s.text
    d = s.json()["data"]
    assert {"by_status", "by_type", "pending", "running", "failed", "done"} <= set(d)

    h = c.get("/api/jobs/admin/health", headers=ADMIN)
    assert h.status_code == 200, h.text
    hd = h.json()["data"]
    assert "worker" in hd and "llm" in hd
    assert {"alive", "count", "workers"} <= set(hd["worker"])


def test_list_filter_by_type():
    c = TestClient(app)
    t = f"test_admin_{uuid.uuid4().hex[:8]}"
    try:
        _mk_job(type=t, status=STATUS_FAILED)
        r = c.get("/api/jobs/admin", headers=ADMIN, params={"type": t})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["total"] == 1
        assert d["items"][0]["type"] == t
        assert d["items"][0]["status"] == STATUS_FAILED
    finally:
        _drop_type(t)


def test_retry_single_failed_to_pending():
    c = TestClient(app)
    t = f"test_admin_{uuid.uuid4().hex[:8]}"
    try:
        jid = _mk_job(type=t, status=STATUS_FAILED)
        r = c.post(f"/api/jobs/admin/{jid}/retry", headers=ADMIN)
        assert r.status_code == 200, r.text
        assert r.json()["data"]["status"] == STATUS_PENDING
        assert r.json()["data"]["attempts"] == 0
    finally:
        _drop_type(t)


def test_retry_rejects_non_terminal():
    c = TestClient(app)
    t = f"test_admin_{uuid.uuid4().hex[:8]}"
    try:
        # 미래 run_after 로 워커 회피한 pending 은 재시도 대상이 아님 → 409.
        jid = _mk_job(type=t, status=STATUS_PENDING, future=True)
        r = c.post(f"/api/jobs/admin/{jid}/retry", headers=ADMIN)
        assert r.status_code == 409, r.text
    finally:
        _drop_type(t)


def test_bulk_retry_by_type():
    c = TestClient(app)
    t = f"test_admin_{uuid.uuid4().hex[:8]}"
    try:
        _mk_job(type=t, status=STATUS_FAILED)
        _mk_job(type=t, status=STATUS_FAILED)
        r = c.post("/api/jobs/admin/retry", headers=ADMIN, json={"type": t})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["requeued"] == 2
    finally:
        _drop_type(t)


def test_cancel_pending():
    c = TestClient(app)
    t = f"test_admin_{uuid.uuid4().hex[:8]}"
    try:
        jid = _mk_job(type=t, status=STATUS_PENDING, future=True)
        r = c.post(f"/api/jobs/admin/{jid}/cancel", headers=ADMIN)
        assert r.status_code == 200, r.text
        assert _status(jid) == "canceled"
        # 이미 canceled → 다시 취소 시 409.
        r2 = c.post(f"/api/jobs/admin/{jid}/cancel", headers=ADMIN)
        assert r2.status_code == 409
    finally:
        _drop_type(t)


def test_purge_old_done():
    c = TestClient(app)
    t = f"test_admin_{uuid.uuid4().hex[:8]}"
    try:
        jid = _mk_job(type=t, status=STATUS_DONE, old=True)
        r = c.request(
            "DELETE",
            "/api/jobs/admin",
            headers=ADMIN,
            params={"status": STATUS_DONE, "older_than_days": 7},
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["purged"] >= 1
        assert _status(jid) is None  # 삭제됨
    finally:
        _drop_type(t)


def test_purge_rejects_pending():
    c = TestClient(app)
    r = c.request(
        "DELETE",
        "/api/jobs/admin",
        headers=ADMIN,
        params={"status": STATUS_PENDING},
    )
    assert r.status_code == 400, r.text
