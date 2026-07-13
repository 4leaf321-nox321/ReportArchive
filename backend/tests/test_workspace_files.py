"""부서 스코프 파일 관리 — 목록·재배정·일괄삭제(조직개편·계정삭제_설계.md 후속).

files.workspace_slug=RESTRICT 라 부서에 파일이 남으면 삭제가 막힌다. 이 화면으로
이관/삭제해 정리한다. dev DB 직결(다른 통합 테스트와 동일).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.files.models import File
from app.modules.users.models import User
from app.modules.workspaces.models import Workspace

client = TestClient(app)

SRC = "wf-src"
DST = "wf-dst"


def _hdr(uid: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _admin_id() -> int:
    db = SessionLocal()
    try:
        return db.execute(
            select(User.id).where(User.is_system_admin.is_(True))
        ).scalar()
    finally:
        db.close()


def _purge() -> None:
    db = SessionLocal()
    try:
        for s in (SRC, DST):
            db.query(File).filter_by(workspace_slug=s).delete()
            w = db.get(Workspace, s)
            if w:
                db.delete(w)
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def setup():
    admin = _admin_id()
    _purge()
    h = _hdr(admin)
    client.post("/api/workspaces", json={"slug": SRC, "name": "파일원본"}, headers=h)
    client.post("/api/workspaces", json={"slug": DST, "name": "파일대상"}, headers=h)
    db = SessionLocal()
    try:
        db.add(
            File(
                id="wf-a",
                filename="a.png",
                mime_type="image/png",
                size=100,
                storage_path="202607/wf-a.png",
                owner_user_id=admin,
                workspace_slug=SRC,
            )
        )
        db.add(
            File(
                id="wf-b",
                filename="b.pdf",
                mime_type="application/pdf",
                size=200,
                storage_path="202607/wf-b.pdf",
                owner_user_id=admin,
                workspace_slug=SRC,
            )
        )
        db.commit()
    finally:
        db.close()
    yield admin
    _purge()


def test_list_workspace_files_shape(setup):
    res = client.get(f"/api/files/workspace/{SRC}", headers=_hdr(setup))
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["total_count"] == 2
    assert data["total_size"] == 300
    item = data["items"][0]
    for k in ("id", "referenced_live", "referenced_any", "reference_count", "references"):
        assert k in item
    # 참조하는 보고서를 안 만들었으므로 미참조.
    assert item["referenced_live"] is False


def test_reassign_moves_files(setup):
    res = client.post(
        "/api/files/reassign",
        json={"file_ids": ["wf-b"], "target_slug": DST},
        headers=_hdr(setup),
    )
    assert res.status_code == 200, res.text
    assert res.json()["data"]["reassigned"] == 1
    src = client.get(f"/api/files/workspace/{SRC}", headers=_hdr(setup)).json()["data"]
    dst = client.get(f"/api/files/workspace/{DST}", headers=_hdr(setup)).json()["data"]
    assert src["total_count"] == 1
    assert dst["total_count"] == 1


def test_reassign_bad_target_400(setup):
    res = client.post(
        "/api/files/reassign",
        json={"file_ids": ["wf-a"], "target_slug": "does-not-exist"},
        headers=_hdr(setup),
    )
    assert res.status_code == 400, res.text


def test_bulk_delete_clears_files(setup):
    res = client.post(
        "/api/files/bulk-delete",
        json={"file_ids": ["wf-a", "wf-b"]},
        headers=_hdr(setup),
    )
    assert res.status_code == 200, res.text
    assert res.json()["data"]["deleted"] == 2
    left = client.get(f"/api/files/workspace/{SRC}", headers=_hdr(setup)).json()["data"]
    assert left["total_count"] == 0
    # 파일이 비면 부서 삭제 가능해야 한다(RESTRICT 해제).
    dep = client.get(f"/api/workspaces/{SRC}/dependents", headers=_hdr(setup)).json()[
        "data"
    ]
    assert dep["files"] == 0


def test_requires_system_admin(setup):
    # 비관리자(새 일반 계정)로는 403.
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email="wf_plain@wf.test").one_or_none()
        if u is None:
            u = User(email="wf_plain@wf.test", name="wf", password_hash="!x")
            db.add(u)
            db.commit()
        uid = u.id
    finally:
        db.close()
    res = client.get(f"/api/files/workspace/{SRC}", headers=_hdr(uid))
    assert res.status_code == 403, res.text
