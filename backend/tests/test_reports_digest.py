"""여러 보고서를 재료로 하나 쓰기 — 본문만 추려 한 번에 읽는다.

`get_report` 로 하나씩 읽으면 건당 수만 자라 몇 건만 모아도 대화가 넘친다
(실측 4건 99,642자). LLM 을 쓰지 않으므로 항상 동작한다 — 기존 AI 요약은
5,128건 중 13건뿐이라 재료로 삼을 수 없었다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_reports_digest.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report
from app.modules.templates.models import Template

H = {
    "Authorization": f"Bearer {create_access_token(1)}",
    "X-Workspace-Slug": "personal-1",
}


def _make_template() -> str:
    db = SessionLocal()
    try:
        tid = f"digest-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="digest", description="", category="misc",
            schema={"version": "widget-v1", "blocks": [
                {"id": "h", "type": "heading", "props": {"label": "제목"}}]},
            owner_workspace_slugs=None, is_published=True, is_latest=True,
            created_by_user_id=None,
        ))
        db.commit()
        return tid
    finally:
        db.close()


def _cleanup(rids, tid):
    db = SessionLocal()
    try:
        for rid in rids:
            r = db.get(Report, rid)
            if r:
                db.delete(r)
        db.commit()
        t = db.get(Template, (tid, 1))
        if t:
            db.delete(t)
            db.commit()
    finally:
        db.close()


def _seed(c, tid, title, body):
    return c.post("/api/reports/ai-draft", headers=H, json={
        "template_id": tid, "template_version": 1, "title": title,
        "blocks": {"h": {"text": title}},
        "extra_blocks": [
            {"id": "body", "type": "rich_text", "content": {"markdown": body}},
            {"id": "tbl", "type": "table",
             "props": {"columns": [{"key": "a", "label": "A", "type": "text"}]},
             "content": [{"a": "1"}, {"a": "2"}, {"a": "3"}]},
        ],
    }).json()["data"]["report_id"]


def test_digest_is_much_smaller_than_reading_each_report():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        long_body = "가나다라마바사아자차카타파하 " * 40   # 블록 하나가 길다
        for i in range(3):
            rids.append(_seed(c, tid, f"주간보고 {i + 1}", long_body))

        full = sum(
            len(c.get(f"/api/reports/{rid}", headers=H).text) for rid in rids
        )
        r = c.get("/api/reports/digest", headers=H,
                  params={"ids": ",".join(str(x) for x in rids)})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["count"] == 3 and d["skipped"] == []
        assert len(r.text) < full // 2, (len(r.text), full)

        first = d["reports"][0]
        assert first["title"].startswith("주간보고")
        blocks = {b["block_id"]: b for b in first["pages"][0]["blocks"]}
        # 글자는 잘려서 오고, 표는 글자가 없어도 행 수가 온다.
        assert len(blocks["body"]["texts"][0]) <= 160, blocks["body"]["texts"][0]
        assert blocks["tbl"]["rows"] == 3, blocks["tbl"]
    finally:
        _cleanup(rids, tid)


def test_digest_reports_what_it_could_not_read():
    """볼 수 없는 건 **조용히 빠지지 않는다** — 몇 건을 재료로 썼는지 알아야 한다."""
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = _seed(c, tid, "내 것", "본문")
        rids.append(rid)
        r = c.get("/api/reports/digest", headers=H,
                  params={"ids": f"{rid},99999999"})
        d = r.json()["data"]
        assert d["count"] == 1
        assert d["skipped"] == [{"report_id": 99999999, "reason": "없는 보고서"}], d

        # 남의 비공개 보고서 → 사유와 함께 skipped.
        from app.modules.users.models import Role
        from tests.test_report_search import _ensure_member

        uid = _ensure_member("digest-other@test.local", "dev-hw", Role.user)
        other = {"Authorization": f"Bearer {create_access_token(uid)}",
                 "X-Workspace-Slug": "dev-hw"}
        d2 = c.get("/api/reports/digest", headers=other,
                   params={"ids": str(rid)}).json()["data"]
        assert d2["count"] == 0
        assert d2["skipped"][0]["reason"] == "볼 권한이 없음", d2
    finally:
        _cleanup(rids, tid)


def test_digest_rejects_bad_input():
    c = TestClient(app)
    empty = c.get("/api/reports/digest", headers=H, params={"ids": ""})
    assert empty.status_code == 400 and "비었" in (empty.json().get("message") or "")
    bad = c.get("/api/reports/digest", headers=H, params={"ids": "a,b"})
    assert bad.status_code == 400 and "정수" in (bad.json().get("message") or "")
    assert c.get("/api/reports/digest", headers=H).status_code == 422  # ids 자체 누락
    many = ",".join(str(i) for i in range(1, 25))
    r = c.get("/api/reports/digest", headers=H, params={"ids": many})
    assert r.status_code == 400
    assert "최대 20건" in (r.json().get("message") or "")
