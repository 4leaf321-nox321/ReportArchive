"""온톨로지 쓰기(A'') — 외부 AI(MCP)가 기준정보를 채우는 `/api/ai/ontology/write`.

**시스템 관리자 전용**(require_system_admin). MCP 는 호출자의 PAT 를 그대로 전달하므로,
관리자 계정 토큰(conftest user id=2, is_system_admin=True)만 통과하고 비관리자(id=3)는 403.
LLM 미호출이라 mock 불필요. 일회용 축/객체는 테스트가 만들고 정리한다(test_entity_profile 패턴).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {  # user id 2 — is_system_admin=True (conftest seed)
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}
USER3 = {  # user id 3 — 비관리자
    "Authorization": f"Bearer {create_access_token(3)}",
    "X-Workspace-Slug": "dx",
}


def _write(c, headers, name, args):
    return c.post(
        "/api/ai/ontology/write", headers=headers, json={"name": name, "args": args}
    )


@pytest.fixture()
def axis():
    """일회용 open 축 1개 생성 → (slug, id) → 정리."""
    c = TestClient(app)
    slug = "owt_" + uuid.uuid4().hex[:8]
    r = c.post("/api/entity-types", headers=ADMIN, json={"slug": slug, "label": "쓰기테스트축"})
    assert r.status_code in (200, 201), r.text
    yield slug, r.json()["data"]["id"]
    # 축 삭제 전에 이 축의 객체를 먼저 정리해야 FK 가 안 막는다 — 테스트 본문이
    # 만든 객체는 delete 로 지운다. 여기선 축만.
    c.delete(f"/api/entity-types/{r.json()['data']['id']}", headers=ADMIN)


def test_write_requires_system_admin(axis):
    """비관리자 토큰은 모든 쓰기 이름에 403."""
    c = TestClient(app)
    slug, _ = axis
    for name, args in [
        ("create_object", {"type_slug": slug, "value": "x"}),
        ("update_object", {"object_id": 1, "value": "x"}),
        ("add_object_alias", {"object_id": 1, "alias": "x"}),
        ("link_objects", {"src_id": 1, "dst_id": 2, "relation": "part_of"}),
    ]:
        r = _write(c, USER3, name, args)
        assert r.status_code == 403, f"{name}: {r.status_code} {r.text}"


def test_unknown_write_tool_is_404(axis):
    c = TestClient(app)
    r = _write(c, ADMIN, "delete_everything", {})
    assert r.status_code == 404, r.text


def test_create_is_idempotent_and_admin_can_write(axis):
    c = TestClient(app)
    slug, _ = axis
    created_ids = []
    # 축 제약 없는 일회용 관계종류(dev 의 part_of 는 part/bom 축만 허용).
    rel_slug = "owtrel_" + uuid.uuid4().hex[:8]
    r = c.post(
        "/api/relation-types", headers=ADMIN,
        json={"slug": rel_slug, "label": "쓰기테스트관계", "directed": True},
    )
    assert r.status_code in (200, 201), r.text
    try:
        # 1. create → 신규.
        val = "가속수명-" + uuid.uuid4().hex[:6]
        r = _write(c, ADMIN, "create_object", {"type_slug": slug, "value": val})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["created"] is True
        oid = d["object"]["id"]
        assert d["object"]["type_slug"] == slug
        created_ids.append(oid)

        # 2. 같은 값 재호출 → 멱등(신규 아님, 같은 id).
        r = _write(c, ADMIN, "create_object", {"type_slug": slug, "value": val})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["created"] is False
        assert d["object"]["id"] == oid

        # 3. update_object — 설명 갱신.
        r = _write(c, ADMIN, "update_object", {"object_id": oid, "description": "설명추가"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["object"]["description"] == "설명추가"

        # 4. add_object_alias.
        r = _write(c, ADMIN, "add_object_alias", {"object_id": oid, "alias": "별칭-" + val})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["ok"] is True

        # 5. link_objects — 같은 축 두 번째 객체를 만들어 part_of 로 연결.
        r = _write(c, ADMIN, "create_object", {"type_slug": slug, "value": "부모-" + val})
        parent_id = r.json()["data"]["object"]["id"]
        created_ids.append(parent_id)
        r = _write(
            c, ADMIN, "link_objects",
            {"src_id": oid, "dst_id": parent_id, "relation": rel_slug},
        )
        assert r.status_code == 200, r.text
        ld = r.json()["data"]
        assert ld.get("ok") is True and ld["relation"] == rel_slug
    finally:
        for oid in created_ids:
            c.delete(f"/api/entities/{oid}", headers=ADMIN)
        c.delete(f"/api/relation-types/{rel_slug}", headers=ADMIN)


def test_governance_errors_are_returned_not_raised(axis):
    """거버넌스 위반은 500 이 아니라 200 + {error} 로 돌아와 AI 가 교정하게 한다."""
    c = TestClient(app)
    slug, type_id = axis

    # 미정의 속성 키 → error(축에 property_def 가 없으므로 모든 키가 미정의).
    r = _write(
        c, ADMIN, "create_object",
        {"type_slug": slug, "value": "속성테스트", "properties": {"nope": "x"}},
    )
    assert r.status_code == 200, r.text
    assert "error" in r.json()["data"]

    # 없는 축 → error.
    r = _write(c, ADMIN, "create_object", {"type_slug": "no_such_axis_zzz", "value": "x"})
    assert r.status_code == 200, r.text
    assert "error" in r.json()["data"]

    # closed 축으로 전환 후 create → error(관리자가 등록한 값만).
    r = c.patch(
        f"/api/entity-types/{type_id}", headers=ADMIN, json={"entry_policy": "closed"}
    )
    assert r.status_code == 200, r.text
    r = _write(c, ADMIN, "create_object", {"type_slug": slug, "value": "새값차단"})
    assert r.status_code == 200, r.text
    assert "error" in r.json()["data"]
