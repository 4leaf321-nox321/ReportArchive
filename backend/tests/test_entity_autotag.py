"""자동태깅 제안 — POST /api/reports/{id}/suggest-entities.

결정적 매칭(본문에 엔티티 값이 그대로 등장 → 제안)과 이미 태깅된 값 제외를
엔드포인트로 검증한다. 유사도 레이어는 임베딩 백엔드/Ollama 가용성에 의존하므로
여기선 결정적 경로만 단언한다(유사도는 추가 후보일 뿐, 결정적 결과를 가리지 않음).

실행 전제: 공유 Postgres 가 head 까지 마이그레이션돼 있어야 한다.
    cd backend && ./venv/bin/alembic upgrade head
    python -m pytest tests/test_entity_autotag.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services as entity_services
from app.modules.entities.models import Entity, EntityAlias, ReportEntity
from app.modules.reports.models import Report


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _create_report(client, title):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]


def _create_entity(client, value):
    type_id = client.get("/api/entity-types", headers=_h()).json()["data"][
        "items"
    ][0]["id"]
    r = client.post(
        "/api/entities", headers=_h(), json={"type_id": type_id, "value": value}
    )
    assert r.status_code == 201, r.text
    return r.json()["data"]


def _suggest(client, rid):
    r = client.post(f"/api/reports/{rid}/suggest-entities", headers=_h())
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _sug_ids(data):
    return {s["id"] for s in data["items"]}


def _purge_report(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()
    finally:
        db.close()


def _purge_entity(eid):
    db = SessionLocal()
    try:
        db.query(ReportEntity).filter_by(entity_id=eid).delete()
        db.query(EntityAlias).filter_by(entity_id=eid).delete()
        e = db.get(Entity, eid)
        if e:
            db.delete(e)
        db.commit()
    finally:
        db.close()


def test_suggests_entity_present_in_body():
    client = TestClient(app)
    tok = "Z" + uuid.uuid4().hex[:8].upper()  # 본문에 그대로 박을 고유 토큰
    ent = _create_entity(client, tok)
    # 제목에 값을 그대로 넣음 — 제목도 청크로 추출된다.
    rid = _create_report(client, f"테스트 {tok} 보고서")["id"]
    try:
        data = _suggest(client, rid)
        assert ent["id"] in _sug_ids(data)
        sug = next(s for s in data["items"] if s["id"] == ent["id"])
        assert sug["source"] == "deterministic"
        assert sug["score"] == 1.0
    finally:
        _purge_report(rid)
        _purge_entity(ent["id"])


def test_already_tagged_excluded():
    client = TestClient(app)
    tok = "Z" + uuid.uuid4().hex[:8].upper()
    ent = _create_entity(client, tok)
    rid = _create_report(client, f"중복 {tok} 보고서")["id"]
    try:
        # 처음엔 제안에 뜬다.
        assert ent["id"] in _sug_ids(_suggest(client, rid))
        # 태깅하면 더는 제안하지 않는다(이미 가진 값 제외). PATCH 는 편집 락을
        # 요구하므로(여기 관심사 아님) 링크 서비스로 직접 태깅한다.
        db = SessionLocal()
        try:
            entity_services.set_report_entities(
                db, report_id=rid, entity_ids=[ent["id"]]
            )
            db.commit()
        finally:
            db.close()
        assert ent["id"] not in _sug_ids(_suggest(client, rid))
    finally:
        _purge_report(rid)
        _purge_entity(ent["id"])


def test_add_entities_is_additive_union():
    client = TestClient(app)
    a = _create_entity(client, "Z" + uuid.uuid4().hex[:8].upper())
    b = _create_entity(client, "Z" + uuid.uuid4().hex[:8].upper())
    rid = _create_report(client, "가산 적용 테스트")["id"]
    try:
        # a 추가 → 1건.
        r = client.post(
            f"/api/reports/{rid}/entities/add",
            headers=_h(),
            json={"entity_ids": [a["id"]]},
        )
        assert r.status_code == 200, r.text
        assert set(r.json()["data"]["entity_ids"]) == {a["id"]}
        assert r.json()["data"]["added"] == 1
        # b 추가 → a 는 유지하고 b 가 더해진다(union, 교체 아님).
        r = client.post(
            f"/api/reports/{rid}/entities/add",
            headers=_h(),
            json={"entity_ids": [b["id"]]},
        )
        assert set(r.json()["data"]["entity_ids"]) == {a["id"], b["id"]}
        assert r.json()["data"]["added"] == 1
        # 같은 걸 또 추가 → no-op(중복 없음).
        r = client.post(
            f"/api/reports/{rid}/entities/add",
            headers=_h(),
            json={"entity_ids": [a["id"]]},
        )
        assert set(r.json()["data"]["entity_ids"]) == {a["id"], b["id"]}
        assert r.json()["data"]["added"] == 0
    finally:
        _purge_report(rid)
        _purge_entity(a["id"])
        _purge_entity(b["id"])


def test_partial_token_not_falsely_matched():
    client = TestClient(app)
    tok = "Z" + uuid.uuid4().hex[:8].upper()
    ent = _create_entity(client, tok)
    # 본문엔 토큰의 *접두* 만 — 영숫자 경계 가드가 부분일치 오탐을 막아야 한다.
    rid = _create_report(client, f"테스트 {tok}EXTRA 보고서")["id"]
    try:
        assert ent["id"] not in _sug_ids(_suggest(client, rid))
    finally:
        _purge_report(rid)
        _purge_entity(ent["id"])
