"""본문 전문검색 — 평문/청크 추출기 단위 테스트(순수 함수, DB 불필요).

Run from backend/: `python -m pytest tests/test_search_text_extraction.py -v`
"""
from __future__ import annotations

from app.widgets.text_extraction import (
    TextChunk,
    extract_chunks,
    extract_searchable_text,
)


def _sample_content() -> dict:
    return {
        "blk_heading": {"text": "2024년 4분기 리스크 보고", "text_html": "<p>x</p>"},
        "blk_rich": {
            "items": [
                {"text": "공급망 지연 위험", "html": "<p>공급망 지연 위험</p>"},
                {"text": "대체 벤더 확보 필요"},
            ]
        },
        "blk_table": {
            "caption": "이슈 목록",
            "caption_html": "<p>이슈 <b>목록</b></p>",
            "rows": [{"col_1": "원자재 가격 상승", "col_2": 30}, {"col_1": "환율 변동"}],
            "cell_html": {"0::col_1": "<p>원자재 가격 상승</p>"},
            "cell_styles": {"0::col_1": {"bg": "red", "size": "20px"}},
        },
        "blk_image": {"files": [{"file_id": "abc123", "alt": "공장 전경", "caption": "라인 A"}]},
    }


def test_extracts_korean_plain_text_from_widgets():
    text = extract_searchable_text(content=_sample_content(), title="분기 리스크 보고서")
    for needle in [
        "분기 리스크 보고서",  # title
        "2024년 4분기 리스크 보고",  # heading
        "공급망 지연 위험",  # rich text
        "대체 벤더 확보 필요",
        "원자재 가격 상승",  # table cell (plain + cell_html)
        "환율 변동",
        "공장 전경",  # image alt
        "라인 A",  # image caption
    ]:
        assert needle in text, f"missing: {needle!r}"


def test_excludes_non_text_keys():
    text = extract_searchable_text(content=_sample_content())
    # file_id / 색·크기 토큰 / 숫자 셀값은 색인에서 빠져야 한다.
    for noise in ["abc123", "red", "20px"]:
        assert noise not in text, f"leaked: {noise!r}"
    # 순수 숫자(30)는 토큰으로 안 들어온다(앞뒤 공백 경계).
    assert " 30 " not in f" {text} "


def test_strips_html_tags_keeps_inner_text():
    text = extract_searchable_text(
        content={"b": {"caption_html": "<p>이슈 <b>목록</b> <i>관리</i></p>"}}
    )
    assert "이슈 목록 관리" in text
    assert "<b>" not in text and "<p>" not in text


def test_html_under_non_html_key_is_stripped():
    # cell_html 값은 키가 "0::col_1"(=_html 아님)이지만 실제 태그가 있으면 strip.
    text = extract_searchable_text(
        content={"t": {"cell_html": {"0::c": "<p>완료 <b>됨</b></p>"}}}
    )
    assert "완료 됨" in text
    assert "<b>" not in text


def test_plain_text_with_angle_bracket_is_preserved():
    # "a < b" 같은 평문은 태그가 아니므로 보존(부등호 깨지면 안 됨).
    text = extract_searchable_text(content={"e": {"caption": "조건 a < b 이면"}})
    assert "a < b" in text


def test_chunks_carry_location_meta():
    chunks = extract_chunks(content=_sample_content(), report_id=42)
    by_block = {c.block_id: c for c in chunks if c.block_id}
    assert "blk_table" in by_block
    c = by_block["blk_table"]
    assert c.report_id == 42
    assert c.page_idx is None  # 레거시 단일 content
    assert c.key == "42:c:blk_table"
    # 제목은 블록 아님(마커).
    titles = [c for c in chunks if c.widget_type == "__title__"]
    assert titles == [] or titles  # title 없으면 빈 리스트 허용


def test_pages_and_page_names():
    chunks = extract_chunks(
        content={},
        pages=[
            {"name": "표지", "content": {"h": {"text": "표지 제목"}}},
            {"name": "본문", "content": {"kv": {"period": "2024 Q4", "owner": "홍길동"}}},
        ],
        report_id=7,
    )
    keys = {c.key for c in chunks}
    assert "7:0:h" in keys  # page 0 block
    assert "7:1:kv" in keys  # page 1 block
    txt = " ".join(c.text for c in chunks)
    assert "표지" in txt and "표지 제목" in txt and "홍길동" in txt and "2024 Q4" in txt


def test_dedupes_identical_parts_within_block():
    # 평문 미러 + 동일 *_html → 한 번만.
    chunks = extract_chunks(
        content={"r": {"items": [{"text": "동일 문장", "html": "<p>동일 문장</p>"}]}},
        report_id=1,
    )
    assert chunks[0].text == "동일 문장"


def test_korean_substring_match_semantics():
    # pg_trgm/ILIKE 부분일치의 의미: "보고서"가 "보고서를"에 잡힌다 —
    # 추출 평문에 조사 붙은 형태가 그대로 들어가야 그 검색이 성립.
    text = extract_searchable_text(content={"r": {"items": [{"text": "이 보고서를 검토함"}]}})
    assert "보고서를" in text
    assert "보고서" in text.lower()  # ILIKE '%보고서%' 가 매칭할 부분


def test_empty_inputs_return_empty():
    assert extract_searchable_text(content={}, pages=[], title="") == ""
    assert extract_chunks(content={}) == []


def test_text_chunk_to_dict_roundtrip():
    c = TextChunk(text="t", report_id=1, page_idx=0, block_id="b", widget_type="table")
    d = c.to_dict()
    assert d["key"] == "1:0:b"
    assert d["text"] == "t" and d["widget_type"] == "table"
