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
