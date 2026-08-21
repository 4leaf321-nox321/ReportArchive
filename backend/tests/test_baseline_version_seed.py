"""기준선(baseline) 스냅샷 — 버전 이력이 없던 옛 보고서도 되돌릴 수 있어야 한다.

`record_version` 은 저장 **뒤** 본문을 찍는다. 그래서 버전 기능 도입 전
(2026-05~06)에 만들어진 보고서는 이력이 0개였고, 그 상태에서 AI 가 처음
수정하면 남는 버전은 **수정된 결과 하나뿐**이라 원본으로 돌아갈 길이 없었다.
p93 이 그 104건에 v1 스냅샷을 시딩해 되돌리기 안전망의 전제를 세웠다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_baseline_version_seed.py -v
"""
from __future__ import annotations

from sqlalchemy import text

from app.database import SessionLocal
from app.modules.reports import versioning


def test_no_report_is_left_without_a_restore_point():
    """되돌릴 지점이 없는 보고서가 남아 있으면 안 된다 — p93 의 존재 이유."""
    db = SessionLocal()
    try:
        n = db.execute(text("""
            SELECT count(*) FROM reports r
            LEFT JOIN report_versions v ON v.report_id = r.id
            WHERE v.id IS NULL
        """)).scalar()
        assert n == 0, f"버전이 하나도 없는 보고서 {n}건 — 첫 수정을 되돌릴 수 없다"
    finally:
        db.close()


def test_baseline_snapshots_decode_and_match_the_code_serializer():
    """마이그레이션이 만든 스냅샷은 **코드가 읽을 수 있어야** 한다.

    마이그레이션은 모델을 import 하지 않고 직렬화를 손으로 복제했다. 형태나
    필드가 어긋나면 되돌리기가 터지는데, 그건 되돌리려는 순간에야 드러난다 —
    여기서 미리 잡는다.
    """
    from app.modules.reports.models import Report, ReportVersion
    from sqlalchemy import select

    db = SessionLocal()
    try:
        vs = db.execute(
            select(ReportVersion).where(ReportVersion.source == "baseline").limit(20)
        ).scalars().all()
        if not vs:
            return  # 시딩 대상이 없는 환경(신규 DB) — 검증할 게 없다
        for v in vs:
            body = versioning.decode_body(v)          # 복호화 자체가 1차 검증
            r = db.get(Report, v.report_id)
            assert set(body) == {
                "title", "pages", "content", "layout_overrides", "props_overrides"
            }, sorted(body)
            # 코드 경로로 같은 본문을 찍으면 **같은 해시**여야 한다.
            _gz, sha, _n = versioning._serialize(versioning._build_body(r))
            if r.revision == v.revision:  # 그 뒤로 안 고쳐진 것만 비교 가능
                assert sha == v.body_sha256, f"report {v.report_id}: 직렬화 불일치"
    finally:
        db.close()


def test_baseline_survives_pruning():
    """일상 버전이 아무리 쌓여도 기준선은 남아야 한다 — 안 그러면 안전망이 침식된다."""
    assert "baseline" not in versioning.ORDINARY_SOURCES, (
        "baseline 이 ORDINARY_SOURCES 에 들어가면 prune 대상이 된다"
    )
