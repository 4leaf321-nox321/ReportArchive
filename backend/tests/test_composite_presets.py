"""종합보고 양식(CompositePreset) — 저장 → 목록 → 인스턴스화 왕복.

요약(summary_widgets) + 그룹 골격(빈 그룹 포함) + 보기설정 스냅샷이 양식에
담기고, 양식에서 새 종합보고를 만들면 그대로 시드되는지 검증.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

WS = "dx"


def _h():
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": WS}


def _make_report(client):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "양식 테스트 원본",
            "tags": [],
        },
    ).json()["data"]["id"]


def test_composite_preset_roundtrip():
    client = TestClient(app)
    report_id = _make_report(client)

    # 요약 위젯 + 그룹 있는 안건을 가진 종합보고 생성.
    summary = [
        {
            "id": "w_sum1",
            "type": "rich_text",
            "props": {},
            "content": {"text": "주간 요약"},
            "layout": {"x": 0, "y": 0, "w": 12, "h": 2},
        }
    ]
    created = client.post(
        "/api/composites",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "원본 종합 (양식 소스)",
            "kind": "theme",
            "view_mode": "two_col",
            "description": "정기 회의 종합",
            "summary_widgets": summary,
            "items": [
                {"ref_report_id": report_id, "group_name": "영업팀"},
            ],
        },
    ).json()["data"]
    composite_id = created["id"]

    # 양식으로 저장 — groups 에 빈 그룹("개발팀")까지 포함해 골격을 보존.
    preset = client.post(
        "/api/composite-presets",
        headers=_h(),
        json={
            "source_composite_id": composite_id,
            "name": "주간 종합 양식",
            "description": "매주 동일 골격",
            "owner_workspace_slugs": None,
            "groups": ["영업팀", "개발팀"],
        },
    )
    assert preset.status_code in (200, 201), preset.text
    preset_data = preset.json()["data"]
    preset_id = preset_data["id"]
    assert preset_data["source_kind"] == "theme"

    # 목록에 보인다(전사 공개).
    rows = client.get("/api/composite-presets", headers=_h()).json()["data"]
    assert any(r["id"] == preset_id for r in rows)

    # 양식에서 새 종합보고 — kind/title/period 는 새로, 골격은 시드.
    inst = client.post(
        f"/api/composite-presets/{preset_id}/new-composite",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "2026-W30 종합",
            "kind": "recurring",
            "period_date": "2026-07-20",
        },
    )
    assert inst.status_code in (200, 201), inst.text
    body = inst.json()["data"]
    new_comp = body["composite"]

    # 요약·보기설정·설명이 시드됐고, 안건은 비어 있고, 빈 그룹 골격은 seed_groups 로.
    assert new_comp["summary_widgets"] == summary
    assert new_comp["view_mode"] == "two_col"
    assert new_comp["description"] == "정기 회의 종합"
    assert new_comp["kind"] == "recurring"
    assert new_comp["period_date"] == "2026-07-20"
    assert new_comp["items"] == []
    assert body["seed_groups"] == ["영업팀", "개발팀"]

    # 정리 — 양식 삭제(본인 소유).
    dele = client.delete(f"/api/composite-presets/{preset_id}", headers=_h())
    assert dele.status_code == 200, dele.text


def test_composite_preset_update_meta_and_groups():
    """관리 탭 — 이름·설명·공개범위·그룹 목록 수정. 그룹은 seed 에 반영되고
    인스턴스화 시 seed_groups 로 흘러나온다."""
    client = TestClient(app)
    report_id = _make_report(client)
    created = client.post(
        "/api/composites",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "수정 소스",
            "kind": "theme",
            "items": [{"ref_report_id": report_id, "group_name": "초기그룹"}],
        },
    ).json()["data"]
    preset_id = client.post(
        "/api/composite-presets",
        headers=_h(),
        json={
            "source_composite_id": created["id"],
            "name": "수정 전 이름",
            "groups": ["초기그룹"],
        },
    ).json()["data"]["id"]

    # 메타 + 그룹 골격을 한 번에 수정(순서 포함).
    upd = client.patch(
        f"/api/composite-presets/{preset_id}",
        headers=_h(),
        json={
            "name": "수정 후 이름",
            "description": "갱신된 설명",
            "owner_workspace_slugs": [WS],
            "groups": ["영업", "개발", "기타"],
        },
    )
    assert upd.status_code == 200, upd.text
    data = upd.json()["data"]
    assert data["name"] == "수정 후 이름"
    assert data["description"] == "갱신된 설명"
    assert data["owner_workspace_slugs"] == [WS]
    assert data["groups"] == ["영업", "개발", "기타"]

    # 인스턴스화 시 수정된 그룹 골격이 seed_groups 로 나온다.
    inst = client.post(
        f"/api/composite-presets/{preset_id}/new-composite",
        headers=_h(),
        json={"workspace_slug": WS, "title": "수정 결과", "kind": "theme"},
    ).json()["data"]
    assert inst["seed_groups"] == ["영업", "개발", "기타"]

    # 부분 수정 — 이름만 보내면 그룹은 유지(전송 안 한 필드 불변).
    upd2 = client.patch(
        f"/api/composite-presets/{preset_id}",
        headers=_h(),
        json={"name": "또 수정"},
    ).json()["data"]
    assert upd2["name"] == "또 수정"
    assert upd2["groups"] == ["영업", "개발", "기타"]

    client.delete(f"/api/composite-presets/{preset_id}", headers=_h())


def test_preset_groups_fallback_to_items_when_omitted():
    """클라이언트가 groups 를 안 보내면 저장된 안건의 group_name 에서 역산."""
    client = TestClient(app)
    report_id = _make_report(client)
    created = client.post(
        "/api/composites",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "그룹 역산 소스",
            "kind": "theme",
            "items": [{"ref_report_id": report_id, "group_name": "기획"}],
        },
    ).json()["data"]
    preset_id = client.post(
        "/api/composite-presets",
        headers=_h(),
        json={"source_composite_id": created["id"], "name": "역산 양식"},
    ).json()["data"]["id"]
    inst = client.post(
        f"/api/composite-presets/{preset_id}/new-composite",
        headers=_h(),
        json={"workspace_slug": WS, "title": "역산 결과", "kind": "theme"},
    ).json()["data"]
    assert inst["seed_groups"] == ["기획"]
    client.delete(f"/api/composite-presets/{preset_id}", headers=_h())
