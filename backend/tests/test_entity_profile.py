"""객체 프로필(Phase A) — GET /api/entities/{id}/profile 조합 + 가시성.

일회용 축·엔티티로 별칭·관계·태깅보고서를 붙여 프로필이 흩어진 정보를 한 번에
모으는지 확인한다. 핵심 보안 불변식: **관련 보고서는 요청자가 볼 수 있는 것만**
— 소유자는 자기 개인 보고서를 보지만, 공유 안 된 그 보고서는 무관한 비관리자에겐
안 보인다. 인증-only(비로그인 401)·없는 id(404)도 확인. 끝나면 전부 정리한다.

통합 테스트라 격리 없는 dev DB 에 직접 붙는다(conftest 가 id2·3 사용자를 보장).
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services as entity_services
from app.modules.reports.models import Report


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _create_report(c, title):
    tpl = c.get("/api/templates", headers=_h()).json()["data"][0]
    return c.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]


def _tag(rid, entity_ids):
    db = SessionLocal()
    try:
        entity_services.set_report_entities(db, report_id=rid, entity_ids=entity_ids)
        db.commit()
    finally:
        db.close()


def _purge_report(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)  # report_entities CASCADE
            db.commit()
    finally:
        db.close()


def test_entity_profile_composition_and_visibility():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    axis_slug = "tstp_" + sfx
    rel_slug = "tstprel_" + sfx
    alias = "별칭-" + sfx
    type_id = None
    rel_created = False
    ent_ids = []
    rid = None
    try:
        # 1. 일회용 축 + 엔티티 2개
        r = c.post(
            "/api/entity-types",
            headers=_h(),
            json={"slug": axis_slug, "label": "프로필축"},
        )
        assert r.status_code in (200, 201), r.text
        type_id = r.json()["data"]["id"]
        for v in ("PA-" + sfx, "PB-" + sfx):
            r = c.post(
                "/api/entities", headers=_h(), json={"type_id": type_id, "value": v}
            )
            assert r.status_code in (200, 201), r.text
            ent_ids.append(r.json()["data"]["id"])
        subj, other = ent_ids

        # 2. 별칭 + 관계(축 제약 없는 일회용 관계종류로 subj --rel--> other)
        r = c.post(f"/api/entities/{subj}/aliases", headers=_h(), json={"alias": alias})
        assert r.status_code in (200, 201), r.text
        r = c.post(
            "/api/relation-types",
            headers=_h(),
            json={"slug": rel_slug, "label": "프로필관계", "directed": True},
        )
        assert r.status_code in (200, 201), r.text
        rel_created = True
        r = c.post(
            f"/api/entities/{subj}/relations",
            headers=_h(),
            json={"dst_entity_id": other, "relation": rel_slug},
        )
        assert r.status_code in (200, 201), r.text

        # 3. 프로필 조합 반환(인증-only)
        r = c.get(f"/api/entities/{subj}/profile", headers=_h())
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["entity"]["id"] == subj
        assert d["entity"]["type_slug"] == axis_slug
        assert any(a["alias"] == alias for a in d["aliases"])
        assert any(
            p["entity_id"] == other and p["relation"] == rel_slug
            for p in d["relations"]["parents"]
        )
        assert isinstance(d["reports"], list)
        assert d["report_count"] == len(d["reports"])

        # 4. user1 소유 개인 보고서 + subj 태깅
        rid = _create_report(c, "프로필테스트-" + sfx)["id"]
        _tag(rid, [subj])

        # 소유자(user1)는 태깅 보고서를 본다
        r = c.get(f"/api/entities/{subj}/profile", headers=_h(uid=1))
        assert r.status_code == 200, r.text
        d1 = r.json()["data"]
        assert rid in {rp["id"] for rp in d1["reports"]}
        assert d1["report_count"] == len(d1["reports"])

        # 5. 가시성 필터 — 공유 안 된 개인 보고서는 무관한 비관리자(user3)에겐 제외
        r = c.get(f"/api/entities/{subj}/profile", headers=_h(uid=3))
        assert r.status_code == 200, r.text
        assert rid not in {rp["id"] for rp in r.json()["data"]["reports"]}

        # 6. 인증-only — 토큰 없으면 401
        r = c.get(f"/api/entities/{subj}/profile")
        assert r.status_code == 401, r.text

        # 7. 없는 id → 404
        r = c.get("/api/entities/999999999/profile", headers=_h())
        assert r.status_code == 404, r.text
    finally:
        if rid is not None:
            _purge_report(rid)
        if ent_ids:
            # 관계·별칭은 엔티티 삭제 시 함께 정리되지만, 명시적으로 관계 먼저 지운다.
            rr = c.get(f"/api/entities/{ent_ids[0]}/relations", headers=_h())
            if rr.status_code == 200:
                for p in rr.json()["data"]["parents"]:
                    c.delete(
                        f"/api/entities/{ent_ids[0]}/relations/{p['relation_id']}",
                        headers=_h(),
                    )
        for eid in ent_ids:
            c.delete(f"/api/entities/{eid}", headers=_h())
        if rel_created:
            c.delete(f"/api/relation-types/{rel_slug}", headers=_h())
        if type_id is not None:
            c.delete(f"/api/entity-types/{type_id}", headers=_h())
