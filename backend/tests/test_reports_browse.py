"""게시판(조직)·폴더 축으로 보고서를 모아 보기 — MCP/AI 열거 경로.

배경: 보고서 행에는 조직이 없다(workspace_slug 는 작성자 개인공간). "어느 조직
글이냐"는 게시(mount)로만 표현되는데, 검색·집계 필터엔 그 축이 없어서 **특정 조직
글을 모아 조회하는 것 자체가 불가능**했다. 게시판/폴더 축을 공통 필터에 넣고,
이름을 받아 푸는 열거 엔드포인트(/api/reports/browse)를 붙인 것을 검증.

확인 대상:
  - board / folder / unfiled / include_descendants 필터
  - 이름 해석 실패 시 **400**(조건이 빠진 전체가 그 조직 것으로 오해되지 않게)
  - scope=user — 활성 워크스페이스(MCP 고정 헤더)와 무관하게 같은 결과
  - 응답에 소속(게시판·폴더) 동봉
  - 같은 축이 aggregate_reports(집계)·search_reports(하이브리드)에도 걸리는지

Run: cd backend && ./venv/bin/python -m pytest tests/test_reports_browse.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.folders.models import Folder, FolderKind
from app.modules.reports.models import Report
from app.modules.templates.models import Template

BOARD = "dev-hw"


def _h(ws="personal-1"):
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": ws,
    }


def _make_template() -> str:
    db = SessionLocal()
    try:
        tid = f"browse-{uuid.uuid4().hex[:8]}"
        db.add(
            Template(
                template_id=tid, version=1, name="browse test", description="",
                category="misc",
                schema={
                    "version": "widget-v1",
                    "blocks": [
                        {"id": "heading", "type": "heading", "props": {"label": "제목"}}
                    ],
                },
                owner_workspace_slugs=None, is_published=True, is_latest=True,
                created_by_user_id=None,
            )
        )
        db.commit()
        return tid
    finally:
        db.close()


def _make_folder(name: str) -> int:
    db = SessionLocal()
    try:
        f = Folder(kind=FolderKind.org, workspace_slug=BOARD, parent_id=None,
                   name=name, sort_order=999)
        db.add(f)
        db.commit()
        return f.id
    finally:
        db.close()


def _cleanup(report_ids, template_id, folder_ids):
    db = SessionLocal()
    try:
        for rid in report_ids:
            r = db.get(Report, rid)
            if r:
                db.delete(r)
        db.commit()
        for fid in folder_ids:
            f = db.get(Folder, fid)
            if f:
                db.delete(f)
        db.commit()
        t = db.get(Template, (template_id, 1))
        if t:
            db.delete(t)
            db.commit()
    finally:
        db.close()


def test_browse_by_board_and_folder():
    c = TestClient(app)
    tid = _make_template()
    marker = uuid.uuid4().hex[:10]
    fname = f"브라우즈테스트-{marker}"
    fid = _make_folder(fname)
    rids: list[int] = []
    try:
        # 폴더에 배치할 글 1건 + 같은 게시판 미분류 1건
        for title in (f"폴더글-{marker}", f"미분류글-{marker}"):
            r = c.post(
                "/api/reports/ai-draft", headers=_h(),
                json={"template_id": tid, "template_version": 1, "title": title,
                      "blocks": {"heading": title}},
            )
            assert r.status_code == 201, r.text
            rids.append(r.json()["data"]["report"]["id"])
        in_folder, unfiled_rid = rids
        assert c.post("/api/mounts", headers=_h(), json={
            "report_id": in_folder, "workspace_slugs": [BOARD], "folder_ids": [fid],
        }).status_code == 200
        assert c.post("/api/mounts", headers=_h(), json={
            "report_id": unfiled_rid, "workspace_slugs": [BOARD],
        }).status_code == 200

        def browse(qs, ws="personal-1"):
            r = c.get(f"/api/reports/browse?{qs}", headers=_h(ws))
            return r.status_code, r.json()

        # 1) 게시판 필터 — 두 건 모두 잡힌다
        st, d = browse(f"board={BOARD}&q={marker}&limit=50")
        assert st == 200, d
        got = {x["report_id"] for x in d["data"]["reports"]}
        assert {in_folder, unfiled_rid} <= got

        # 2) 폴더 필터(이름) — 배치된 것만
        st, d = browse(f"board={BOARD}&folder={fname}&limit=50")
        assert st == 200, d
        assert {x["report_id"] for x in d["data"]["reports"]} == {in_folder}
        # 응답이 소속(게시판·폴더)을 함께 준다
        row = d["data"]["reports"][0]
        assert row["boards"][0]["slug"] == BOARD
        assert fname in row["boards"][0]["folders"]
        assert row["author"] and row["phase"] == "reviewing"

        # 3) 미분류 — 폴더 배치된 글은 빠진다
        st, d = browse(f"board={BOARD}&unfiled=true&q={marker}&limit=50")
        got = {x["report_id"] for x in d["data"]["reports"]}
        assert unfiled_rid in got and in_folder not in got

        # 4) 못 푼 이름은 400 — 조건이 조용히 빠져 전체가 나가면 안 된다
        st, d = browse("board=존재하지않는부서-zzz")
        assert st == 400 and "찾지 못했습니다" in d["message"]
        st, d = browse(f"board={BOARD}&folder=존재하지않는폴더-zzz")
        assert st == 400 and "찾지 못했습니다" in d["message"]

        # 5) 활성 워크스페이스(MCP 고정 헤더)와 무관하게 같은 결과
        totals = {
            ws: browse(f"board={BOARD}&folder={fname}&limit=50", ws)[1]["data"]["total"]
            for ws in ("personal-1", "dx", BOARD)
        }
        assert len(set(totals.values())) == 1, totals

        # 6) 하위 부서 롤업 — 상위(dev)에서 보면 dev-hw 게시분이 포함된다
        st, d = browse(f"board=dev&include_descendants=true&q={marker}&limit=50")
        assert st == 200
        assert {in_folder, unfiled_rid} <= {x["report_id"] for x in d["data"]["reports"]}
        st, d = browse(f"board=dev&q={marker}&limit=50")
        assert {x["report_id"] for x in d["data"]["reports"]} == set()
    finally:
        _cleanup(rids, tid, [fid])


def test_board_folder_axis_reaches_aggregate_and_search():
    """같은 축이 집계·하이브리드 검색에도 걸리는지 — 필터를 공통 빌더에 둔 이유."""
    c = TestClient(app)

    def tool(name, args):
        return c.post(
            "/api/ai/ontology/tool", headers=_h("dx"), json={"name": name, "args": args}
        ).json()["data"]

    total = tool("aggregate_reports", {"filters": []})["count"]
    on_board = tool("aggregate_reports", {"filters": [], "board": BOARD})["count"]
    assert 0 < on_board < total, (on_board, total)

    # 못 푼 이름은 조용히 넓히지 않고 에러
    bad = tool("aggregate_reports", {"filters": [], "board": "없는부서-zzz"})
    assert "error" in bad and "찾지 못했습니다" in bad["error"]
    bad2 = tool("search_reports", {"query": "보고", "board": "없는부서-zzz"})
    assert "error" in bad2

    # 하이브리드 검색도 게시판으로 좁혀지고, 결과에 소속이 붙는다
    hits = tool("search_reports", {"query": "보고", "board": BOARD, "limit": 5})
    for row in hits.get("reports", []):
        assert "boards" in row
        assert BOARD in [b["slug"] for b in row["boards"]], row
