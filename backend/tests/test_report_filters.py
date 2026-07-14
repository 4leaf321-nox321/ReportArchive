"""(B) 보고서 컬럼 필터 — 순수 함수 단위 검증.

날짜 범위 파서(resolve_date_range)와 조건 빌더(report_column_conditions)는 DB·LLM
없이 결정적으로 동작하므로 여기서 격리 검증한다. 검색 엔드포인트 통합(가시 스코프 ∩
필터)은 test_report_search.py 가, AI 집계 라우팅은 test_structured_qa.py 가 커버.
    cd backend && python -m pytest tests/test_report_filters.py -v
"""
from __future__ import annotations

from datetime import date, timedelta

from app.modules.reports.services import (
    report_column_conditions,
    resolve_date_range,
)

TODAY = date(2026, 7, 14)  # 화요일


# --------------------------------------------------------------------------- #
# resolve_date_range — 상대/명시 날짜 표현
# --------------------------------------------------------------------------- #
def test_last_days_is_inclusive_window():
    # "최근 7일" = [오늘-6, 오늘] 포함 7일.
    f, t = resolve_date_range(last_days=7, today=TODAY)
    assert f == date(2026, 7, 8)
    assert t == TODAY
    assert (t - f).days == 6


def test_last_days_one_is_today_only():
    f, t = resolve_date_range(last_days=1, today=TODAY)
    assert f == TODAY and t == TODAY


def test_period_today_and_yesterday():
    assert resolve_date_range(period="today", today=TODAY) == (TODAY, TODAY)
    y = TODAY - timedelta(days=1)
    assert resolve_date_range(period="yesterday", today=TODAY) == (y, y)


def test_period_this_week_starts_monday():
    f, t = resolve_date_range(period="this_week", today=TODAY)
    assert f == TODAY - timedelta(days=TODAY.weekday())  # 월요일
    assert t == TODAY


def test_period_this_month_and_year():
    assert resolve_date_range(period="this_month", today=TODAY) == (
        date(2026, 7, 1), TODAY
    )
    assert resolve_date_range(period="this_year", today=TODAY) == (
        date(2026, 1, 1), TODAY
    )


def test_explicit_dates_take_precedence_over_relative():
    # date_from/date_to 가 있으면 last_days/period 는 무시.
    f, t = resolve_date_range(
        date_from=date(2026, 1, 1), date_to=date(2026, 3, 31),
        last_days=7, period="today", today=TODAY,
    )
    assert f == date(2026, 1, 1) and t == date(2026, 3, 31)


def test_no_signal_returns_none():
    assert resolve_date_range(today=TODAY) == (None, None)
    assert resolve_date_range(last_days=0, today=TODAY) == (None, None)


# --------------------------------------------------------------------------- #
# report_column_conditions — SQLAlchemy 조건 리스트 조립
# --------------------------------------------------------------------------- #
def test_no_filters_yields_no_conditions():
    assert report_column_conditions() == []


def test_date_range_report_date_two_bounds():
    conds = report_column_conditions(
        date_from=date(2026, 7, 1), date_to=date(2026, 7, 14)
    )
    assert len(conds) == 2  # >= from, <= to


def test_created_at_to_is_exclusive_next_day():
    # created_at 은 시각이므로 to 는 그날 끝까지 포함(< 다음날) — 조건 자체는 2개.
    conds = report_column_conditions(
        date_from=date(2026, 7, 1), date_to=date(2026, 7, 14),
        date_field="created_at",
    )
    assert len(conds) == 2


def test_categorical_filters_each_add_one_condition():
    conds = report_column_conditions(
        report_type_ids=[1, 2], author_ids=[9], editor_ids=[3],
        tags=["긴급"],
    )
    # 종류 + 작성자 + 편집자 + 태그 = 4.
    assert len(conds) == 4


def test_invalid_phase_and_lifecycle_dropped():
    # 잘못된 enum 값은 조용히 버려 무필터로 새지 않게.
    assert report_column_conditions(phases=["nope"]) == []
    assert report_column_conditions(lifecycles=["bogus"]) == []
    # 유효 값은 조건 1개.
    assert len(report_column_conditions(phases=["finalized"])) == 1
    assert len(report_column_conditions(lifecycles=["ongoing"])) == 1
    # 일부만 유효하면 유효분만.
    assert len(report_column_conditions(phases=["finalized", "nope"])) == 1


def test_empty_lists_are_noops():
    assert report_column_conditions(
        report_type_ids=[], author_ids=[], phases=[], tags=[]
    ) == []


# --------------------------------------------------------------------------- #
# structured_qa — LLM spec → column_filters 해석(날짜/단계는 DB 불필요)
# --------------------------------------------------------------------------- #
def test_spec_date_and_phase_resolve_without_db(monkeypatch):
    from app.ai import structured_qa

    # 오늘을 고정해 last_days 를 결정적으로.
    monkeypatch.setattr(
        structured_qa, "resolve_date_range",
        lambda **kw: resolve_date_range(today=TODAY, **kw),
    )
    spec = {
        "aggregate": True, "intent": "list",
        "date": {"last_days": 7, "period": None, "from": None, "to": None},
        "phase": "finalized", "lifecycle": "ongoing",
    }
    cf = structured_qa._resolve_column_filters(None, spec)
    assert cf["date_from"] == date(2026, 7, 8)
    assert cf["date_to"] == TODAY
    assert cf["phases"] == ["finalized"]
    assert cf["lifecycles"] == ["ongoing"]
    # 종류/작성자 미지정이므로 DB 조회(None db)도 없이 통과.
    assert "report_type_ids" not in cf and "author_ids" not in cf


def test_spec_no_filters_returns_none():
    from app.ai import structured_qa

    assert structured_qa._resolve_column_filters(None, {"aggregate": True}) is None


def test_column_cond_labels_reflect_applied_filters():
    from app.ai import structured_qa

    spec = {"date": {"last_days": 7}, "phase": "drafting"}
    cf = {"date_from": date(2026, 7, 8), "date_to": TODAY, "phases": ["drafting"]}
    labels = structured_qa._column_cond_labels(spec, cf)
    assert "최근 7일" in labels
    assert "작성중" in labels


def test_iso_date_parsing():
    from app.ai import structured_qa

    assert structured_qa._iso_date("2026-07-14") == date(2026, 7, 14)
    assert structured_qa._iso_date("bad") is None
    assert structured_qa._iso_date(None) is None
