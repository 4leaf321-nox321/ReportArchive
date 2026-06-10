"""요약본 만들기(copy mode=summary) — 본문만 복사 + 원본↔요약 'summary' 링크.

요약본은 outgoing 'summary' 로 원본을 가리키고, 원본은 같은 row 를 incoming
으로 보여준다(양쪽 상세에 요약↔원본 관계 표시).
"""
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token


def _h():
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": "dx",
    }


def _links(client, rid):
    return client.get(f"/api/reports/{rid}/links", headers=_h()).json()["data"]


def test_summary_copy_creates_bidirectional_link():
    client = TestClient(app)
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    orig = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "원본 보고서",
            "tags": [],
        },
    ).json()["data"]["id"]
    summ = None
    try:
        r = client.post(
            f"/api/reports/{orig}/copy",
            headers=_h(),
            json={"title": "요약본", "mode": "summary"},
        )
        assert r.status_code in (200, 201), r.text
        summ = r.json()["data"]["id"]
        assert summ != orig

        # 원본(from) → 요약본(to): 원본에서 outgoing 'summary' → 요약본
        ol = _links(client, orig)
        out = next((x for x in ol if x["kind"] == "summary"), None)
        assert out is not None, ol
        assert out["direction"] == "outgoing"
        assert out["counterpart"]["id"] == summ

        # 요약본(to)에서 같은 row 가 incoming 으로 보인다 → 원본
        sl = _links(client, summ)
        inc = next((x for x in sl if x["kind"] == "summary"), None)
        assert inc is not None, sl
        assert inc["direction"] == "incoming"
        assert inc["counterpart"]["id"] == orig
    finally:
        if summ:
            client.delete(f"/api/reports/{summ}", headers=_h())
        client.delete(f"/api/reports/{orig}", headers=_h())
