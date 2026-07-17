"""본문 전문검색 — /api/reports/search 엔드포인트.

가시 스코프·휴지통 제외·한국어 조사 부분일치(pg_trgm)를 엔드포인트로 검증.
본문(위젯 텍스트) 추출 자체는 test_search_text_extraction.py(순수 함수)가 커버하고,
여기선 인덱싱(생성 시 이벤트 훅) → 검색 → 권한 스코프의 통합 동작을 본다.

실행 전제: 공유 Postgres 가 head(p37: pg_trgm + reports.search_text + GIN)까지
마이그레이션돼 있어야 한다.
    cd backend && ./venv/bin/alembic upgrade head
    python -m pytest tests/test_report_search.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report
from app.modules.users.models import Role, User, WorkspaceMember

BOARD = "dev-hw"


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _ensure_member(email, slug, role):
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        m = (
            db.query(WorkspaceMember)
            .filter_by(user_id=u.id, workspace_slug=slug)
            .one_or_none()
        )
        if m is None:
            db.add(WorkspaceMember(user_id=u.id, workspace_slug=slug, role=role))
        else:
            m.role = role
        db.commit()
        return u.id
    finally:
        db.close()


def _purge(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()
    finally:
        db.close()


def _create(client, title):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]


def _search(client, q, headers=None):
    r = client.get(
        "/api/reports/search", params={"q": q}, headers=headers or _h()
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _ids(data):
    return {hit["report"]["id"] for hit in data["results"]}


def test_search_finds_by_korean_substring_with_snippet():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    # 조사가 붙은 형태로 저장 — "보고서" 검색이 "보고서를"에 잡혀야 한다(pg_trgm).
    rid = _create(client, f"검색{tag} 월간 보고서를 검토")["id"]
    try:
        data = _search(client, f"검색{tag}")
        assert rid in _ids(data)
        # 부분일치: 조사 없는 '보고서' 로도 찾힌다.
        assert rid in _ids(_search(client, "보고서"))
        # 스니펫이 붙는다.
        hit = next(h for h in data["results"] if h["report"]["id"] == rid)
        assert hit["snippet"]
    finally:
        _purge(rid)


def test_search_excludes_soft_deleted():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    rid = _create(client, f"휴지통{tag} 테스트")["id"]
    try:
        assert rid in _ids(_search(client, f"휴지통{tag}"))
        assert client.post(f"/api/reports/{rid}/trash", headers=_h()).status_code == 200
        assert rid not in _ids(_search(client, f"휴지통{tag}"))
    finally:
        _purge(rid)


def test_search_is_scoped_to_visible_reports():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    other = _ensure_member("search-other@test.local", BOARD, Role.user)
    rid = _create(client, f"스코프{tag} 비공개 보고서")["id"]
    try:
        # 소유자(uid=1)는 자기 개인 보고서를 찾는다.
        assert rid in _ids(_search(client, f"스코프{tag}"))
        # 게시 전 개인 보고서 → 다른 멤버는 못 찾는다(스코프 밖).
        assert rid not in _ids(
            _search(client, f"스코프{tag}", headers=_h(other, BOARD))
        )
        # 게시판에 mount → 그 게시판 멤버가 찾는다.
        client.post(
            "/api/mounts",
            headers=_h(),
            json={"report_id": rid, "workspace_slugs": [BOARD]},
        )
        assert rid in _ids(
            _search(client, f"스코프{tag}", headers=_h(other, BOARD))
        )
    finally:
        _purge(rid)


def test_related_reports_excludes_self_and_gates():
    """관련 보고서 추천 — semantic_search 재사용. 자기 자신 제외 + 가시성 게이트 +
    없는 보고서 404."""
    from app.modules.reports import services as rs

    db = SessionLocal()
    try:
        rid = next((r for r in rs.all_visible_report_ids(db, 2)), None)
    finally:
        db.close()
    if rid is None:
        return  # dev DB 에 가시 보고서 없음

    client = TestClient(app)
    r = client.get(f"/api/reports/{rid}/related", params={"limit": 5}, headers=_h(2, "dx"))
    assert r.status_code == 200, r.text
    items = r.json()["data"]["items"]
    assert len(items) <= 5
    assert all(it["report_id"] != rid for it in items)  # ★ 자기 자신 제외
    for it in items:  # 관련 항목은 이동에 필요한 필드를 갖춘다
        assert "report_id" in it and "workspace_slug" in it

    # 없는 보고서 → 404.
    assert client.get("/api/reports/999999999/related", headers=_h(2, "dx")).status_code == 404
