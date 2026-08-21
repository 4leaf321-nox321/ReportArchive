"""보고서 수정 이력·되돌리기 — 생성 시 v1 시드, 저장 시 버전 누적, 비파괴 되돌리기.

실행: cd backend && ./venv/bin/python -m pytest tests/test_report_versions.py -v
(공유 Postgres, head=p38 마이그레이션 적용 상태 전제.)
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports import services
from app.modules.reports.models import Report, ReportVersion
from app.modules.reports.schemas import ReportUpdate


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _purge(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)  # report_versions 는 FK CASCADE
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


def _versions(client, rid):
    r = client.get(f"/api/reports/{rid}/versions", headers=_h())
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _backdate_latest(rid, minutes):
    """세션 병합(10분)을 피하려고 최신 버전을 과거로."""
    db = SessionLocal()
    try:
        v = (
            db.execute(
                select(ReportVersion)
                .where(ReportVersion.report_id == rid)
                .order_by(ReportVersion.seq.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        v.created_at = datetime.utcnow() - timedelta(minutes=minutes)
        db.commit()
    finally:
        db.close()


def _service_update(rid, title):
    """API 잠금 절차 없이 본문 저장 — require_lock=False 로 서비스 직접 호출."""
    db = SessionLocal()
    try:
        rep = db.get(Report, rid)
        services.update_report(
            db, rep, ReportUpdate(title=title), updated_by_user_id=1, require_lock=False
        )
    finally:
        db.close()


def _pages(rid):
    db = SessionLocal()
    try:
        return [dict(x) for x in (db.get(Report, rid).pages or [])]
    finally:
        db.close()


def _set_pages(rid, pages):
    """쪽 구성을 바꿔 저장 — 되돌리기 미리보기가 쪽 증감을 어떻게 말하는지 보려고."""
    db = SessionLocal()
    try:
        rep = db.get(Report, rid)
        services.update_report(
            db, rep, ReportUpdate(pages=pages), updated_by_user_id=1, require_lock=False
        )
    finally:
        db.close()


def test_seed_history_and_nondestructive_restore():
    client = TestClient(app)
    res = _create(client, "버전테스트 원본")
    rid = res["id"]
    try:
        # 생성 시 v1 시드.
        v = _versions(client, rid)
        assert len(v) == 1
        seed_id = v[0]["id"]

        # 병합 회피 후 수정 저장 → 2개.
        _backdate_latest(rid, minutes=20)
        _service_update(rid, "버전테스트 수정본")
        v = _versions(client, rid)
        assert len(v) == 2

        # 옛 버전(원본) 본문 미리보기.
        detail = client.get(
            f"/api/reports/{rid}/versions/{seed_id}", headers=_h()
        ).json()["data"]
        assert "원본" in detail["body"]["title"]

        # 현재 보고서는 수정본.
        cur = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert "수정본" in cur["title"]

        # 원본으로 되돌리기 (라우트가 내부에서 잠금 점유/해제).
        r = client.post(
            f"/api/reports/{rid}/versions/{seed_id}/restore", headers=_h()
        )
        assert r.status_code == 200, r.text

        # 되돌려져 제목이 원본.
        cur = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert "원본" in cur["title"]

        # 비파괴: 수정본 버전이 이력에 남아 있고, restore 마커 버전이 생김.
        v2 = _versions(client, rid)
        assert len(v2) >= 3
        assert any(x["source"] == "restore" for x in v2)
        # 수정본 스냅샷이 여전히 존재(비파괴 확인).
        bodies = [
            client.get(
                f"/api/reports/{rid}/versions/{x['id']}", headers=_h()
            ).json()["data"]["body"]["title"]
            for x in v2
        ]
        assert any("수정본" in t for t in bodies)
    finally:
        _purge(rid)


def test_versions_require_read_permission():
    client = TestClient(app)
    res = _create(client, "버전권한 테스트")
    rid = res["id"]
    try:
        # 비멤버(다른 부서, 비공개 개인 보고서) → 403.
        from app.modules.users.models import Role
        from tests.test_report_search import _ensure_member  # 재사용

        other = _ensure_member("ver-other@test.local", "dev-hw", Role.user)
        r = client.get(
            f"/api/reports/{rid}/versions", headers=_h(other, "dev-hw")
        )
        assert r.status_code == 403, r.text
    finally:
        _purge(rid)


def test_restore_dry_run_previews_and_revision_guard_blocks():
    """되돌리기 미리보기와 낙관적 동시성 가드.

    되돌리기는 그 사이 사람이 고친 내용을 통째로 되감는 유일한 파괴적 조작인데
    미리보기가 없었다(다른 파괴적 조작엔 모두 있다). AI 경로에서 특히 위험하다.
    """
    client = TestClient(app)
    rid = _create(client, "미리보기 원본")["id"]
    try:
        seed_id = _versions(client, rid)[0]["id"]
        _backdate_latest(rid, minutes=20)
        _service_update(rid, "미리보기 수정본")

        before = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        rev = before["revision"]

        # dry_run — 되돌리지 않고 무엇이 달라지는지만.
        r = client.post(
            f"/api/reports/{rid}/versions/{seed_id}/restore?dry_run=true", headers=_h()
        )
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["dry_run"] is True
        assert d["title_change"]["to"] == "미리보기 원본"
        assert d["warning"]

        # page_diff 는 **되돌린 뒤** 기준으로 말해야 한다. 쪽 수가 그대로면
        # added/removed 가 나오면 안 된다(라벨이 뒤집혀 있었다).
        pd = d["page_diff"]
        assert {x["status"] for x in pd} <= {"changed", "unchanged"}, pd

        # 실제로는 안 바뀌어야 한다 — 미리보기니까.
        still = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert "수정본" in still["title"]
        assert still["revision"] == rev

        # 낡은 revision → 409. 미리 본 것과 다른 상태를 되감지 않게.
        stale = client.post(
            f"/api/reports/{rid}/versions/{seed_id}/restore"
            f"?expected_revision={rev + 5}",
            headers=_h(),
        )
        assert stale.status_code == 409, stale.text
        assert "revision" in (stale.json().get("message") or "")
        assert "수정본" in client.get(
            f"/api/reports/{rid}", headers=_h()
        ).json()["data"]["title"]

        # 맞는 revision → 통과.
        ok = client.post(
            f"/api/reports/{rid}/versions/{seed_id}/restore?expected_revision={rev}",
            headers=_h(),
        )
        assert ok.status_code == 200, ok.text
        assert "원본" in client.get(
            f"/api/reports/{rid}", headers=_h()
        ).json()["data"]["title"]
    finally:
        _purge(rid)


def test_restore_dry_run_labels_page_add_and_remove_from_after_view():
    """쪽 수가 달라질 때 라벨은 **되돌린 뒤** 기준이어야 한다.

    현재에 없는 쪽 = 되돌리면 '생긴다', 그 시점에 없던 쪽 = 되돌리면 '사라진다'.
    사람이 이걸 보고 승인 여부를 정하므로 뒤집히면 정반대로 읽힌다.
    """
    client = TestClient(app)
    rid = _create(client, "쪽수변화 원본")["id"]
    try:
        # 1쪽짜리 시점을 스냅샷으로 남긴다.
        seed_id = _versions(client, rid)[0]["id"]
        one_page = _pages(rid)
        assert len(one_page) == 1

        # 쪽을 하나 늘린다 → 되돌리면 그 쪽은 **사라진다**.
        _backdate_latest(rid, minutes=20)
        # 새 쪽도 템플릿을 갖춰야 하므로 1쪽을 그대로 복제한다(블록 id 는 템플릿 것).
        page2 = {**one_page[0], "name": "2쪽"}
        _set_pages(rid, one_page + [page2])
        marker = sorted((page2.get("content") or {}).keys())

        d = client.post(
            f"/api/reports/{rid}/versions/{seed_id}/restore?dry_run=true", headers=_h()
        ).json()["data"]
        by_page = {x["page"]: x for x in d["page_diff"]}
        assert by_page[2]["status"] == "removed_by_restore", d["page_diff"]
        assert by_page[2]["blocks_lost"] == marker, by_page[2]

        # 반대 방향 — 2쪽짜리 시점을 남기고 1쪽으로 줄이면, 되돌리면 **생긴다**.
        two_page_vid = _versions(client, rid)[0]["id"]  # 목록은 최신순
        _backdate_latest(rid, minutes=20)
        _set_pages(rid, one_page)
        d2 = client.post(
            f"/api/reports/{rid}/versions/{two_page_vid}/restore?dry_run=true",
            headers=_h(),
        ).json()["data"]
        by_page2 = {x["page"]: x for x in d2["page_diff"]}
        assert by_page2[2]["status"] == "added_by_restore", d2["page_diff"]
        assert by_page2[2]["blocks"] == marker, by_page2[2]
    finally:
        _purge(rid)
