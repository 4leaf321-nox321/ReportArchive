"""B300 보조 AI 접근 제어(엔티틀먼트, §E) — 해석 로직 + CRUD 엔드포인트.

기본 deny, 직접 유저 grant, 와일드카드('all'), 워크스페이스 grant + 조상
include_descendants, 관리자 우회(bypass), 그리고 sysadmin 전용 CRUD 게이트.

실행 전제: 공유 Postgres 가 head(p57)까지 마이그레이션.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.ai import entitlements as ent
from app.ai.entitlements import ALL_FEATURES, ai_features_for
from app.ai.models import AiEntitlement, AiFeature, AiSubjectKind
from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace

ADMIN = 2  # conftest: system admin
USER = 3   # conftest: non-admin


def _grant(db, **kw):
    e = AiEntitlement(**kw)
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def test_deny_by_default_and_direct_user_grant():
    db = SessionLocal()
    created = []
    try:
        user = db.get(User, USER)
        # 기본 deny — 비관리자, grant 없음.
        assert ai_features_for(db, user) == set()
        # 직접 유저 grant.
        created.append(
            _grant(
                db,
                feature=AiFeature.rag_qa,
                subject_kind=AiSubjectKind.user,
                user_id=USER,
            )
        )
        assert "rag_qa" in ai_features_for(db, user)
        assert "auto_summary" not in ai_features_for(db, user)
    finally:
        for e in created:
            db.delete(e)
        db.commit()
        db.close()


def test_wildcard_all_expands():
    db = SessionLocal()
    created = []
    try:
        user = db.get(User, USER)
        created.append(
            _grant(
                db,
                feature=AiFeature.all,
                subject_kind=AiSubjectKind.user,
                user_id=USER,
            )
        )
        assert ai_features_for(db, user) == set(ALL_FEATURES)
    finally:
        for e in created:
            db.delete(e)
        db.commit()
        db.close()


def test_workspace_grant_and_include_descendants():
    db = SessionLocal()
    created, members, slugs = [], [], []
    try:
        parent = "tparent_" + uuid.uuid4().hex[:6]
        child = "tchild_" + uuid.uuid4().hex[:6]
        db.add(Workspace(slug=parent, name="상위"))
        db.add(Workspace(slug=child, name="하위", parent_slug=parent))
        db.commit()
        slugs += [child, parent]  # child 먼저 삭제(parent_slug RESTRICT)
        m = WorkspaceMember(user_id=USER, workspace_slug=child, role=Role.user)
        db.add(m)
        db.commit()
        members.append(m)
        user = db.get(User, USER)

        # 상위에 grant + include_descendants=False → 하위 멤버에 적용 안 됨.
        g = _grant(
            db,
            feature=AiFeature.rag_qa,
            subject_kind=AiSubjectKind.workspace,
            workspace_slug=parent,
            include_descendants=False,
        )
        created.append(g)
        assert "rag_qa" not in ai_features_for(db, user)

        # include_descendants=True → 조상 grant 가 하위 멤버에 적용.
        g.include_descendants = True
        db.commit()
        assert "rag_qa" in ai_features_for(db, user)

        # 직접 하위 워크스페이스 grant → 항상 적용(다른 기능으로 확인).
        created.append(
            _grant(
                db,
                feature=AiFeature.auto_summary,
                subject_kind=AiSubjectKind.workspace,
                workspace_slug=child,
            )
        )
        assert "auto_summary" in ai_features_for(db, user)
    finally:
        for e in created:
            db.delete(e)
        for m in members:
            db.delete(m)
        db.commit()
        for s in slugs:
            ws = db.get(Workspace, s)
            if ws:
                db.delete(ws)
        db.commit()
        db.close()


def test_admin_bypass():
    db = SessionLocal()
    try:
        admin = db.get(User, ADMIN)
        # 관리자 우회 기본 on → 모든 기능.
        assert ai_features_for(db, admin) == set(ALL_FEATURES)
    finally:
        db.close()


def test_crud_endpoint_admin_gate():
    c = TestClient(app)
    admin = {"Authorization": f"Bearer {create_access_token(ADMIN)}"}
    nonadmin = {"Authorization": f"Bearer {create_access_token(USER)}"}

    # 비관리자 → 403(목록·생성).
    assert c.get("/api/ai/entitlements", headers=nonadmin).status_code == 403
    assert (
        c.post(
            "/api/ai/entitlements",
            headers=nonadmin,
            json={"feature": "rag_qa", "subject_kind": "user", "user_id": USER},
        ).status_code
        == 403
    )

    # 관리자 생성 → /me 반영 → 삭제.
    r = c.post(
        "/api/ai/entitlements",
        headers=admin,
        json={"feature": "rag_qa", "subject_kind": "user", "user_id": USER},
    )
    assert r.status_code in (200, 201), r.text
    eid = r.json()["data"]["id"]
    try:
        me = c.get("/api/me", headers=nonadmin).json()["data"]
        assert "rag_qa" in me["ai_features"]
        # 잘못된 subject(워크스페이스인데 slug 없음) → 400.
        assert (
            c.post(
                "/api/ai/entitlements",
                headers=admin,
                json={"feature": "rag_qa", "subject_kind": "workspace"},
            ).status_code
            == 400
        )
    finally:
        c.delete(f"/api/ai/entitlements/{eid}", headers=admin)
    me = c.get("/api/me", headers=nonadmin).json()["data"]
    assert "rag_qa" not in me["ai_features"]
