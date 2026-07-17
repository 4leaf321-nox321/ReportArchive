"""system 객체 확장 — user/report 투영 + report 가시성 게이트 + FK 파생 관계.

가장 중요한 건 **보고서 가시성 유출 방지**: resolve_object(report)·derived 가 요청자가
볼 수 있는 보고서만 노출하고, actor 없음/권한 밖이면 존재 자체를 감춘다.
"""
from __future__ import annotations

from sqlalchemy import select

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services as ent
from app.modules.reports import services as rep_services
from app.modules.reports.models import Report
from app.modules.users.models import User

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}


def _some_report(db):
    """user 2 가 실제로 볼 수 있는 보고서 하나(가시성 게이트가 통과할 것)."""
    for rid in rep_services.all_visible_report_ids(db, 2):
        r = db.get(Report, rid)
        if r is not None and r.deleted_at is None:
            return r
    return None


def test_resolve_user_and_report_visibility_gate(monkeypatch):
    db = SessionLocal()
    try:
        r = _some_report(db)
        if r is None:
            return  # 보고서가 없으면 스킵(dev DB엔 있음)
        actor = db.get(User, 2)  # 시스템 관리자 — 전체 가시

        # user 해석 — 라벨=이름만, email 비노출.
        if r.owner_user_id:
            uref = ent.resolve_object(db, "user", str(r.owner_user_id), actor)
            assert uref and uref["type"] == "user" and uref["label"]
            assert "email" not in uref
            assert uref["url"] == f"/objects/user/{r.owner_user_id}"

        # report 해석 — admin 가시.
        rref = ent.resolve_object(db, "report", str(r.id), actor)
        assert rref and rref["label"] == r.title
        assert rref["url"] == f"/reports/{r.id}"

        # ★ 게이트 ① actor 없음 → None(유출 방지 기본값).
        assert ent.resolve_object(db, "report", str(r.id), None) is None

        # ★ 게이트 ② 안 보이는 보고서면 admin 이어도 None.
        monkeypatch.setattr(rep_services, "all_visible_report_ids", lambda db, uid: set())
        assert ent.resolve_object(db, "report", str(r.id), actor) is None
    finally:
        db.close()


def test_derived_links_report(monkeypatch):
    db = SessionLocal()
    try:
        r = _some_report(db)
        if r is None:
            return
        actor = db.get(User, 2)
        d = ent.derived_links_for(db, actor, "report", str(r.id))
        rels = {x["relation"] for x in d}
        # 작성자·게시부서는 FK 로 항상 파생(있으면).
        if r.owner_user_id:
            assert "authored_by" in rels, d
        if r.workspace_slug:
            assert "published_in" in rels, d
        # 각 항목은 해석된 object 를 가진다.
        assert all(x["object"] and x["object"].get("type") for x in d)

        # ★ 안 보이면 파생도 비어야(유출 방지).
        monkeypatch.setattr(rep_services, "all_visible_report_ids", lambda db, uid: set())
        assert ent.derived_links_for(db, actor, "report", str(r.id)) == []
    finally:
        db.close()


def test_objects_route_user_and_report():
    c = TestClient(app)
    db = SessionLocal()
    try:
        r = _some_report(db)
        owner = r.owner_user_id if r else None
    finally:
        db.close()
    if r is None:
        return
    # 라우트로 user/report 해석 (admin).
    if owner:
        ru = c.get(f"/api/objects/user/{owner}", headers=ADMIN)
        assert ru.status_code == 200, ru.text
        assert ru.json()["data"]["type"] == "user"
    rr = c.get(f"/api/objects/report/{r.id}/links", headers=ADMIN)
    assert rr.status_code == 200, rr.text
    data = rr.json()["data"]
    assert data["object"]["type"] == "report"
    assert "derived" in data  # 파생 관계 포함


# --------------------------------------------------------------------------- #
# AI/MCP 소비처 — 위 테스트들이 services 를 직접 불러서, agent_tools 가 actor 를 안
# 넘기는 결함(report 가 AI 에 통째로 안 보임)을 못 잡았다. 실제 소비 경로로 검증한다.
# --------------------------------------------------------------------------- #
def _tool(client, name, args, headers=ADMIN):
    res = client.post(
        "/api/ai/ontology/tool", json={"name": name, "args": args}, headers=headers
    )
    assert res.status_code == 200, res.text
    return res.json()["data"]


def test_agent_get_object_report_carries_derived_relations():
    """MCP 경로 get_object(report) 가 FK 파생 관계를 실어야(설계 §5.1)."""
    c = TestClient(app)
    db = SessionLocal()
    try:
        r = _some_report(db)
        if r is None:
            return
        rid, owner, ws = r.id, r.owner_user_id, r.workspace_slug
    finally:
        db.close()

    data = _tool(c, "get_object", {"type": "report", "id": str(rid)})
    assert "error" not in data, data
    assert data["type"] == "report" and data["kind"] == "system"
    # 속성 = reports 컬럼 투영(저장 0). report_date 는 non-nullable 이라 항상 있다.
    assert data.get("properties", {}).get("report_date"), data
    rels = {x["relation"] for x in data.get("relations", [])}
    if owner:
        assert "authored_by" in rels, data
    if ws:
        assert "published_in" in rels, data
    # 관계 상대는 이어서 get_object 할 수 있게 type·id 를 가진다(traversal).
    for x in data.get("relations", []):
        assert x["object"].get("type") and x["object"].get("id"), x


def test_agent_get_object_user_carries_derived_relations():
    """user 도 관계를 실어야 — resolve 는 되는데 관계가 비던 회귀 방지."""
    c = TestClient(app)
    db = SessionLocal()
    try:
        r = _some_report(db)
        owner = r.owner_user_id if r else None
    finally:
        db.close()
    if not owner:
        return
    data = _tool(c, "get_object", {"type": "user", "id": str(owner)})
    assert "error" not in data, data
    assert data["kind"] == "system"
    assert "relations" in data, data  # 껍데기(라벨만) 회귀 방지


def test_agent_get_object_report_visibility_gate(monkeypatch):
    """★ 유출 회귀 — AI 경로도 권한 밖 보고서는 존재 자체를 숨겨야."""
    c = TestClient(app)
    db = SessionLocal()
    try:
        r = _some_report(db)
        rid = r.id if r else None
    finally:
        db.close()
    if rid is None:
        return
    monkeypatch.setattr(rep_services, "all_visible_report_ids", lambda db, uid: set())
    data = _tool(c, "get_object", {"type": "report", "id": str(rid)})
    assert "error" in data, data
    assert str(rid) in data["error"]


def test_agent_get_object_shows_manual_object_links():
    """★ led_by(담당 PL)는 FK 에 없는 수동 링크 — AI 가 이걸 못 보면 스텝2 가 반쪽이다.

    엔티티 분기(entity_relations)도 system 분기(FK 파생)도 object_links 를 안 읽어서,
    사람 라우트엔 뜨는 담당 PL 이 AI 에는 안 보이던 회귀를 막는다. 양방향 다 본다.
    """
    import uuid as _uuid

    c = TestClient(app)
    sfx = _uuid.uuid4().hex[:8]
    types = c.get("/api/entity-types", headers=ADMIN).json()["data"]["items"]
    proj_axis = next((t["id"] for t in types if t["slug"] == "project"), None)
    assert proj_axis, "project 축 시드 누락"

    pid = link_id = None
    try:
        pid = c.post("/api/entities", headers=ADMIN,
                     json={"type_id": proj_axis, "value": "AI링크과제-" + sfx}).json()["data"]["id"]
        r = c.post(f"/api/entities/{pid}/object-links", headers=ADMIN,
                   json={"dst_type": "user", "dst_id": "2", "relation": "led_by"})
        assert r.status_code == 201, r.text
        link_id = [x for x in c.get(f"/api/entities/{pid}/object-links", headers=ADMIN)
                   .json()["data"]["items"] if x["relation"] == "led_by"][0]["link_id"]

        # 정방향 — 과제(entity) 에서 담당 PL 이 보여야.
        data = _tool(c, "get_object", {"type": "project", "id": str(pid)})
        led = [x for x in data.get("relations", []) if x["relation"] == "led_by"]
        assert led, f"led_by 가 AI 에 안 보임: {data}"
        assert led[0]["direction"] == "out"
        assert led[0]["object"]["type"] == "user" and led[0]["object"]["id"] == "2"

        # 역방향 — 사용자(system) 에서 담당 과제가 보여야.
        du = _tool(c, "get_object", {"type": "user", "id": "2"})
        back = [x for x in du.get("relations", [])
                if x["relation"] == "led_by" and x["direction"] == "in"]
        assert back, f"led_by 역방향이 user 에 안 보임: {du}"
        assert any(x["object"]["id"] == str(pid) for x in back), back
    finally:
        if pid and link_id:
            c.delete(f"/api/entities/{pid}/object-links/{link_id}", headers=ADMIN)
        if pid:
            c.delete(f"/api/entities/{pid}", headers=ADMIN)


def test_agent_search_objects_relation_filter_sees_object_links():
    """★ search_objects(relations=[led_by …]) — object_links 를 안 보면 항상 0건이고,
    LLM 은 그걸 "그런 과제 없습니다"로 읽는다. entity_relations 만 조인하던 회귀 방지."""
    import uuid as _uuid

    c = TestClient(app)
    sfx = _uuid.uuid4().hex[:8]
    types = c.get("/api/entity-types", headers=ADMIN).json()["data"]["items"]
    proj_axis = next((t["id"] for t in types if t["slug"] == "project"), None)
    assert proj_axis, "project 축 시드 누락"

    pid = link_id = None
    try:
        pid = c.post("/api/entities", headers=ADMIN,
                     json={"type_id": proj_axis, "value": "관계필터-" + sfx}).json()["data"]["id"]
        r = c.post(f"/api/entities/{pid}/object-links", headers=ADMIN,
                   json={"dst_type": "user", "dst_id": "2", "relation": "led_by"})
        assert r.status_code == 201, r.text
        link_id = [x for x in c.get(f"/api/entities/{pid}/object-links", headers=ADMIN)
                   .json()["data"]["items"] if x["relation"] == "led_by"][0]["link_id"]

        # 문자열·정수 둘 다 먹어야(ObjectRef id 는 varchar — 부서는 slug 라 정수 불가).
        for dst in ("2", 2):
            data = _tool(c, "search_objects",
                         {"type": "project", "relations": [{"relation": "led_by", "dst_id": dst}]})
            assert "error" not in data, data
            assert any(i["id"] == pid for i in data.get("items", [])), (dst, data)
    finally:
        if pid and link_id:
            c.delete(f"/api/entities/{pid}/object-links/{link_id}", headers=ADMIN)
        if pid:
            c.delete(f"/api/entities/{pid}", headers=ADMIN)


def test_agent_search_objects_props_require_type():
    """props 는 type 없이는 services 에서 조용히 버려진다 → 필터 안 걸린 전체 목록이
    그럴듯하게 돌아가 LLM 이 오답을 만든다. 타입 오류처럼 시끄럽게 실패해야."""
    c = TestClient(app)
    data = _tool(c, "search_objects",
                 {"props": [{"key": "status", "op": "eq", "value": "진행"}]})
    assert "error" in data, data
    assert "type" in data["error"]


def test_agent_hop_budget_caps_tool_fanout(monkeypatch):
    """★ max_hops 는 LLM 왕복만 묶는다 — 한 홉에 뱉은 tool_calls N개가 다 도는 걸
    막는 건 _MAX_TOOL_CALLS_PER_HOP. 초과분도 tool 응답은 채워야 프로토콜이 안 깨진다."""
    import types as _types

    from app.ai import agent as ag

    calls = {"n": 0}

    class _R:
        def __init__(self, tc, content=""):
            self.tool_calls = tc
            self.content = content

    def fake_chat(messages, tools=None):
        if tools and not any(m.get("role") == "tool" for m in messages):
            return _R([{"id": f"c{i}", "name": "list_object_types", "arguments": {}}
                       for i in range(30)])
        return _R([], "답변")

    def fake_run_tool(db, actor, name, args):
        calls["n"] += 1
        return {"content": {"ok": True}, "objects": [], "reports": []}

    monkeypatch.setattr(ag, "chat", fake_chat)
    monkeypatch.setattr(ag.agent_tools, "run_tool", fake_run_tool)

    db = SessionLocal()
    try:
        actor = _types.SimpleNamespace(user=db.get(User, 2))
        out = ag.run_agent(db, actor, "폭주 테스트")
    finally:
        db.close()
    assert calls["n"] <= ag._MAX_TOOL_CALLS_PER_HOP, calls
    assert out.get("answer") == "답변"  # 예산 초과해도 루프가 정상 종료돼야


def test_mcp_whitelist_search_reports_takes_filters():
    """search_reports 를 화이트리스트에 넣어 외부 AI 도 내부판(필터 10개·이름 해석)을
    쓰게 통일. MCP 자체 도구는 q·limit 만 넘겨 날짜·종류·작성자 필터가 없었다.

    필터가 실제로 SQL 에 걸리는지 phase 로 검증(값에 따라 결과 수가 갈려야).
    """
    c = TestClient(app)
    base = _tool(c, "search_reports", {"query": "보고"})
    assert "error" not in base, base

    fin = _tool(c, "search_reports", {"query": "보고", "phase": "finalized"})
    dr = _tool(c, "search_reports", {"query": "보고", "phase": "drafting"})
    assert "error" not in fin and "error" not in dr
    # 두 단계 합이 전체 이하 + 서로 달라야 필터가 실제 동작(같으면 필터 무시 의심).
    assert fin["count"] <= base["count"] and dr["count"] <= base["count"]
    assert (fin["count"], dr["count"]) != (base["count"], base["count"]) or base["count"] == 0

    # query 는 필수.
    err = _tool(c, "search_reports", {"author": "박세현"})
    assert "error" in err and "query" in err["error"]


def test_mcp_whitelist_exposes_aggregate_but_not_writes():
    """aggregate_reports = 개수를 SQL 로 세는 유일한 도구. 외부 AI 가 못 쓰면
    search_reports 를 손으로 세다 환각한다(그 방지가 이 도구의 존재 이유).

    화이트리스트 게이트 기준: ① 생성 LLM 미호출(chat 은 _extract=maybe_answer 전용이라
    aggregate 경로엔 없음) ② 가시성 게이팅(_base_reports → all_visible_report_ids).
    ★ 개수가 요청자별 가시 집합과 정확히 같아야 — 전체를 세면 유출이다.
    """
    c = TestClient(app)
    db = SessionLocal()
    try:
        expected = len(rep_services.all_visible_report_ids(db, 2))
    finally:
        db.close()

    data = _tool(c, "aggregate_reports",
                 {"filters": [], "target": "report", "last_days": 36500})
    assert "error" not in data, data
    assert data["count"] == expected, (data.get("count"), expected)

    # 쓰기 계열은 절대 노출 안 됨(create/update/delete 는 화이트리스트 밖 = 404).
    # (search_reports 는 2026-07-18 화이트리스트에 편입 — 더 이상 404 아님.)
    for name in ("create_entity", "update_entity", "delete_entity", "merge_entities"):
        r = c.post("/api/ai/ontology/tool", json={"name": name, "args": {}}, headers=ADMIN)
        assert r.status_code == 404, (name, r.status_code)


def test_agent_get_subgraph_matches_route_and_gates_seed():
    """★ 내부 에이전트 get_subgraph — 라우트(/graph)와 같은 조립을 재사용해야(공용
    services.augment_graph_object_links). system 객체 seed 는 거절(엔티티만 노드).

    내부 전용 도구라 화이트리스트(/ontology/tool)엔 없다 — run_tool 로 직접 검증한다.
    """
    import types as _types

    from app.ai import agent_tools

    c = TestClient(app)
    db = SessionLocal()
    try:
        actor = _types.SimpleNamespace(user=db.get(User, 2))
        # 아무 엔티티나 seed 로.
        rows, _ = ent.search_entities(db, limit=1)
        seed = rows[0].id if rows else None
        if seed is None:
            return  # dev DB 에 엔티티 없음

        res = agent_tools.run_tool(db, actor, "get_subgraph", {"entity_id": seed})
        data = res.get("content", {})
        assert "error" not in data, data
        assert data["seed"] == seed
        assert data["depth"] <= 2  # 상한 클램프
        assert any(n["id"] == seed for n in data["nodes"]), data

        # depth 상한 클램프 — 큰 값을 줘도 2 이하.
        big = agent_tools.run_tool(
            db, actor, "get_subgraph", {"entity_id": seed, "depth": 9}
        ).get("content", {})
        assert big["depth"] <= 2, big

        # 없는 엔티티(=system 객체를 정수로 착각한 경우 등) → 안내 에러.
        err = agent_tools.run_tool(
            db, actor, "get_subgraph", {"entity_id": 999_999_999}
        ).get("content", {})
        assert "error" in err, err
    finally:
        db.close()

    # 라우트와 노드 수 일치(같은 seed·depth, 상한 미만이면 동일).
    if not data.get("truncated"):
        rr = c.get(f"/api/entities/{seed}/graph", params={"depth": data["depth"]},
                   headers=ADMIN).json()["data"]
        assert len(rr["nodes"]) == data["node_count"], (len(rr["nodes"]), data["node_count"])


def test_agent_search_objects_rejects_system_types():
    """system 축은 값 행이 없어 0건 — 빈 배열은 '없다'는 오독을 부르므로 길 안내."""
    c = TestClient(app)
    for slug in ("report", "user", "dept"):
        data = _tool(c, "search_objects", {"type": slug, "limit": 5})
        assert "error" in data, (slug, data)
        assert "search_reports" in data["error"] or "get_object" in data["error"]
    # 일반 축은 정상 검색(과잉 차단 아님).
    ok = _tool(c, "search_objects", {"limit": 1})
    assert "error" not in ok and "items" in ok, ok


def test_led_by_object_link():
    """스텝2 수동 관계 — 과제(project) → 담당 PL(user) object_link 생성·조회."""
    import uuid as _uuid

    c = TestClient(app)
    sfx = _uuid.uuid4().hex[:8]
    # project 축 id.
    types = c.get("/api/entity-types", headers=ADMIN).json()["data"]["items"]
    proj_axis = next((t["id"] for t in types if t["slug"] == "project"), None)
    assert proj_axis, "project 축 시드 누락"

    pid = link_id = None
    try:
        pid = c.post("/api/entities", headers=ADMIN,
                     json={"type_id": proj_axis, "value": "PL과제-" + sfx}).json()["data"]["id"]
        # led_by → user 2 (담당 PL).
        r = c.post(f"/api/entities/{pid}/object-links", headers=ADMIN,
                   json={"dst_type": "user", "dst_id": "2", "relation": "led_by"})
        assert r.status_code == 201, r.text
        # 조회 — led_by → user 링크가 뜬다.
        items = c.get(f"/api/entities/{pid}/object-links", headers=ADMIN).json()["data"]["items"]
        led = [x for x in items if x["relation"] == "led_by"]
        assert led and led[0]["target"]["type"] == "user", items
        link_id = led[0]["link_id"]
        # 축 제약 위반 — led_by 대상은 user 여야(dept 는 거부).
        bad = c.post(f"/api/entities/{pid}/object-links", headers=ADMIN,
                     json={"dst_type": "dept", "dst_id": "dx", "relation": "led_by"})
        assert bad.status_code == 400, bad.text
    finally:
        if pid and link_id:
            c.delete(f"/api/entities/{pid}/object-links/{link_id}", headers=ADMIN)
        if pid:
            c.delete(f"/api/entities/{pid}", headers=ADMIN)
