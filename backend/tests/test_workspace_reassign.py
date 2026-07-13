"""부서 임베드 번들 정리 + 부서 이관/병합(D5) — 조직개편·계정삭제_설계.md 후속.

- 임베드 번들: 부서 스코프 목록·이관·일괄삭제(files 와 대칭).
- 이관/병합: src 콘텐츠(보고서·번들·멤버 등)를 target 으로 통째 이관해 src 를 비운다.
dev DB 직결.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.embed.models import HtmlEmbedBundle
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace

client = TestClient(app)

SRC = "rz-src"
DST = "rz-dst"


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
            db.query(HtmlEmbedBundle).filter_by(workspace_slug=s).delete()
            db.query(WorkspaceMember).filter_by(workspace_slug=s).delete()
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
    client.post("/api/workspaces", json={"slug": SRC, "name": "원본"}, headers=h)
    client.post("/api/workspaces", json={"slug": DST, "name": "대상"}, headers=h)
    db = SessionLocal()
    try:
        db.add(
            HtmlEmbedBundle(
                id="rzb1",
                entry_path="index.html",
                file_count=1,
                total_bytes=50,
                owner_user_id=admin,
                workspace_slug=SRC,
            )
        )
        db.add(WorkspaceMember(user_id=admin, workspace_slug=SRC, role=Role.user))
        db.commit()
    finally:
        db.close()
    yield admin
    _purge()


# ── 임베드 번들 정리 ──────────────────────────────────────────────────────
def test_list_workspace_bundles(setup):
    res = client.get(f"/api/embed/workspace/{SRC}", headers=_hdr(setup))
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["total_count"] == 1
    item = data["items"][0]
    for k in ("id", "entry_path", "referenced_live", "referenced_any", "references"):
        assert k in item


def test_reassign_bundle_and_bad_target(setup):
    ok = client.post(
        "/api/embed/reassign",
        json={"bundle_ids": ["rzb1"], "target_slug": DST},
        headers=_hdr(setup),
    )
    assert ok.status_code == 200, ok.text
    assert (
        client.get(f"/api/embed/workspace/{DST}", headers=_hdr(setup)).json()["data"][
            "total_count"
        ]
        == 1
    )
    bad = client.post(
        "/api/embed/reassign",
        json={"bundle_ids": ["rzb1"], "target_slug": "nope"},
        headers=_hdr(setup),
    )
    assert bad.status_code == 400, bad.text


def test_bulk_delete_bundles(setup):
    res = client.post(
        "/api/embed/bulk-delete",
        json={"bundle_ids": ["rzb1"]},
        headers=_hdr(setup),
    )
    assert res.status_code == 200, res.text
    assert res.json()["data"]["deleted"] == 1
    left = client.get(f"/api/embed/workspace/{SRC}", headers=_hdr(setup)).json()["data"]
    assert left["total_count"] == 0


def test_embed_admin_requires_system_admin(setup):
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email="rz_plain@rz.test").one_or_none()
        if u is None:
            u = User(email="rz_plain@rz.test", name="rz", password_hash="!x")
            db.add(u)
            db.commit()
        uid = u.id
    finally:
        db.close()
    res = client.get(f"/api/embed/workspace/{SRC}", headers=_hdr(uid))
    assert res.status_code == 403, res.text


# ── 부서 이관/병합 ────────────────────────────────────────────────────────
def test_merge_moves_contents_and_empties_source(setup):
    # src 에 번들·멤버가 있어 삭제가 막힌다 → 병합 후 blocker 0.
    pre = client.get(f"/api/workspaces/{SRC}/dependents", headers=_hdr(setup)).json()[
        "data"
    ]
    assert pre["html_embed_bundles"] == 1 and pre["members"] == 1

    res = client.post(
        f"/api/workspaces/{SRC}/reassign-contents",
        json={"target_slug": DST, "kinds": ["embeds", "members"]},
        headers=_hdr(setup),
    )
    assert res.status_code == 200, res.text
    moved = res.json()["data"]["moved"]
    assert moved["embeds"] == 1 and moved["members"] == 1

    post = client.get(f"/api/workspaces/{SRC}/dependents", headers=_hdr(setup)).json()[
        "data"
    ]
    assert post["html_embed_bundles"] == 0 and post["members"] == 0
    # DST 가 인계받음.
    assert (
        client.get(f"/api/embed/workspace/{DST}", headers=_hdr(setup)).json()["data"][
            "total_count"
        ]
        == 1
    )


def test_merge_rejects_bad_or_same_target(setup):
    same = client.post(
        f"/api/workspaces/{SRC}/reassign-contents",
        json={"target_slug": SRC, "kinds": ["reports"]},
        headers=_hdr(setup),
    )
    assert same.status_code == 400, same.text
    bad = client.post(
        f"/api/workspaces/{SRC}/reassign-contents",
        json={"target_slug": "nope", "kinds": ["reports"]},
        headers=_hdr(setup),
    )
    assert bad.status_code == 400, bad.text
