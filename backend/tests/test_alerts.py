"""Phase D 경보 — diff 상태기계 + 프로브 + 엔드포인트 게이팅.

상태기계는 fake 프로브를 주입해 결정적으로 검증(실 dev 데이터에 의존 안 함).
생성한 규칙/상태 행은 finally 로 정리(격리 DB 없음).
"""
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.alerts import services
from app.modules.alerts.models import AlertRule, AlertRuleState
from app.modules.auth.services import create_access_token

ADMIN = {"Authorization": f"Bearer {create_access_token(2)}"}      # 시스템 관리자
NONADMIN = {"Authorization": f"Bearer {create_access_token(3)}"}   # 매니저(시스템관리자 아님)


def _target(tid, title="t"):
    return {"target_type": "report", "target_id": str(tid),
            "context": {"title": title}}


def test_diff_keys():
    d = services.diff_keys({("report", "1"), ("report", "2")},
                           {("report", "2"), ("report", "3")})
    assert d["new"] == {("report", "3")}
    assert d["gone"] == {("report", "1")}
    assert d["kept"] == {("report", "2")}


def test_run_rule_state_machine(monkeypatch):
    """신규 진입=발화 → 재실행=침묵(중복 없음) → 이탈=해소."""
    db = SessionLocal()
    rule = AlertRule(name="_t", enabled=True, probe_key="_test_probe",
                     params={}, severity="info")
    db.add(rule)
    db.commit()
    db.refresh(rule)
    try:
        # 프로브가 반환할 대상을 테스트가 조종.
        current = [_target(101), _target(102)]
        monkeypatch.setitem(services.PROBES, "_test_probe",
                            lambda _db, _p: list(current))

        r1 = services.run_rule(db, rule)
        assert (r1["fired"], r1["resolved"], r1["firing"]) == (2, 0, 2)

        # 재실행 — 같은 대상이면 발화 0(중복 방지가 핵심).
        r2 = services.run_rule(db, rule)
        assert (r2["fired"], r2["resolved"], r2["firing"]) == (0, 0, 2)

        # 102 이탈 → 해소 1, 발화 중 1.
        current[:] = [_target(101)]
        r3 = services.run_rule(db, rule)
        assert (r3["fired"], r3["resolved"], r3["firing"]) == (0, 1, 1)

        # 102 재등장 → 재발화.
        current[:] = [_target(101), _target(102)]
        r4 = services.run_rule(db, rule)
        assert (r4["fired"], r4["firing"]) == (1, 2)
    finally:
        db.query(AlertRuleState).filter_by(rule_id=rule.id).delete()
        db.delete(rule)
        db.commit()
        db.close()


def test_disabled_rule_fires_nothing(monkeypatch):
    db = SessionLocal()
    rule = AlertRule(name="_t2", enabled=False, probe_key="_test_probe",
                     params={}, severity="info")
    db.add(rule)
    db.commit()
    db.refresh(rule)
    try:
        monkeypatch.setitem(services.PROBES, "_test_probe",
                            lambda _db, _p: [_target(1)])
        r = services.run_rule(db, rule)
        assert r["fired"] == 0 and r["firing"] == 0
    finally:
        db.query(AlertRuleState).filter_by(rule_id=rule.id).delete()
        db.delete(rule)
        db.commit()
        db.close()


def test_scheduler_tick_enqueues_due_rule(monkeypatch):
    """due 한 interval 규칙 → run_alert_rule 잡 적재 + next_run_at 미래로 밀림."""
    from datetime import datetime

    from sqlalchemy import text

    from app.jobs.scheduler import run_alerts_scheduler_tick

    db = SessionLocal()
    rule = AlertRule(
        name="_sched", enabled=True, probe_key="_test_probe", params={},
        severity="info", schedule_kind="interval", interval_minutes=60,
        next_run_at=datetime(2020, 1, 1),  # 확실히 과거 → due
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    try:
        monkeypatch.setitem(services.PROBES, "_test_probe", lambda _db, _p: [])
        r = run_alerts_scheduler_tick(db)
        assert r["enqueued"] >= 1
        db.refresh(rule)
        assert rule.next_run_at is not None and rule.next_run_at.year >= 2026  # 밀림
        n = db.execute(
            text(
                "SELECT count(*) FROM jobs WHERE type='run_alert_rule' "
                "AND status='pending' AND payload->>'rule_id' = :rid"
            ),
            {"rid": str(rule.id)},
        ).scalar_one()
        assert n >= 1
    finally:
        db.execute(
            text("DELETE FROM jobs WHERE payload->>'rule_id' = :rid AND type='run_alert_rule'"),
            {"rid": str(rule.id)},
        )
        db.query(AlertRuleState).filter_by(rule_id=rule.id).delete()
        db.delete(rule)
        db.commit()
        db.close()


def test_next_alert_run_anchors():
    """주초=다음 월요일 00:00, 달 초=다음 달 1일 00:00, interval=상대 간격."""
    from datetime import datetime, timezone

    from app.jobs.scheduler import next_alert_run

    now = datetime(2026, 7, 15, 10, 30, tzinfo=timezone.utc)  # 수요일
    wk = next_alert_run("weekly", None, now)
    assert wk.weekday() == 0 and wk > now
    assert (wk.hour, wk.minute, wk.second) == (0, 0, 0)
    mo = next_alert_run("monthly", None, now)
    assert mo.day == 1 and mo.month == 8 and mo > now
    iv = next_alert_run("interval", 120, now)
    assert iv > now


def test_untagged_probe_shape():
    """실 dev 데이터 — 개수는 비결정적이라 단언 안 하고 형태만 검증."""
    db = SessionLocal()
    try:
        out = services._probe_untagged_reports(db, {"days": 7, "mounted_only": True})
        assert isinstance(out, list)
        for t in out[:5]:
            assert t["target_type"] == "report"
            assert isinstance(t["target_id"], str)
            assert "title" in t["context"]
            # mounted_only 면 게시판이 최소 1개 있어야(개인 미게시 제외).
            assert t["context"]["boards"], "mounted_only 인데 게시판이 비어있음"
    finally:
        db.close()


def test_stale_unpublished_probe_shape():
    """미발행 프로브 — phase != finalized, context 에 phase·updated_at 포함."""
    db = SessionLocal()
    try:
        out = services._probe_stale_unpublished(db, {"days": 30, "mounted_only": False})
        assert isinstance(out, list)
        for t in out[:5]:
            assert t["target_type"] == "report"
            assert t["context"]["phase"] in ("drafting", "reviewing")  # finalized 제외
            assert "updated_at" in t["context"]
    finally:
        db.close()


def test_rules_endpoint_admin_only():
    c = TestClient(app)
    # 시스템 관리자 = 200, 시드 규칙 1개 이상.
    r = c.get("/api/alerts/rules", headers=ADMIN)
    assert r.status_code == 200
    items = r.json()["data"]["items"]
    assert any(it["probe_key"] == "untagged_reports" for it in items)
    # 비관리자 = 403.
    assert c.get("/api/alerts/rules", headers=NONADMIN).status_code == 403


def test_update_and_run_endpoints():
    c = TestClient(app)
    # 시드 규칙 id 찾기.
    items = c.get("/api/alerts/rules", headers=ADMIN).json()["data"]["items"]
    rid = next(it["id"] for it in items if it["probe_key"] == "untagged_reports")
    orig = next(it for it in items if it["id"] == rid)
    try:
        # 조정 — days 변경 반영.
        r = c.patch(f"/api/alerts/rules/{rid}", headers=ADMIN,
                    json={"params": {"days": 30}})
        assert r.status_code == 200
        assert r.json()["data"]["params"]["days"] == 30
        # 실행 — 요약 형태.
        run = c.post(f"/api/alerts/rules/{rid}/run", headers=ADMIN).json()["data"]
        assert set(run) >= {"checked", "fired", "resolved", "firing"}
        # 발화 목록 — 페이지네이션(total + limit 준수).
        fr = c.get(f"/api/alerts/rules/{rid}/firing?limit=2&offset=0",
                   headers=ADMIN).json()["data"]
        assert "total" in fr and len(fr["items"]) <= 2
        assert fr["total"] >= len(fr["items"])
    finally:
        # 원래 params 복구.
        c.patch(f"/api/alerts/rules/{rid}", headers=ADMIN,
                json={"params": orig["params"], "enabled": orig["enabled"]})
