"""관계도 스코프(board/subtree) + 외부 연결 토글 — 새 파라미터 스모크.

부서 관계도가 "이 게시판/하위 게시분"을 primary 로, include_external 시 그와
연결된 스코프 밖 보고서를 is_out_of_scope 노드로 더한다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token


def _h(slug="dx"):
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": slug}


def test_link_graph_accepts_scope_and_external_params():
    client = TestClient(app)
    for qs in [
        "",
        "scope=board",
        "scope=subtree",
        "scope=board&include_external=true",
        "scope=subtree&include_external=true&include_isolated=true",
    ]:
        url = "/api/reports/link-graph" + (f"?{qs}" if qs else "")
        r = client.get(url, headers=_h())
        assert r.status_code == 200, (qs, r.text)
        data = r.json()["data"]
        assert "nodes" in data and "edges" in data
        # 보고서 노드는 is_out_of_scope 플래그를 갖는다.
        for n in data["nodes"]:
            if n.get("type") == "report":
                assert "is_out_of_scope" in n
                assert "is_external_public" in n


def test_link_graph_board_scope_subset_of_subtree():
    """board 스코프 노드 집합 ⊆ subtree 스코프(하위 롤업) 노드 집합."""
    client = TestClient(app)

    def report_ids(qs):
        r = client.get(f"/api/reports/link-graph?{qs}", headers=_h())
        assert r.status_code == 200, r.text
        return {
            n["report_id"]
            for n in r.json()["data"]["nodes"]
            if n.get("type") == "report"
        }

    board = report_ids("scope=board&include_isolated=true")
    subtree = report_ids("scope=subtree&include_isolated=true")
    assert board <= subtree


def test_metadata_connected_reports_not_isolated():
    """공유 메타 허브(entity/종합보고)로 이어진 보고서는 고립이 아니다.

    고립 토글이 꺼져 있어도 그런 보고서는 노드로 나와야 하고(화면상 연결),
    레이어 엣지가 달린 보고서 노드의 degree 는 0 이면 안 된다(점=고립으로
    그려지지 않게).
    """
    client = TestClient(app)
    for qs in [
        "include_tags=true&tag_min_degree=2",
        "include_tags=true&tag_min_degree=2&include_composites=true",
    ]:
        r = client.get(f"/api/reports/link-graph?{qs}", headers=_h())
        assert r.status_code == 200, (qs, r.text)
        data = r.json()["data"]
        reports = {
            n["id"]: n for n in data["nodes"] if n.get("type") == "report"
        }
        # 레이어 엣지(report↔entity / composite↔report)가 닿는 보고서 모음.
        layer_reps: set[str] = set()
        for e in data["edges"]:
            if e.get("kind") in ("has_tag", "composite_member"):
                for ep in (e["source"], e["target"]):
                    if ep.startswith("report:"):
                        layer_reps.add(ep)
        for rid in layer_reps:
            # 메타로 연결돼 그려진 보고서는 노드로 존재하고 degree>0.
            assert rid in reports, (qs, rid)
            assert (reports[rid].get("degree") or 0) > 0, (qs, rid)


def test_date_filter_targets_reports_not_metadata():
    """기간 필터는 보고서 노드 표시만 좁히고, 관련정보(메타) 연결은 녹이지 않는다.

    - 표시되는 보고서 노드는 모두 기간 안.
    - 기간을 좁혀도 메타 엣지가 닿는 보고서는 여전히 degree>0(고립 아님) — 허브
      degree 는 기간 무관 전체 기준이라, 짝이 기간 밖이어도 연결이 유지된다.
    """
    client = TestClient(app)

    def graph(qs):
        r = client.get(f"/api/reports/link-graph?{qs}", headers=_h())
        assert r.status_code == 200, (qs, r.text)
        return r.json()["data"]

    base = "include_tags=true&tag_min_degree=2&include_isolated=true"
    full = graph(base)
    dates = sorted(
        n["report_date"]
        for n in full["nodes"]
        if n.get("type") == "report" and n.get("report_date")
    )
    if len(dates) < 2:
        return  # 데이터가 부족하면 스모크 스킵
    mid = dates[len(dates) // 2]
    end = dates[-1]
    data = graph(f"{base}&date_from={mid}&date_to={end}")
    reports = {n["id"]: n for n in data["nodes"] if n.get("type") == "report"}
    # 표시 보고서는 모두 기간 안.
    for n in reports.values():
        rd = n.get("report_date")
        assert rd is None or (mid <= rd <= end), (rd, mid, end)
    # 메타 엣지가 닿는 보고서는 degree>0(메타 연결 유지).
    for e in data["edges"]:
        if e.get("kind") in ("has_tag", "composite_member"):
            for ep in (e["source"], e["target"]):
                if ep.startswith("report:"):
                    assert ep in reports
                    assert (reports[ep].get("degree") or 0) > 0, ep
