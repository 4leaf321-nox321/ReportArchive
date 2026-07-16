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


def test_probe_fills_stored_secret_when_source_id(monkeypatch):
    """저장된 소스를 편집 중이면(source_id), 마스킹된 빈 토큰을 서버가 저장분으로
    채워 프로브한다 — 다른 화면 갔다 와도 토큰 재입력 불필요. 단, 사용자가 새 값을
    입력했으면 그게 우선."""
    from app.modules.connectors import services as S

    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    sid = None
    try:
        cfg = {
            "connection": {"base_url": "https://example.test",
                           "auth": {"type": "bearer", "token": "storedtok"}},
            "streams": [{"endpoint_path": "/x", "records_path": "d",
                         "target_type_id": 1, "value_path": "name"}],
        }
        r = c.post("/api/connectors", headers=ADMIN,
                   json={"name": "src-" + sfx, "kind": "rest_json", "config": cfg})
        sid = r.json()["data"]["id"]

        captured = {}

        def fake_probe(conn, stream):
            captured["token"] = conn.auth.token
            return {"record_count": 0, "fields": [], "sample": []}

        monkeypatch.setattr(S, "probe_stream", fake_probe)
        stream = {"endpoint_path": "/x", "records_path": "d",
                  "target_type_id": 1, "value_path": "name"}

        # 마스킹된(빈) 토큰 + source_id → 저장분("storedtok")으로 채워짐.
        r = c.post("/api/connectors/probe", headers=ADMIN, json={
            "connection": {"base_url": "https://example.test",
                           "auth": {"type": "bearer", "token": ""}},
            "stream": stream, "source_id": sid})
        assert r.status_code == 200, r.text
        assert captured["token"] == "storedtok"

        # 사용자가 새 토큰 입력 → 그게 우선(저장분으로 안 덮음).
        r = c.post("/api/connectors/probe", headers=ADMIN, json={
            "connection": {"base_url": "https://example.test",
                           "auth": {"type": "bearer", "token": "newtok"}},
            "stream": stream, "source_id": sid})
        assert r.status_code == 200, r.text
        assert captured["token"] == "newtok"
    finally:
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)


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
        monkeypatch.setattr(conn_services, "fetch_records", lambda conn, st, since=None: records)

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
        monkeypatch.setattr(conn_services, "fetch_records", lambda conn, st, since=None: state["recs"])

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


# --- v3 규모/운영: 페이지네이션 · 증분 · 실패 알림 ---------------------------
def test_pagination_offset(monkeypatch):
    """offset 페이지네이션 — 짧은 페이지에서 종료, 전 페이지 누적."""
    from app.modules.connectors import fetch as F
    from app.modules.connectors.schemas import ConnectionConfig, StreamConfig

    pages = {0: [{"id": i} for i in range(100)], 100: [{"id": i} for i in range(100, 150)]}

    def fake_req(client, method, url, headers, params, basic):
        # offset 루프는 _request_json_partial 을 쓴다 → (payload, error) 반환.
        return {"items": pages.get(params.get("offset", 0), [])}, None

    monkeypatch.setattr(F, "_request_json_partial", fake_req)
    conn = ConnectionConfig(base_url="http://x.test")
    st = StreamConfig(endpoint_path="/p", records_path="items", page_style="offset",
                      page_size=100, page_param="offset", size_param="limit")
    recs = F.fetch_records(conn, st)
    assert len(recs) == 150, len(recs)  # 100 + 50(짧은 페이지) → 종료


def test_incremental_watermark(monkeypatch):
    """증분 — since 로 마지막 이후만 요청, watermark 최댓값을 sync_state 에 저장·전진."""
    from app.database import SessionLocal
    from app.modules.connectors.models import DataSource

    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    proj_id = sid = None
    made = []
    captured = {"since": []}
    try:
        proj_id = c.post("/api/entity-types", headers=ADMIN,
                         json={"slug": "incp_" + sfx, "label": "증분과제",
                               "kind_class": "record"}).json()["data"]["id"]
        state = {"recs": [{"name": "A-" + sfx, "u": "2024-01-01"},
                          {"name": "B-" + sfx, "u": "2024-03-01"}]}

        def fake(conn, st, since=None):
            captured["since"].append(since)
            return state["recs"]

        monkeypatch.setattr(conn_services, "fetch_records", fake)
        cfg = {
            "connection": {"base_url": "http://x.test"},
            "streams": [{"endpoint_path": "/p", "records_path": "",
                         "target_type_id": proj_id, "value_path": "name",
                         "incremental": True, "watermark_field": "u",
                         "watermark_param": "since"}],
        }
        sid = c.post("/api/connectors", headers=ADMIN,
                     json={"name": "inc-" + sfx, "config": cfg}).json()["data"]["id"]

        # 1차 — since 없음, watermark 최댓값 저장.
        c.post(f"/api/connectors/{sid}/sync", headers=ADMIN)
        assert captured["since"][-1] is None
        db = SessionLocal()
        try:
            assert db.get(DataSource, sid).sync_state.get("0") == "2024-03-01"
        finally:
            db.close()
        made = [i["id"] for i in _find(c, proj_id, sfx)]

        # 2차 — 저장된 watermark 를 since 로 전달, 새 최댓값으로 전진.
        state["recs"] = [{"name": "C-" + sfx, "u": "2024-04-01"}]
        c.post(f"/api/connectors/{sid}/sync", headers=ADMIN)
        assert captured["since"][-1] == "2024-03-01"
        db = SessionLocal()
        try:
            assert db.get(DataSource, sid).sync_state.get("0") == "2024-04-01"
        finally:
            db.close()
        made = [i["id"] for i in _find(c, proj_id, sfx)]
    finally:
        for eid in made:
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)
        if proj_id:
            c.delete(f"/api/entity-types/{proj_id}", headers=ADMIN)


def test_failure_alert_only_on_transition(monkeypatch):
    """실패 알림 — 실패 전이(직전 ok→실패)에만 발송, 지속 실패는 재발송 안 함."""
    from app.database import SessionLocal
    from app.mailer import service as mailer
    from app.modules.connectors import services as cs
    from app.modules.connectors.models import DataSource
    from app.modules.connectors.schemas import DataSourceCreate

    sent = []
    monkeypatch.setattr(mailer, "is_active", lambda: True)
    monkeypatch.setattr(mailer, "enqueue_email", lambda *a, **k: sent.append(k) or 1)

    db = SessionLocal()
    sfx = uuid.uuid4().hex[:8]
    src = None
    try:
        src = cs.create_source(db, DataSourceCreate(
            name="falert-" + sfx, kind="rest_json",
            config={"connection": {"base_url": "http://x.test"},
                    "streams": [{"endpoint_path": "/p", "target_type_id": 1, "value_path": "n"}]}),
            user_id=2)
        failed = {"streams": [{"label": "s", "target_type_id": 1, "error": "boom"}]}
        ok = {"streams": [{"label": "s", "target_type_id": 1, "summary": {}}]}

        # 전이(직전 done → 실패) → 발송.
        assert cs.maybe_alert_sync_failure(db, src, failed, prior_status="done") is True
        assert len(sent) == 1
        # 지속(직전 이미 실패) → 발송 안 함.
        assert cs.maybe_alert_sync_failure(db, src, failed, prior_status="failed") is False
        # 실패 없음 → 발송 안 함.
        assert cs.maybe_alert_sync_failure(db, src, ok, prior_status="done") is False
        assert len(sent) == 1
    finally:
        if src:
            obj = db.get(DataSource, src.id)
            if obj:
                cs.delete_source(db, obj)
        db.close()


# --- v3.1 OData: nextLink 따라가기 + $filter 증분 -----------------------------
def test_next_url_pagination_odata(monkeypatch):
    """OData @odata.nextLink 따라가기 — 통짜 URL을 이어 요청, 없으면 종료."""
    from app.modules.connectors import fetch as F
    from app.modules.connectors.schemas import ConnectionConfig, StreamConfig

    page1 = {"value": [{"id": i} for i in range(100)],
             "@odata.nextLink": "http://x.test/svc/Projects?$skip=100"}
    page2 = {"value": [{"id": i} for i in range(100, 150)]}  # nextLink 없음 → 종료
    seq = {"n": 0}

    def fake_req(client, method, url, headers, params, basic):
        seq["n"] += 1
        return page1 if seq["n"] == 1 else page2

    monkeypatch.setattr(F, "_request_json", fake_req)
    conn = ConnectionConfig(base_url="http://x.test")
    st = StreamConfig(endpoint_path="/svc/Projects", records_path="value",
                      page_style="next_url", next_url_path="@odata.nextLink")
    recs = F.fetch_records(conn, st)
    assert len(recs) == 150, len(recs)
    assert seq["n"] == 2  # 두 번 요청


def test_watermark_filter_template_odata(monkeypatch):
    """OData $filter 증분 — since 를 식 템플릿에 넣어 파라미터로."""
    from app.modules.connectors import fetch as F
    from app.modules.connectors.schemas import ConnectionConfig, StreamConfig

    captured = {}

    def fake_req(client, method, url, headers, params, basic):
        captured["params"] = params
        return {"value": []}

    monkeypatch.setattr(F, "_request_json", fake_req)
    conn = ConnectionConfig(base_url="http://x.test")
    st = StreamConfig(endpoint_path="/svc/Projects", records_path="value",
                      incremental=True, watermark_field="Modified",
                      watermark_param="$filter",
                      watermark_template="Modified gt {since}")
    F.fetch_records(conn, st, since="2024-03-01T00:00:00Z")
    assert captured["params"]["$filter"] == "Modified gt 2024-03-01T00:00:00Z", captured


def test_relation_target_code_matching(monkeypatch):
    """관계 대상 코드 매칭 — 대상 이름이 달라도 코드가 같으면 링크된다."""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    proj_id = sup_id = sid = None
    rel = "rtc_" + sfx
    rel_created = False
    made = []
    try:
        proj_id = c.post("/api/entity-types", headers=ADMIN,
                         json={"slug": "rtcp_" + sfx, "label": "관계과제",
                               "kind_class": "record"}).json()["data"]["id"]
        sup_id = c.post("/api/entity-types", headers=ADMIN,
                        json={"slug": "rtcs_" + sfx, "label": "관계공급사",
                              "kind_class": "record"}).json()["data"]["id"]
        c.post("/api/relation-types", headers=ADMIN,
               json={"slug": rel, "label": "관계공급", "directed": True})
        rel_created = True
        # 공급사: 이름="LG에너지솔루션", 코드="SUP-A".
        c.post("/api/entities", headers=ADMIN,
               json={"type_id": sup_id, "value": "LG에너지솔루션-" + sfx, "code": "SUP-A-" + sfx})

        # 과제 레코드의 supplier.name 은 다르게("엘지에너지"), code 는 SUP-A.
        records = [{"name": "과제A-" + sfx,
                    "supplier": {"code": "SUP-A-" + sfx, "name": "엘지에너지-" + sfx}}]
        monkeypatch.setattr(conn_services, "fetch_records", lambda conn, st, since=None: records)

        cfg = {
            "connection": {"base_url": "http://x.test"},
            "streams": [{"endpoint_path": "/p", "records_path": "",
                         "target_type_id": proj_id, "value_path": "name",
                         "relation_map": [{"relation": rel, "target_type": "rtcs_" + sfx,
                                           "path": "supplier.code", "match_key": "code"}]}],
        }
        sid = c.post("/api/connectors", headers=ADMIN,
                     json={"name": "rtc-" + sfx, "config": cfg}).json()["data"]["id"]

        s = c.post(f"/api/connectors/{sid}/sync", headers=ADMIN).json()["data"]["summary"]
        # 이름이 달라도 코드로 대상을 찾아 링크됨.
        assert s["create"] == 1 and s["linked"] == 1, s
        assert s["link_unresolved"] == 0, s
        made = [i["id"] for i in _find(c, proj_id, "과제A")]
    finally:
        for eid in made:
            rr = c.get(f"/api/entities/{eid}/relations", headers=ADMIN)
            if rr.status_code == 200:
                for p in rr.json()["data"]["parents"]:
                    c.delete(f"/api/entities/{eid}/relations/{p['relation_id']}", headers=ADMIN)
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)
        for it in (_find(c, sup_id, "LG에너지솔루션") if sup_id else []):
            c.delete(f"/api/entities/{it['id']}", headers=ADMIN)
        if rel_created:
            c.delete(f"/api/relation-types/{rel}", headers=ADMIN)
        if proj_id:
            c.delete(f"/api/entity-types/{proj_id}", headers=ADMIN)
        if sup_id:
            c.delete(f"/api/entity-types/{sup_id}", headers=ADMIN)


def test_provenance_tagging(monkeypatch):
    """계보 — 동기화가 채운 객체에 출처(소스) 태깅, 재동기화는 중복 없이 갱신."""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    proj_id = sid = None
    made = []
    try:
        proj_id = c.post("/api/entity-types", headers=ADMIN,
                         json={"slug": "provp_" + sfx, "label": "계보과제",
                               "kind_class": "record"}).json()["data"]["id"]
        records = [{"name": "과제A-" + sfx}, {"name": "과제B-" + sfx}]
        monkeypatch.setattr(conn_services, "fetch_records", lambda conn, st, since=None: records)
        cfg = {"connection": {"base_url": "http://x.test"},
               "streams": [{"endpoint_path": "/p", "records_path": "",
                            "target_type_id": proj_id, "value_path": "name"}]}
        sid = c.post("/api/connectors", headers=ADMIN,
                     json={"name": "prov-" + sfx, "config": cfg}).json()["data"]["id"]

        c.post(f"/api/connectors/{sid}/sync", headers=ADMIN)
        made = [i["id"] for i in _find(c, proj_id, "과제")]
        aid = made[0]

        r = c.get(f"/api/connectors/objects/{aid}/provenance", headers=ADMIN)
        assert r.status_code == 200, r.text
        items = r.json()["data"]["items"]
        assert len(items) == 1, items
        assert items[0]["source_name"] == "prov-" + sfx
        assert items[0]["data_source_id"] == sid
        first_seen = items[0]["first_seen"]

        # 재동기화 — 중복 없이 upsert(first_seen 유지).
        c.post(f"/api/connectors/{sid}/sync", headers=ADMIN)
        items2 = c.get(f"/api/connectors/objects/{aid}/provenance", headers=ADMIN).json()["data"]["items"]
        assert len(items2) == 1, items2  # 중복 없음
        assert items2[0]["first_seen"] == first_seen  # 최초 유입 시각 유지
    finally:
        for eid in made:
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        if sid:
            c.delete(f"/api/connectors/{sid}", headers=ADMIN)
        if proj_id:
            c.delete(f"/api/entity-types/{proj_id}", headers=ADMIN)


def test_suggest_sees_nested_path_null_in_first_record(monkeypatch):
    """앞 레코드에서 null 인 navigation 의 하위 경로도 AI 매핑 후보가 된다.

    실제 SPDM 케이스 — $expand=product 인데 앞쪽 모델들은 product 가 null 이라,
    1건만 보내던 예전 방식에선 product.* 를 아예 못 봐서 제안이 불가능했다.
    """
    def _boom(*a, **k):
        raise LLMError("no llm")

    monkeypatch.setattr(conn_suggest, "chat", _boom)
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = None
    try:
        tid = _mk_axis_with_prop(c, sfx)
        samples = [
            {"name": "M0", "product": None},
            {"name": "M1", "product": None},
            {"name": "M2", "product": {"stage": "양산"}},  # 여기서만 값이 있음
        ]
        r = c.post("/api/connectors/suggest-mapping", headers=ADMIN,
                   json={"target_type_id": tid, "samples": samples,
                         "fields": ["name", "product.stage"]})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        # 3번째 레코드에만 있던 product.stage 를 속성 stage 에 매핑해낸다.
        assert d["property_map"].get("stage") == "product.stage", d
        assert d["value_path"] == "name", d
    finally:
        if tid:
            rp = c.get(f"/api/entity-types/{tid}/properties", headers=ADMIN)
            if rp.status_code == 200:
                for pd in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{tid}/properties/{pd['id']}", headers=ADMIN)
            c.delete(f"/api/entity-types/{tid}", headers=ADMIN)


def test_suggest_legacy_single_sample_still_works(monkeypatch):
    """구버전 호출(sample 1건)도 그대로 — 프론트 배포 전 요청이 깨지지 않게."""
    def _boom(*a, **k):
        raise LLMError("no llm")

    monkeypatch.setattr(conn_suggest, "chat", _boom)
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = None
    try:
        tid = _mk_axis_with_prop(c, sfx)
        r = c.post("/api/connectors/suggest-mapping", headers=ADMIN,
                   json={"target_type_id": tid,
                         "sample": {"name": "M", "stage": "설계"}})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["property_map"].get("stage") == "stage"
    finally:
        if tid:
            rp = c.get(f"/api/entity-types/{tid}/properties", headers=ADMIN)
            if rp.status_code == 200:
                for pd in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{tid}/properties/{pd['id']}", headers=ADMIN)
            c.delete(f"/api/entity-types/{tid}", headers=ADMIN)
