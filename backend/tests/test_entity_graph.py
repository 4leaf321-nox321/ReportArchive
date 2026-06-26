"""엔티티 그래프 트래버설(D-2) — graph.py 재귀 CTE + 검색 결합.

reachable(방향·다중관계·깊이), subgraph, 그리고 search_reports 의 entity_ids 결합·
part_of 롤업을 검증. graph 는 서비스로, 검색은 API 로 본다.

실행 전제: 공유 Postgres 가 head(p55)까지 마이그레이션.
    cd backend && ./venv/bin/alembic upgrade head
    python -m pytest tests/test_entity_graph.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import graph, services
from app.modules.entities import services as entity_services
from app.modules.entities.models import (
    Entity,
    EntityRelation,
    EntityType,
    ReportEntity,
)
from app.modules.entities.schemas import EntityCreate
from app.modules.reports.models import Report


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _axis(db, slug):
    return db.execute(select(EntityType.id).where(EntityType.slug == slug)).scalar_one()


def _mk(db, slug):
    return services.create_entity(
        db, EntityCreate(type_id=_axis(db, slug), value="GG" + uuid.uuid4().hex[:8]),
        creator_user_id=1,
    )


def _cleanup(db, ids):
    db.query(ReportEntity).filter(ReportEntity.entity_id.in_(ids)).delete(
        synchronize_session=False
    )
    db.query(EntityRelation).filter(
        EntityRelation.src_entity_id.in_(ids) | EntityRelation.dst_entity_id.in_(ids)
    ).delete(synchronize_session=False)
    db.query(Entity).filter(Entity.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


def test_reachable_directions_and_relation_filter():
    db = SessionLocal()
    ids = []
    try:
        model = _mk(db, "model"); part = _mk(db, "part"); bom = _mk(db, "bom")
        rt = _mk(db, "rel_test")
        ids += [model.id, part.id, bom.id, rt.id]
        services.add_relation(db, src=part, dst=model, relation="part_of")  # part→model
        services.add_relation(db, src=bom, dst=part, relation="part_of")    # bom→part
        services.add_relation(db, src=part, dst=rt, relation="tested_by")   # part→rel_test

        # in: model 의 자손 = part, bom (part_of 만)
        assert graph.reachable(db, [model.id], relations=["part_of"], direction="in") == {
            part.id, bom.id
        }
        # out: bom 의 조상 = part, model
        assert graph.reachable(db, [bom.id], relations=["part_of"], direction="out") == {
            part.id, model.id
        }
        # 관계 필터: part 에서 out 으로 part_of 만 → model. tested_by 포함하면 rel_test 도.
        assert graph.reachable(db, [part.id], relations=["part_of"], direction="out") == {
            model.id
        }
        assert rt.id in graph.reachable(
            db, [part.id], relations=["part_of", "tested_by"], direction="out"
        )
        # relations=None → 모든 종류.
        assert rt.id in graph.reachable(db, [part.id], relations=None, direction="out")

        # subgraph: 4 노드(model·part·bom·rel_test) 다 연결, 엣지 3.
        sg = graph.subgraph(db, [model.id], relations=None, max_depth=5)
        assert len(sg["nodes"]) == 4
        assert len(sg["edges"]) == 3
    finally:
        _cleanup(db, ids)
        db.close()


def test_delegated_helpers_match():
    """part_of 헬퍼가 graph 위임 후에도 동일 결과."""
    db = SessionLocal()
    ids = []
    try:
        model = _mk(db, "model"); part = _mk(db, "part")
        ids += [model.id, part.id]
        services.add_relation(db, src=part, dst=model, relation="part_of")
        assert services.get_descendant_entity_ids(db, root_ids=[model.id]) == {part.id}
        assert set(services.expand_with_descendants(db, entity_ids=[model.id])) == {
            model.id, part.id
        }
    finally:
        _cleanup(db, ids)
        db.close()


def _create_report(client, title):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports", headers=_h(),
        json={"template_id": tpl["template_id"], "template_version": tpl["version"],
              "title": title, "tags": []},
    ).json()["data"]


def _tag(rid, entity_ids):
    db = SessionLocal()
    try:
        entity_services.set_report_entities(db, report_id=rid, entity_ids=entity_ids)
        db.commit()
    finally:
        db.close()


def _search_ids(client, q, **params):
    r = client.get("/api/reports/search", params={"q": q, **params}, headers=_h())
    assert r.status_code == 200, r.text
    return {h["report"]["id"] for h in r.json()["data"]["results"]}


def _purge(rid, ids):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()  # 보고서 삭제(+report_entities CASCADE) 먼저 flush
        _cleanup(db, ids)  # 이제 엔티티를 참조하는 링크가 없다
    finally:
        db.close()


def test_search_with_entity_filter_and_rollup():
    client = TestClient(app)
    db = SessionLocal()
    model = _mk(db, "model"); part = _mk(db, "part"); other = _mk(db, "model")
    services.add_relation(db, src=part, dst=model, relation="part_of")
    db.commit()
    ent_ids = [model.id, part.id, other.id]
    db.close()

    tok = "GRAPHSRCH" + uuid.uuid4().hex[:6].upper()
    rid = _create_report(client, f"{tok} 검색 결합")["id"]
    try:
        _tag(rid, [part.id])  # 보고서에 part 태그
        # 본문 토큰만으로는 찾힘.
        assert rid in _search_ids(client, tok)
        # part 로 필터 → 찾힘.
        assert rid in _search_ids(client, tok, entity_ids=part.id)
        # 무관한 모델로 필터 → 안 찾힘.
        assert rid not in _search_ids(client, tok, entity_ids=other.id)
        # 부모 model 로 필터(롤업 OFF) → part 태그라 안 찾힘.
        assert rid not in _search_ids(client, tok, entity_ids=model.id)
        # 부모 model + 롤업 ON → part_of 자손(part)까지 확장돼 찾힘.
        assert rid in _search_ids(
            client, tok, entity_ids=model.id, entity_rollup="true"
        )
    finally:
        _purge(rid, ent_ids)


def test_entity_graph_endpoint():
    client = TestClient(app)
    db = SessionLocal()
    model = _mk(db, "model"); part = _mk(db, "part")
    services.add_relation(db, src=part, dst=model, relation="part_of")
    db.commit()
    ids = [model.id, part.id]
    db.close()
    try:
        r = client.get(f"/api/entities/{model.id}/graph", headers=_h())
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        node_ids = {n["id"] for n in data["nodes"]}
        assert {model.id, part.id} <= node_ids
        assert len(data["edges"]) >= 1
    finally:
        db2 = SessionLocal()
        _cleanup(db2, ids)
        db2.close()
