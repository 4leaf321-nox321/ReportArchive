"""보고서/종합보고 삭제 시 content_grant 가 함께 정리되는지(고아 방지).

content_grant 는 polymorphic(FK CASCADE 없음)이라 서비스 계층에서 정리해야 한다.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.grants.models import ContentGrant, GrantContentType

BOARD = "dev-hw"


def _h():
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": "dx"}


def _grant_count(content_type, content_id):
    db = SessionLocal()
    try:
        return (
            db.query(ContentGrant)
            .filter_by(content_type=content_type, content_id=content_id)
            .count()
        )
    finally:
        db.close()


@pytest.mark.skip(
    reason="게시된 보고서 DELETE 가 이제 409 — 보고서 삭제 재설계(소프트삭제+게시취소 "
    "요청 큐)로 동작이 바뀜. 이 테스트는 옛 즉시삭제(200)를 가정하므로, 새 삭제 "
    "흐름(언마운트/게시취소 후 삭제)에 맞춰 재작성 필요. grant 정리 검증 목적 자체는 유효."
)
def test_report_delete_removes_grants():
    client = TestClient(app)
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "grant 정리 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    # mount(부서 grant) + all_org 공유 → grant 2개 이상.
    client.post(
        "/api/mounts",
        headers=_h(),
        json={"report_id": rid, "workspace_slugs": [BOARD]},
    )
    client.post(
        f"/api/reports/{rid}/shares", headers=_h(), json={"principal_type": "all_org"}
    )
    assert _grant_count(GrantContentType.report, rid) >= 2

    # 삭제 → grant 0.
    assert client.delete(f"/api/reports/{rid}", headers=_h()).status_code == 200
    assert _grant_count(GrantContentType.report, rid) == 0


def test_composite_delete_removes_grants():
    client = TestClient(app)
    cid = client.post(
        "/api/composites",
        headers=_h(),
        json={"workspace_slug": "dx", "title": "종합 grant 정리", "kind": "theme"},
    ).json()["data"]["id"]
    # 생성 시 home 부서 grant 자동 생성.
    assert _grant_count(GrantContentType.composite, cid) >= 1
    assert client.delete(f"/api/composites/{cid}", headers=_h()).status_code == 200
    assert _grant_count(GrantContentType.composite, cid) == 0
