"""외부 시스템 연계 — 진짜 end-to-end (monkeypatch 없이 실제 httpx fetch).

scripts/sample_external_api 의 데모 서버를 임의 포트로 띄우고, 커넥터가 **실제
네트워크로** 그 API 를 때려 온톨로지를 채우는 전 경로를 검증한다:
  1) 공급사 소스 동기화 → 공급사 객체 생성.
  2) 과제 소스 동기화 → 과제 객체 생성 + supplier.code 로 공급사에 관계 링크.
단위 테스트(test_connectors.py)가 fetch 를 monkeypatch 했던 것과 달리, 여기선 fetch_records
가 실제로 도는 걸 확인한다(127.0.0.1 은 fetch 의 스킴 검사만 통과 — 사설 IP 가드 없음).
"""
from __future__ import annotations

import importlib.util
import os
import threading
import uuid
from http.server import ThreadingHTTPServer

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}

# scripts/sample_external_api.py 를 파일 경로로 로드(패키지 아님).
_SAMPLE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "scripts", "sample_external_api.py"
)
_spec = importlib.util.spec_from_file_location("sample_external_api", _SAMPLE_PATH)
sample = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sample)


def _find(c, type_id, q):
    r = c.post("/api/entities/search", headers=ADMIN, json={"type_id": type_id, "q": q})
    return r.json()["data"]["items"]


def test_end_to_end_real_fetch():
    # 임의 포트로 데모 API 기동(데몬 스레드).
    server = ThreadingHTTPServer(("127.0.0.1", 0), sample.Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    base = f"http://127.0.0.1:{port}"
    proj_id = sup_id = src = None
    rel = "e2e_supplied_" + sfx
    rel_created = False
    made = []
    try:
        # 축: 과제(record + status 속성) + 공급사(record) + 관계타입.
        proj_id = c.post("/api/entity-types", headers=ADMIN,
                         json={"slug": "e2eproj_" + sfx, "label": "E2E과제",
                               "kind_class": "record"}).json()["data"]["id"]
        c.post(f"/api/entity-types/{proj_id}/properties", headers=ADMIN,
               json={"key": "status", "label": "상태", "data_type": "text"})
        sup_id = c.post("/api/entity-types", headers=ADMIN,
                        json={"slug": "e2esup_" + sfx, "label": "E2E공급사",
                              "kind_class": "record"}).json()["data"]["id"]
        c.post("/api/relation-types", headers=ADMIN,
               json={"slug": rel, "label": "E2E공급", "directed": True})
        rel_created = True

        # 한 커넥션 + 스트림 2개(공급사 먼저 → 과제). 동기화 한 번에 두 축을 채운다.
        # 스트림 순서 덕에 과제의 supplier.name 관계가 방금 만든 공급사를 찾아 링크된다.
        src = c.post("/api/connectors", headers=ADMIN, json={
            "name": "e2e-plm-" + sfx,
            "config": {
                "connection": {"base_url": base},
                "streams": [
                    {"label": "공급사", "endpoint_path": "/api/suppliers",
                     "records_path": "data.items",
                     "target_type_id": sup_id, "value_path": "name"},
                    {"label": "과제", "endpoint_path": "/api/projects",
                     "records_path": "data.items",
                     "target_type_id": proj_id, "value_path": "name",
                     "property_map": {"status": "status"},
                     # 공급사는 value=name 이라 supplier.name 으로 매칭(값 매칭).
                     # (code 로 잇는 편이 견고 — L1' 코드 매칭 필요성. v1.1)
                     "relation_map": [{"relation": rel, "target_type": "e2esup_" + sfx,
                                       "path": "supplier.name"}]},
                ],
            },
        }).json()["data"]["id"]

        # 미리보기(dry_run) — 두 스트림 합쳐 6건 생성 예정, 쓰기 없음.
        r = c.post(f"/api/connectors/{src}/preview", headers=ADMIN)
        assert r.status_code == 200, r.text
        assert r.json()["data"]["summary"]["create"] == 6, r.json()["data"]["summary"]
        assert len(r.json()["data"]["streams"]) == 2

        # 실제 동기화 한 번 — 공급사 3 + 과제 3 생성, 과제 3건 공급사에 링크.
        r = c.post(f"/api/connectors/{src}/sync", headers=ADMIN)
        assert r.status_code == 200, r.text
        s = r.json()["data"]["summary"]
        assert s["create"] == 6, s
        assert s["linked"] == 3, s   # 과제 3건 모두 공급사에 링크
        assert s["streams"] == 2, s
        assert len(_find(c, sup_id, "LG에너지솔루션")) == 1
        made = [i["id"] for i in _find(c, proj_id, "")]
        items = _find(c, proj_id, "차세대 배터리 개발")
        assert len(items) == 1, items
        aid = items[0]["id"]
        prof = c.get(f"/api/entities/{aid}/profile", headers=ADMIN).json()["data"]
        assert prof["entity"]["properties"].get("status") == "진행중", prof["entity"]
    finally:
        server.shutdown()
        for eid in made + [i["id"] for i in (_find(c, sup_id, "") if sup_id else [])]:
            rr = c.get(f"/api/entities/{eid}/relations", headers=ADMIN)
            if rr.status_code == 200:
                for p in rr.json()["data"]["parents"]:
                    c.delete(f"/api/entities/{eid}/relations/{p['relation_id']}", headers=ADMIN)
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        if src:
            c.delete(f"/api/connectors/{src}", headers=ADMIN)
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
