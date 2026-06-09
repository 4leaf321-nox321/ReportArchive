"""영구삭제 시 발행 종합보고 안건의 스냅샷 보존(분리) — 삭제 재설계 3단계 보강.

발행된 종합보고 안건은 snapshot_content(동결)을 갖는다. 원본 보고서를
영구삭제하면:
  - 스냅샷 있는(발행) 안건 → 원본과 분리(ref_report_id=NULL)돼 스냅샷으로 살아남음.
  - 스냅샷 없는(미발행/라이브) 안건 → 함께 삭제.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.composites.models import (
    CompositeKind,
    CompositeReport,
    CompositeReportItem,
)
from app.modules.reports.models import Report

WS = "dx"


def _h():
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": WS}


def _make_report(client):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "분리 테스트 원본",
            "tags": [],
        },
    ).json()["data"]["id"]


def _make_composite_with_item(report_id, *, snapshot):
    """report_id 를 안건으로 가진 종합보고 1건 생성. snapshot=True 면 발행 안건처럼
    snapshot_content 를 채운다. (composite_id, item_id) 반환."""
    db = SessionLocal()
    try:
        c = CompositeReport(
            workspace_slug=WS, title="분리 테스트 종합", kind=CompositeKind.theme
        )
        db.add(c)
        db.flush()
        it = CompositeReportItem(
            composite_id=c.id,
            ref_report_id=report_id,
            snapshot_content={"title": "동결본", "pages": []} if snapshot else None,
        )
        db.add(it)
        db.commit()
        return c.id, it.id
    finally:
        db.close()


def _cleanup(composite_id):
    db = SessionLocal()
    try:
        c = db.get(CompositeReport, composite_id)
        if c:
            db.delete(c)
            db.commit()
    finally:
        db.close()


def test_purge_detaches_snapshot_item_keeps_it():
    client = TestClient(app)
    rid = _make_report(client)
    cid, item_id = _make_composite_with_item(rid, snapshot=True)
    try:
        # 게시 안 했으니 바로 영구삭제 가능.
        r = client.delete(f"/api/reports/{rid}", headers=_h())
        assert r.status_code == 200, r.text

        db = SessionLocal()
        try:
            assert db.get(Report, rid) is None  # 원본 삭제됨
            item = db.get(CompositeReportItem, item_id)
            assert item is not None  # 안건은 살아남음
            assert item.ref_report_id is None  # 원본과 분리
            assert item.snapshot_content is not None  # 스냅샷 보존
        finally:
            db.close()
    finally:
        _cleanup(cid)


def test_purge_removes_unpublished_item():
    client = TestClient(app)
    rid = _make_report(client)
    cid, item_id = _make_composite_with_item(rid, snapshot=False)
    try:
        r = client.delete(f"/api/reports/{rid}", headers=_h())
        assert r.status_code == 200, r.text
        db = SessionLocal()
        try:
            # 스냅샷 없는 안건은 함께 삭제(분리하면 빈 항목이 되므로).
            assert db.get(CompositeReportItem, item_id) is None
        finally:
            db.close()
    finally:
        _cleanup(cid)
