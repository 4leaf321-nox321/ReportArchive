"""대시보드 부서 건강도 — '하위부서 포함' 시 미분류(uncategorized)가 하위부서
게시판까지 합산되는지 검증(이전엔 현재 부서만 셌음)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.database import SessionLocal
from app.modules.auth.services import create_access_token
from app.modules.folders import services as folder_services

WS = "dx"  # 하위부서가 있는 org 게시판


def _h():
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": WS}


def test_dashboard_uncategorized_includes_descendants():
    client = TestClient(app)
    single = client.get(
        "/api/dashboard?include_descendants=false", headers=_h()
    ).json()["data"]["health"]["uncategorized"]
    withdesc = client.get(
        "/api/dashboard?include_descendants=true", headers=_h()
    ).json()["data"]["health"]["uncategorized"]
    # 하위부서 포함은 현재 부서만 셈보다 작을 수 없다(자손 미분류가 더해짐).
    assert withdesc >= single


def test_count_uncategorized_org_multi_invariants():
    db = SessionLocal()
    try:
        # 빈 입력 → 0.
        assert folder_services.count_uncategorized_org_multi(db, []) == 0
        # 단일 슬러그는 기존 단일 카운트와 동일.
        one = folder_services.count_uncategorized_org(db, WS)
        assert folder_services.count_uncategorized_org_multi(db, [WS]) == one
        # 서로 다른 부서 합산 = 각 부서 합(부서별 mount 는 겹치지 않음).
        a = folder_services.count_uncategorized_org(db, "dev-hw")
        b = folder_services.count_uncategorized_org(db, "dev-he")
        assert folder_services.count_uncategorized_org_multi(db, ["dev-hw", "dev-he"]) == a + b
    finally:
        db.close()
