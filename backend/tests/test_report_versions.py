"""보고서 수정 이력·되돌리기 — 생성 시 v1 시드, 저장 시 버전 누적, 비파괴 되돌리기.

실행: cd backend && ./venv/bin/python -m pytest tests/test_report_versions.py -v
(공유 Postgres, head=p38 마이그레이션 적용 상태 전제.)
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports import services
from app.modules.reports.models import Report, ReportVersion
from app.modules.reports.schemas import ReportUpdate


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _purge(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)  # report_versions 는 FK CASCADE
            db.commit()
    finally:
        db.close()


def _create(client, title):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]


def _versions(client, rid):
    r = client.get(f"/api/reports/{rid}/versions", headers=_h())
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _backdate_latest(rid, minutes):
    """세션 병합(10분)을 피하려고 최신 버전을 과거로."""
    db = SessionLocal()
    try:
        v = (
            db.execute(
                select(ReportVersion)
                .where(ReportVersion.report_id == rid)
                .order_by(ReportVersion.seq.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        v.created_at = datetime.utcnow() - timedelta(minutes=minutes)
        db.commit()
    finally:
        db.close()


def _service_update(rid, title):
    """API 잠금 절차 없이 본문 저장 — require_lock=False 로 서비스 직접 호출."""
    db = SessionLocal()
    try:
        rep = db.get(Report, rid)
        services.update_report(
            db, rep, ReportUpdate(title=title), updated_by_user_id=1, require_lock=False
        )
    finally:
        db.close()


def test_seed_history_and_nondestructive_restore():
    client = TestClient(app)
    res = _create(client, "버전테스트 원본")
    rid = res["id"]
    try:
        # 생성 시 v1 시드.
        v = _versions(client, rid)
        assert len(v) == 1
        seed_id = v[0]["id"]

        # 병합 회피 후 수정 저장 → 2개.
        _backdate_latest(rid, minutes=20)
        _service_update(rid, "버전테스트 수정본")
        v = _versions(client, rid)
        assert len(v) == 2

        # 옛 버전(원본) 본문 미리보기.
        detail = client.get(
            f"/api/reports/{rid}/versions/{seed_id}", headers=_h()
        ).json()["data"]
        assert "원본" in detail["body"]["title"]

        # 현재 보고서는 수정본.
        cur = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert "수정본" in cur["title"]

        # 원본으로 되돌리기 (라우트가 내부에서 잠금 점유/해제).
        r = client.post(
            f"/api/reports/{rid}/versions/{seed_id}/restore", headers=_h()
        )
        assert r.status_code == 200, r.text

        # 되돌려져 제목이 원본.
        cur = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert "원본" in cur["title"]

        # 비파괴: 수정본 버전이 이력에 남아 있고, restore 마커 버전이 생김.
        v2 = _versions(client, rid)
        assert len(v2) >= 3
        assert any(x["source"] == "restore" for x in v2)
        # 수정본 스냅샷이 여전히 존재(비파괴 확인).
        bodies = [
            client.get(
                f"/api/reports/{rid}/versions/{x['id']}", headers=_h()
            ).json()["data"]["body"]["title"]
            for x in v2
        ]
        assert any("수정본" in t for t in bodies)
    finally:
        _purge(rid)


def test_versions_require_read_permission():
    client = TestClient(app)
    res = _create(client, "버전권한 테스트")
    rid = res["id"]
    try:
        # 비멤버(다른 부서, 비공개 개인 보고서) → 403.
        from app.modules.users.models import Role
        from tests.test_report_search import _ensure_member  # 재사용

        other = _ensure_member("ver-other@test.local", "dev-hw", Role.user)
        r = client.get(
            f"/api/reports/{rid}/versions", headers=_h(other, "dev-hw")
        )
        assert r.status_code == 403, r.text
    finally:
        _purge(rid)
