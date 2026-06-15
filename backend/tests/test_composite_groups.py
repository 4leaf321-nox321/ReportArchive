"""종합보고 그룹 골격(빈 그룹 포함) 영속 — composite_reports.groups.

종합보고 그룹은 원래 안건의 group_name 으로만 존재해 안건이 없는 빈 그룹은
저장/새로고침 시 사라졌다. groups 컬럼으로 빈 그룹도 영속하는지 검증.
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
            "title": "그룹 테스트 원본",
            "tags": [],
        },
    ).json()["data"]["id"]


def test_empty_group_persists_on_create_and_reload():
    """create 시 groups 에 빈 그룹을 보내면 GET 으로 다시 읽어도 남아 있다."""
    client = TestClient(app)
    report_id = _make_report(client)

    created = client.post(
        "/api/composites",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "빈 그룹 생성",
            "kind": "theme",
            # "영업"은 안건이 있고 "개발"은 빈 그룹.
            "groups": ["영업", "개발"],
            "items": [{"ref_report_id": report_id, "group_name": "영업"}],
        },
    ).json()["data"]
    assert created["groups"] == ["영업", "개발"]

    # 새로고침(GET)해도 빈 그룹이 살아 있어야 한다.
    fetched = client.get(f"/api/composites/{created['id']}", headers=_h()).json()["data"]
    assert fetched["groups"] == ["영업", "개발"]


def test_empty_group_persists_on_update():
    """PATCH 로 빈 그룹을 추가해 저장하면 GET 으로 다시 읽어도 남는다."""
    client = TestClient(app)
    report_id = _make_report(client)
    created = client.post(
        "/api/composites",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "빈 그룹 수정",
            "kind": "theme",
            "items": [{"ref_report_id": report_id, "group_name": "영업"}],
        },
    ).json()["data"]

    upd = client.patch(
        f"/api/composites/{created['id']}",
        headers=_h(),
        json={
            "groups": ["영업", "개발", "기타"],  # 개발·기타는 안건 없는 빈 그룹
            "items": [{"ref_report_id": report_id, "group_name": "영업"}],
            "expected_revision": created["revision"],
        },
    )
    assert upd.status_code == 200, upd.text
    assert upd.json()["data"]["groups"] == ["영업", "개발", "기타"]

    fetched = client.get(f"/api/composites/{created['id']}", headers=_h()).json()["data"]
    assert fetched["groups"] == ["영업", "개발", "기타"]


def test_groups_self_heal_from_items_when_omitted():
    """groups 를 안 보내도 안건 group_name 으로 자동 보충(하위호환)."""
    client = TestClient(app)
    report_id = _make_report(client)
    created = client.post(
        "/api/composites",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "그룹 역산",
            "kind": "theme",
            "items": [{"ref_report_id": report_id, "group_name": "기획"}],
        },
    ).json()["data"]
    # groups 를 명시 안 했어도 안건의 group_name 이 채워진다.
    assert created["groups"] == ["기획"]


def test_instantiate_from_preset_persists_empty_groups():
    """양식에서 새 종합보고를 만들면 빈 그룹이 새 종합보고에 바로 영속된다
    (예전엔 seed_groups 로 프론트에만 전달돼 첫 저장/새로고침 전에 휘발)."""
    client = TestClient(app)
    report_id = _make_report(client)
    src = client.post(
        "/api/composites",
        headers=_h(),
        json={
            "workspace_slug": WS,
            "title": "양식 소스(그룹)",
            "kind": "theme",
            "items": [{"ref_report_id": report_id, "group_name": "영업"}],
        },
    ).json()["data"]
    preset_id = client.post(
        "/api/composite-presets",
        headers=_h(),
        json={
            "source_composite_id": src["id"],
            "name": "그룹 골격 양식",
            "groups": ["영업", "개발"],  # 개발 = 빈 그룹
        },
    ).json()["data"]["id"]

    inst = client.post(
        f"/api/composite-presets/{preset_id}/new-composite",
        headers=_h(),
        json={"workspace_slug": WS, "title": "양식 인스턴스", "kind": "theme"},
    )
    assert inst.status_code in (200, 201), inst.text
    body = inst.json()["data"]
    new_comp = body["composite"]
    # 안건은 비어 있지만 빈 그룹 골격은 새 종합보고에 영속된다.
    assert new_comp["items"] == []
    assert new_comp["groups"] == ["영업", "개발"]
    assert body["seed_groups"] == ["영업", "개발"]

    # 하드 새로고침(GET)에도 살아 있다.
    fetched = client.get(
        f"/api/composites/{new_comp['id']}", headers=_h()
    ).json()["data"]
    assert fetched["groups"] == ["영업", "개발"]

    client.delete(f"/api/composite-presets/{preset_id}", headers=_h())
