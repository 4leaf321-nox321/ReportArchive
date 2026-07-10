"""외부 시스템 연계 커넥터 v1 — CRUD + 동기화(외부 fetch 는 monkeypatch).

외부 API 를 실제로 때리지 않도록 services.fetch_records 를 canned 레코드로 대체하고,
JSON→rows 변환 + run_import 재사용으로 온톨로지가 채워지는지 확인한다:
  - _dig / build_rows_and_mapping 순수 함수(중첩 JSON 추출).
  - CRUD + 시크릿 마스킹(has_secret, 갱신 시 보존).
  - preview(dry_run=쓰기 없음) → sync(생성) → 재sync(멱등 갱신) + 이력·관계 링크.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token
from app.ai.llm import ChatResult, LLMError
from app.modules.connectors import services as conn_services
from app.modules.connectors import suggest as conn_suggest
from app.modules.connectors.fetch import _dig, build_rows_and_mapping
from app.modules.connectors.schemas import StreamConfig

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}


def _find(c, type_id, q):
    r = c.post("/api/entities/search", headers=ADMIN,
               json={"type_id": type_id, "q": q})
    return r.json()["data"]["items"]


# --- 순수 함수 --------------------------------------------------------------
def test_dig_nested_and_index():
    obj = {"a": {"b": [{"c": "x"}, {"c": "y"}]}}
    assert _dig(obj, "a.b.0.c") == "x"
    assert _dig(obj, "a.b.1.c") == "y"
    assert _dig(obj, "a.missing") is None
    assert _dig(obj, "") is obj
    assert _dig(obj, "$") is obj


def test_build_rows_and_mapping():
    st = StreamConfig(
        target_type_id=7,
        value_path="name",
        property_map={"stage": "status"},
        relation_map=[{"relation": "supplied_by", "target_type": "supplier",
                       "path": "supplier.code"}],
    )
    records = [{"name": "P1", "status": "active", "supplier": {"code": "S1"}}]
    mapping, rows = build_rows_and_mapping(st, records, dry_run=True)
    assert mapping.type_id == 7
    assert mapping.value_column == "__value__"
    assert mapping.property_columns == {"__p_stage": "stage"}
    assert mapping.relation_columns[0].relation == "supplied_by"
    assert rows[0]["__value__"] == "P1"
    assert rows[0]["__p_stage"] == "active"
    assert rows[0]["__r_0"] == "S1"


# --- CRUD + 마스킹 ----------------------------------------------------------
def test_connector_crud_and_secret_masking():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    sid = None
    try:
        cfg = {
            "connection": {
                "base_url": "https://example.test",
                "auth": {"type": "bearer", "token": "supersecret"},
            },
            "streams": [{
                "endpoint_path": "/api/x", "records_path": "data",
                "target_type_id": 1, "value_path": "name",
            }],
        }
        payload = {"name": "src-" + sfx, "kind": "rest_json", "config": cfg}
        r = c.post("/api/connectors", headers=ADMIN, json=payload)
        assert r.status_code == 200, r.text
        sid = r.json()["data"]["id"]

        # 시크릿은 마스킹, has_secret=True.
        r = c.get(f"/api/connectors/{sid}", headers=ADMIN)
        d = r.json()["data"]
        assert d["has_secret"] is True
        assert d["config"]["connection"]["auth"]["token"] == ""
        assert len(d["config"]["streams"]) == 1

        # 이름만 바꾸고 config 갱신(토큰 빈 값) → 시크릿 보존.
        r = c.put(f"/api/connectors/{sid}", headers=ADMIN, json={
            "name": "src2-" + sfx,
            "config": {**cfg, "connection": {**cfg["connection"],
                                             "auth": {"type": "bearer", "token": ""}}},
        })
        assert r.status_code == 200, r.text
        assert r.json()["data"]["has_secret"] is True  # 여전히 저장돼 있음

        # 이름 중복 → 409.
        r2 = c.post("/api/connectors", headers=ADMIN, json={**payload, "name": "src2-" + sfx})
        assert r2.status_code == 409, r2.text

        # 목록에 존재.
        names = [s["name"] for s in c.get("/api/connectors", headers=ADMIN).json()["data"]["items"]]
        assert ("src2-" + sfx) in names
    finally:
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)


# --- 동기화(외부 fetch 대체) ------------------------------------------------
def test_sync_populates_ontology(monkeypatch):
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    proj_id = sup_id = sid = None
    rel = "connrel_" + sfx
    rel_created = False
    made = []
    try:
        # 축: 과제(record + stage 속성) + 공급사(record) + 관계타입.
        proj_id = c.post("/api/entity-types", headers=ADMIN,
                         json={"slug": "connproj_" + sfx, "label": "연계과제",
                               "kind_class": "record"}).json()["data"]["id"]
        c.post(f"/api/entity-types/{proj_id}/properties", headers=ADMIN,
               json={"key": "stage", "label": "단계", "data_type": "text"})
        sup_id = c.post("/api/entity-types", headers=ADMIN,
                        json={"slug": "connsup_" + sfx, "label": "연계공급사",
                              "kind_class": "record"}).json()["data"]["id"]
        c.post("/api/relation-types", headers=ADMIN,
               json={"slug": rel, "label": "연계관계", "directed": True})
        rel_created = True
        sup_val = "SUPX-" + sfx
        c.post("/api/entities", headers=ADMIN, json={"type_id": sup_id, "value": sup_val})

        a, b = "연계A-" + sfx, "연계B-" + sfx
        records = [
            {"name": a, "status": "active", "supplier": {"code": sup_val}},
            {"name": b, "status": "planned", "supplier": {"code": "MISSING-" + sfx}},
        ]
        # 외부 fetch 를 canned 레코드로 대체(실 네트워크 없음). (connection, stream) 2인자.
        monkeypatch.setattr(conn_services, "fetch_records", lambda conn, st: records)

        cfg = {
            "connection": {"base_url": "https://example.test"},
            "streams": [{
                "endpoint_path": "/api/projects", "records_path": "data",
                "target_type_id": proj_id, "value_path": "name",
                "property_map": {"stage": "status"},
                "relation_map": [{"relation": rel, "target_type": "connsup_" + sfx,
                                  "path": "supplier.code"}],
            }],
        }
        sid = c.post("/api/connectors", headers=ADMIN,
                     json={"name": "sync-" + sfx, "config": cfg}).json()["data"]["id"]

        # 미리보기(dry_run) — 쓰기 없음.
        r = c.post(f"/api/connectors/{sid}/preview", headers=ADMIN)
        assert r.status_code == 200, r.text
        s = r.json()["data"]["summary"]
        assert s["committed"] is False and s["create"] == 2, s
        assert _find(c, proj_id, a) == []  # 아직 없음

        # 실제 동기화 — 생성 + 링크.
        r = c.post(f"/api/connectors/{sid}/sync", headers=ADMIN)
        assert r.status_code == 200, r.text
        s = r.json()["data"]["summary"]
        assert s["committed"] is True and s["create"] == 2, s
        assert s["linked"] == 1, s          # A→SUPX
        assert s["link_unresolved"] == 1, s  # B→MISSING

        items = _find(c, proj_id, a)
        assert len(items) == 1, items
        made = [i["id"] for i in _find(c, proj_id, "연계")]
        # 속성 저장 확인.
        aid = items[0]["id"]
        prof = c.get(f"/api/entities/{aid}/profile", headers=ADMIN).json()["data"]
        assert prof["entity"]["properties"].get("stage") == "active", prof["entity"]

        # 재동기화 — 멱등(둘 다 update, 신규 0).
        r = c.post(f"/api/connectors/{sid}/sync", headers=ADMIN)
        s = r.json()["data"]["summary"]
        assert s["create"] == 0 and s["update"] == 2, s

        # 이력 — done run 존재.
        runs = c.get(f"/api/connectors/{sid}/runs", headers=ADMIN).json()["data"]["items"]
        assert len(runs) >= 2 and runs[0]["status"] == "done", runs
    finally:
        for eid in made:
            rr = c.get(f"/api/entities/{eid}/relations", headers=ADMIN)
            if rr.status_code == 200:
                for p in rr.json()["data"]["parents"]:
                    c.delete(f"/api/entities/{eid}/relations/{p['relation_id']}", headers=ADMIN)
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)
        for it in (_find(c, sup_id, "SUPX-" + sfx) if sup_id else []):
            c.delete(f"/api/entities/{it['id']}", headers=ADMIN)
        if rel_created:
            c.delete(f"/api/relation-types/{rel}", headers=ADMIN)
        if proj_id:
            rp = c.get(f"/api/entity-types/{proj_id}/properties", headers=ADMIN)
            if rp.status_code == 200:
                for pd in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{proj_id}/properties/{pd['id']}", headers=ADMIN)
            c.delete(f"/api/entity-types/{proj_id}", headers=ADMIN)
        if sup_id:
            c.delete(f"/api/entity-types/{sup_id}", headers=ADMIN)


# --- AI 자동 매핑 (suggest) --------------------------------------------------
def _mk_axis_with_prop(c, sfx):
    tid = c.post("/api/entity-types", headers=ADMIN,
                 json={"slug": "sug_" + sfx, "label": "제안축",
                       "kind_class": "record"}).json()["data"]["id"]
    c.post(f"/api/entity-types/{tid}/properties", headers=ADMIN,
           json={"key": "stage", "label": "단계", "data_type": "text"})
    return tid


def test_suggest_heuristic_fallback(monkeypatch):
    """LLM 실패 → 휴리스틱 폴백. 필드명↔속성 매칭으로 채운다. (LLM 은 fake 로 차단해
    dev 의 죽은 백엔드에 실제로 붙지 않도록 한다.)"""
    def _boom(*a, **k):
        raise LLMError("no llm")

    monkeypatch.setattr(conn_suggest, "chat", _boom)
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = None
    try:
        tid = _mk_axis_with_prop(c, sfx)
        sample = {"name": "차세대 배터리", "stage": "설계", "supplier": {"name": "LG"}}
        r = c.post("/api/connectors/suggest-mapping", headers=ADMIN,
                   json={"target_type_id": tid, "sample": sample})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["source"] == "heuristic", d
        assert d["value_path"] == "name", d          # name-류 → 값
        assert d["property_map"].get("stage") == "stage", d  # 필드명==속성 slug
    finally:
        if tid:
            rp = c.get(f"/api/entity-types/{tid}/properties", headers=ADMIN)
            if rp.status_code == 200:
                for pd in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{tid}/properties/{pd['id']}", headers=ADMIN)
            c.delete(f"/api/entity-types/{tid}", headers=ADMIN)


def test_suggest_llm_with_validation(monkeypatch):
    """가짜 LLM(JSON) 주입 → source=llm + 환각(없는 경로/슬러그)은 검증에서 제거."""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = None
    try:
        tid = _mk_axis_with_prop(c, sfx)
        # LLM 이 title(존재)→값, stage→status(존재) 매핑 + 환각(ghost→nope) 섞어 답.
        fake_json = (
            '{"value_path": "title", '
            '"properties": {"stage": "status", "ghost": "nope"}, '
            '"relations": []}'
        )

        def fake_chat(messages, **kw):
            return ChatResult(content=fake_json, reasoning=None, model="x",
                              usage=None, backend="openai", raw={})

        monkeypatch.setattr(conn_suggest, "chat", fake_chat)
        sample = {"title": "P", "status": "active"}
        r = c.post("/api/connectors/suggest-mapping", headers=ADMIN,
                   json={"target_type_id": tid, "sample": sample})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["source"] == "llm", d
        assert d["value_path"] == "title", d
        assert d["property_map"] == {"stage": "status"}, d  # ghost/nope 제거됨
    finally:
        if tid:
            rp = c.get(f"/api/entity-types/{tid}/properties", headers=ADMIN)
            if rp.status_code == 200:
                for pd in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{tid}/properties/{pd['id']}", headers=ADMIN)
            c.delete(f"/api/entity-types/{tid}", headers=ADMIN)


def test_code_matching_dedup_on_rename(monkeypatch):
    """코드 매칭(L1') — 같은 코드인데 이름이 바뀌어 재동기화해도 중복 안 만들고 갱신."""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    proj_id = sid = None
    made = []
    try:
        proj_id = c.post("/api/entity-types", headers=ADMIN,
                         json={"slug": "cmproj_" + sfx, "label": "코드매칭과제",
                               "kind_class": "record"}).json()["data"]["id"]
        c.post(f"/api/entity-types/{proj_id}/properties", headers=ADMIN,
               json={"key": "stage", "label": "단계", "data_type": "text"})

        code = "PRJ-1-" + sfx
        state = {"recs": [{"id": code, "name": "원래이름-" + sfx, "stage": "active"}]}
        monkeypatch.setattr(conn_services, "fetch_records", lambda conn, st: state["recs"])

        cfg = {
            "connection": {"base_url": "http://x.test"},
            "streams": [{
                "endpoint_path": "/p", "records_path": "",
                "target_type_id": proj_id, "value_path": "name",
                "match_key": "code", "code_path": "id",
                "property_map": {"stage": "stage"},
            }],
        }
        sid = c.post("/api/connectors", headers=ADMIN,
                     json={"name": "cm-" + sfx, "config": cfg}).json()["data"]["id"]

        # 1차 — 생성.
        s = c.post(f"/api/connectors/{sid}/sync", headers=ADMIN).json()["data"]["summary"]
        assert s["create"] == 1, s
        made = [i["id"] for i in _find(c, proj_id, "원래이름")]
        assert len(made) == 1

        # 2차 — 같은 코드, 이름만 바뀜 → 갱신(중복 아님).
        state["recs"] = [{"id": code, "name": "새이름-" + sfx, "stage": "planned"}]
        s = c.post(f"/api/connectors/{sid}/sync", headers=ADMIN).json()["data"]["summary"]
        assert s["create"] == 0 and s["update"] == 1, s   # ← 핵심: 재동기화 중복 0

        # 총 1건 — 이름은 새 이름으로 바뀌고 옛 이름은 사라짐(중복 아님).
        assert len(_find(c, proj_id, "새이름")) == 1
        assert len(_find(c, proj_id, "원래이름")) == 0
        # 속성도 갱신.
        aid = made[0]
        prof = c.get(f"/api/entities/{aid}/profile", headers=ADMIN).json()["data"]
        assert prof["entity"]["properties"].get("stage") == "planned", prof["entity"]
    finally:
        for eid in made:
            e = c.get(f"/api/entities/{eid}/relations", headers=ADMIN)
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)
        if proj_id:
            rp = c.get(f"/api/entity-types/{proj_id}/properties", headers=ADMIN)
            if rp.status_code == 200:
                for pd in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{proj_id}/properties/{pd['id']}", headers=ADMIN)
            c.delete(f"/api/entity-types/{proj_id}", headers=ADMIN)


# --- v3 보안: 시크릿 암호화 + SSRF allowlist ---------------------------------
def test_secret_encrypted_at_rest():
    """시크릿은 DB 에 평문이 아니라 enc:v1: 로 암호화 저장되고, 복호하면 원본."""
    from app.database import SessionLocal
    from app.modules.connectors.crypto import decrypt_secret
    from app.modules.connectors.models import DataSource

    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    secret = "topsecret-" + sfx
    sid = None
    try:
        cfg = {
            "connection": {"base_url": "https://x.test",
                           "auth": {"type": "bearer", "token": secret}},
            "streams": [{"endpoint_path": "/x", "records_path": "d",
                         "target_type_id": 1, "value_path": "name"}],
        }
        sid = c.post("/api/connectors", headers=ADMIN,
                     json={"name": "enc-" + sfx, "config": cfg}).json()["data"]["id"]
        db = SessionLocal()
        try:
            stored = db.get(DataSource, sid).config["connection"]["auth"]["token"]
            assert stored.startswith("enc:v1:"), stored          # 평문 아님
            assert secret not in stored                          # 원문 노출 안 됨
            assert decrypt_secret(stored) == secret              # 복호 = 원본
        finally:
            db.close()
    finally:
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)


def test_allowlist_blocks_disallowed_host(monkeypatch):
    """CONNECTOR_ALLOWED_HOSTS 가 설정되면 그 밖의 호스트로는 못 나간다."""
    from app.config import settings
    from app.modules.connectors.fetch import FetchError, fetch_records
    from app.modules.connectors.schemas import ConnectionConfig, StreamConfig

    monkeypatch.setattr(settings, "connector_allowed_hosts", "allowed.example.com")
    conn = ConnectionConfig(base_url="http://blocked.example.com")
    st = StreamConfig(endpoint_path="/x", records_path="")
    try:
        fetch_records(conn, st)
        assert False, "차단됐어야 함"
    except FetchError as exc:
        assert "허용되지 않은" in str(exc), str(exc)
