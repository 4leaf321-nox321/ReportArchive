"""AI 작성 포맷 → widget-v1 정규화 + 검증 단위 테스트(순수, DB 불필요).

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_authoring.py -v
"""
from __future__ import annotations

from app.modules.reports.ai_authoring import build_authoring_guide, normalize_content
from app.widgets import validate_report_content

# 시드(weekly-dev) 류 템플릿 — 텍스트 위젯 5종.
TEMPLATE = {
    "version": "widget-v1",
    "blocks": [
        {"id": "title_h", "type": "heading", "props": {"label": "제목", "level": 1}},
        {"id": "meta", "type": "key_value", "props": {
            "label": "메타",
            "items": [
                {"key": "period", "label": "보고 기간", "type": "text"},
                {"key": "owner", "label": "작성자", "type": "text"},
            ],
        }},
        {"id": "summary", "type": "rich_text", "props": {"label": "요약"}},
        {"id": "progress", "type": "bulleted_list", "props": {"label": "진행 항목"}},
        {"id": "issues", "type": "table", "props": {
            "label": "이슈",
            "columns": [
                {"key": "issue", "label": "이슈", "type": "text"},
                {"key": "severity", "label": "심각도", "type": "select",
                 "options": ["낮음", "보통", "높음"]},
            ],
        }},
    ],
}


def _validate(content):
    # 통과하면 예외 없음.
    validate_report_content(TEMPLATE, content)


def test_normalizes_loose_ai_input_to_valid_widget_v1():
    ai_blocks = {
        "title_h": "2026 2분기 리스크 보고",                     # str → {text}
        "meta": {"보고 기간": "2026 Q2", "owner": "홍길동"},     # 라벨/키 혼용 → 키 매핑
        "summary": ["공급망 지연 위험", "대체 벤더 확보 필요"],   # list → items depth0
        "progress": ["설계 완료", "구현 70%"],                   # list → items[str]
        "issues": [                                              # 행 배열(라벨 키) → 열키 매핑
            {"이슈": "원자재 가격 상승", "심각도": "높음"},
            {"issue": "환율 변동", "severity": "보통"},
        ],
    }
    content, warnings = normalize_content(TEMPLATE, ai_blocks)

    assert content["title_h"] == {"text": "2026 2분기 리스크 보고"}
    assert content["meta"] == {"period": "2026 Q2", "owner": "홍길동"}  # 라벨→키
    assert content["summary"]["items"] == [
        {"depth": 0, "text": "공급망 지연 위험"},
        {"depth": 0, "text": "대체 벤더 확보 필요"},
    ]
    assert content["progress"]["items"] == ["설계 완료", "구현 70%"]
    assert content["issues"]["rows"] == [
        {"issue": "원자재 가격 상승", "severity": "높음"},  # 라벨→키
        {"issue": "환율 변동", "severity": "보통"},          # 이미 키
    ]
    assert warnings == []
    _validate(content)  # widget-v1 검증 통과


def test_rich_text_string_and_depth():
    content, _ = normalize_content(TEMPLATE, {"summary": "한 줄 요약"})
    assert content["summary"]["items"] == [{"depth": 0, "text": "한 줄 요약"}]
    content2, _ = normalize_content(
        TEMPLATE, {"summary": [{"text": "상위", "depth": 0}, {"text": "하위", "depth": 1}]}
    )
    assert content2["summary"]["items"][1] == {"depth": 1, "text": "하위"}
    _validate(content)
    _validate(content2)


def test_unknown_block_and_unknown_field_warn_not_crash():
    content, warnings = normalize_content(
        TEMPLATE,
        {"nope": "x", "meta": {"보고 기간": "Q2", "없는필드": "v"}},
    )
    assert "nope" not in content
    assert content["meta"] == {"period": "Q2"}  # 없는필드 무시
    assert any("nope" in w for w in warnings)
    assert any("없는필드" in w for w in warnings)
    _validate(content)


def test_partial_draft_ok():
    # 일부 블록만 채워도 유효(부분 draft).
    content, _ = normalize_content(TEMPLATE, {"title_h": "제목만"})
    assert set(content.keys()) == {"title_h"}
    _validate(content)


def test_authoring_guide_exposes_columns_and_fields():
    guide = build_authoring_guide(TEMPLATE)
    by_id = {g["id"]: g for g in guide}
    assert by_id["issues"]["columns"][1]["options"] == ["낮음", "보통", "높음"]
    assert by_id["meta"]["fields"][0]["key"] == "period"
    assert by_id["title_h"]["type"] == "heading"
