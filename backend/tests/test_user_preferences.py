"""사용자 환경설정(preferences) — /api/me 노출 + PATCH 깊은 병합.

위젯 "제목 생략" 기본값을 위젯 type별로 기억하는 저장소. 보낸 키만 병합되고
나머지 type/키는 유지되는지 검증.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

WS = "dx"


def _h():
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": WS}


def test_preferences_roundtrip_and_deep_merge():
    client = TestClient(app)

    # /api/me 에 preferences 필드가 있다(빈 객체일 수 있음).
    me = client.get("/api/me", headers=_h()).json()["data"]
    assert "preferences" in me

    # 한 위젯 type 기본값 저장.
    r1 = client.patch(
        "/api/me/preferences",
        headers=_h(),
        json={"preferences": {"widget_caption_skip_autofill": {"image": True}}},
    )
    assert r1.status_code == 200, r1.text
    prefs = r1.json()["data"]["preferences"]
    assert prefs["widget_caption_skip_autofill"]["image"] is True

    # 다른 위젯 type 추가 — 깊은 병합이라 image 는 유지되어야 한다.
    r2 = client.patch(
        "/api/me/preferences",
        headers=_h(),
        json={"preferences": {"widget_caption_skip_autofill": {"rich_text": True}}},
    )
    merged = r2.json()["data"]["preferences"]["widget_caption_skip_autofill"]
    assert merged == {"image": True, "rich_text": True}

    # 같은 type 값 뒤집기.
    r3 = client.patch(
        "/api/me/preferences",
        headers=_h(),
        json={"preferences": {"widget_caption_skip_autofill": {"image": False}}},
    )
    merged3 = r3.json()["data"]["preferences"]["widget_caption_skip_autofill"]
    assert merged3 == {"image": False, "rich_text": True}

    # /api/me 에도 반영.
    me2 = client.get("/api/me", headers=_h()).json()["data"]
    assert me2["preferences"]["widget_caption_skip_autofill"]["rich_text"] is True

    # 정리 — 빈 맵으로 되돌림(깊은 병합이라 키 제거는 안 되지만 값 비움).
    client.patch(
        "/api/me/preferences",
        headers=_h(),
        json={"preferences": {"widget_caption_skip_autofill": {}}},
    )
