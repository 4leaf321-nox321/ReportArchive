"""객체 레코드 위젯 입력경로 (A0.3) — upsert_record_entity + 저장 훅.

위젯이 record 축(시험실행/실패사례) 객체를 upsert 하는 서비스와, 보고서 저장 훅
(_materialize_record_widgets)이 위젯 content 에서 객체를 만들고 entity_id 를
되심는지 확인. 통합 테스트라 격리 없는 dev DB 에 붙는다(record 축은 마이그 p66 시드).
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services as ent_services
from app.modules.reports import services as report_services
from app.modules.reports.models import Report

ADMIN = 2


def _h(uid=ADMIN):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _hw(uid=ADMIN, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def test_upsert_record_entity():
    db = SessionLocal()
    sfx = uuid.uuid4().hex[:8]
    made = []
    try:
        # 1. 신규 생성 + 속성
        e1 = ent_services.upsert_record_entity(
            db, axis_slug="test_run", name="UT-" + sfx,
            properties={"result": "합격"}, creator_user_id=ADMIN,
        )
        assert e1 is not None and e1.value == "UT-" + sfx
        assert e1.properties["result"] == "합격"
        made.append(e1.id)

        # 2. entity_id 로 기존 갱신 — 같은 객체가 갱신됨(중복 아님)
        e2 = ent_services.upsert_record_entity(
            db, axis_slug="test_run", name="UT2-" + sfx,
            properties={"result": "불합격"}, entity_id=e1.id, creator_user_id=ADMIN,
        )
        assert e2.id == e1.id
        assert e2.value == "UT2-" + sfx and e2.properties["result"] == "불합격"

        # 3. 같은 축·같은 이름이면 id 없이도 기존으로 resolve(무료 dedup)
        e3 = ent_services.upsert_record_entity(
            db, axis_slug="test_run", name="UT2-" + sfx,
            properties={"result": "합격"}, creator_user_id=ADMIN,
        )
        assert e3.id == e1.id

        # 4. record 축이 아니면 None(model=reference)
        assert ent_services.upsert_record_entity(
            db, axis_slug="model", name="x-" + sfx, properties={}, creator_user_id=ADMIN,
        ) is None
        # 5. 이름 비면 None
        assert ent_services.upsert_record_entity(
            db, axis_slug="test_run", name="  ", properties={}, creator_user_id=ADMIN,
        ) is None
        # 6. 잘못된 enum → ValueError(속성 검증)
        try:
            ent_services.upsert_record_entity(
                db, axis_slug="test_run", name="UT9-" + sfx,
                properties={"result": "몰라"}, creator_user_id=ADMIN,
            )
            assert False, "invalid enum should raise"
        except ValueError:
            pass
    finally:
        for eid in made:
            e = db.get(ent_services.Entity, eid)
            if e:
                db.delete(e)
        db.commit()
        db.close()


def test_materialize_record_widget_hook():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tpl = c.get("/api/templates", headers=_hw()).json()["data"][0]
    rid = c.post(
        "/api/reports", headers=_hw(),
        json={"template_id": tpl["template_id"], "template_version": tpl["version"],
              "title": "REC-" + sfx, "tags": []},
    ).json()["data"]["id"]
    ent_id = None
    try:
        db = SessionLocal()
        rep = db.get(Report, rid)
        # record 위젯 content(axis_slug 표식) 주입
        rep.content = {
            "blk1": {
                "axis_slug": "incident",
                "name": "INC-" + sfx,
                "properties": {"impact": "중대", "action_status": "조치중"},
            }
        }
        db.commit()

        ids = report_services._materialize_record_widgets(db, rep, ADMIN)
        assert len(ids) == 1, ids
        ent_id = next(iter(ids))

        # entity_id 되심김 확인
        db.refresh(rep)
        assert rep.content["blk1"]["entity_id"] == ent_id

        # 만들어진 객체 확인
        e = ent_services.get_entity(db, ent_id)
        assert e.value == "INC-" + sfx and e.entity_type.slug == "incident"
        assert e.properties["impact"] == "중대"

        # 태그 wiring — union add 하면 보고서 관련객체에 뜬다
        report_services.add_entities_to_report(db, rep, [ent_id])
        db.refresh(rep)
        assert ent_id in {x.id for x in rep.entities}

        # 재실행(멱등) — 같은 위젯 다시 → 새 객체 안 생김
        ids2 = report_services._materialize_record_widgets(db, rep, ADMIN)
        assert ids2 == {ent_id}

        # 잘못된 속성 값(숫자 필드에 문자) → 조용히 넘기지 않고 ValueError(=400).
        rep.content = {
            "blk2": {
                "axis_slug": "test_run",
                "name": "BAD-" + sfx,
                "properties": {"value": "숫자아님"},
            }
        }
        db.commit()
        try:
            report_services._materialize_record_widgets(db, rep, ADMIN)
            assert False, "invalid property should raise (not silent skip)"
        except ValueError as exc:
            assert "숫자" in str(exc)
        db.close()
    finally:
        if ent_id is not None:
            c.delete(f"/api/entities/{ent_id}", headers=_h())
        db = SessionLocal()
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()
        db.close()
