"""AI 작성 포맷 → widget-v1 정규화 + 검증 단위 테스트(순수, DB 불필요).

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_authoring.py -v
"""
from __future__ import annotations

from app.modules.reports.ai_authoring import (
    auto_layout,
    build_authoring_guide,
    build_example_input,
    normalize_content,
    normalize_extra_blocks,
)
from app.widgets import validate_layout_overrides, validate_report_content

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


# ── Phase 4: 위젯 확대(차트/파이/진행률/마일스톤/순서도/수식) ──────────────
TEMPLATE2 = {
    "version": "widget-v1",
    "blocks": [
        {"id": "trend", "type": "chart", "props": {
            "label": "추이", "chart_type": "bar", "x_column_key": "month",
            "columns": [
                {"key": "month", "label": "월", "type": "text"},
                {"key": "sales", "label": "매출", "type": "number"},
            ],
        }},
        {"id": "share", "type": "pie", "props": {"label": "비중"}},
        {"id": "prog", "type": "progress_bar", "props": {"label": "진척", "default_max": 100}},
        {"id": "mile", "type": "milestone", "props": {"label": "일정"}},
        {"id": "flow", "type": "flowchart", "props": {"label": "절차"}},
        {"id": "eq", "type": "equation", "props": {"label": "수식"}},
    ],
}


def test_chart_rows_label_to_key_and_numeric_coercion():
    content, warnings = normalize_content(TEMPLATE2, {
        "trend": [
            {"월": "1월", "매출": "1,200"},   # 라벨→키 + 문자열 숫자 강제
            {"month": "2월", "sales": 1500},  # 이미 키 + 숫자
        ],
    })
    assert content["trend"]["rows"] == [
        {"month": "1월", "sales": 1200},
        {"month": "2월", "sales": 1500},
    ]
    assert warnings == []
    validate_report_content(TEMPLATE2, content)


def test_pie_accepts_label_value_map_and_rows():
    c1, _ = normalize_content(TEMPLATE2, {"share": {"항목 A": 40, "항목 B": "60%"}})
    assert c1["share"]["rows"] == [
        {"label": "항목 A", "value": 40},
        {"label": "항목 B", "value": 60},
    ]
    c2, _ = normalize_content(TEMPLATE2, {"share": [{"label": "X", "value": 10}]})
    assert c2["share"]["rows"] == [{"label": "X", "value": 10}]
    validate_report_content(TEMPLATE2, c1)
    validate_report_content(TEMPLATE2, c2)


def test_pie_preserves_display_options():
    """도넛/표시 옵션(chart_type·hole·text_info 등)이 정규화에서 보존돼야 한다."""
    # rows 배열 입력 + 옵션
    c, _ = normalize_content(TEMPLATE2, {"share": {
        "rows": [{"label": "A", "value": 60}, {"label": "B", "value": 40}],
        "chart_type": "donut", "hole": "0.45", "text_info": "label+percent",
        "show_legend": True, "sort": False, "colorscale": "Blues",
    }})
    s = c["share"]
    assert s["chart_type"] == "donut"
    assert s["hole"] == 0.45  # 문자열 "0.45" 도 숫자로 강제
    assert s["text_info"] == "label+percent"
    assert s["show_legend"] is True and s["sort"] is False
    assert s["colorscale"] == "Blues"
    validate_report_content(TEMPLATE2, c)

    # {라벨:값} 매핑 입력에서도 옵션 키는 데이터 행으로 새지 않고 보존된다.
    c2, _ = normalize_content(TEMPLATE2, {"share": {
        "전처리": 30, "솔버": 50, "후처리": 20, "chart_type": "donut", "hole": 0.5,
    }})
    assert c2["share"]["rows"] == [
        {"label": "전처리", "value": 30},
        {"label": "솔버", "value": 50},
        {"label": "후처리", "value": 20},
    ]
    assert c2["share"]["chart_type"] == "donut" and c2["share"]["hole"] == 0.5
    validate_report_content(TEMPLATE2, c2)


def test_progress_milestone_flow_equation_normalize_and_validate():
    content, warnings = normalize_content(TEMPLATE2, {
        "prog": {"설계": 100, "구현": "60%"},                      # {작업:값} 매핑
        "mile": [{"date": "2026-01-15", "label": "킥오프"}],        # date+label
        "flow": ["접수", "검토", "승인"],                          # 문자열 배열 → label
        "eq": "E = mc^2",                                          # 문자열 → latex
    })
    assert content["prog"]["items"] == [
        {"label": "설계", "value": 100},
        {"label": "구현", "value": 60},
    ]
    assert content["mile"]["items"] == [{"date": "2026-01-15", "label": "킥오프"}]
    assert content["flow"]["items"] == [
        {"label": "접수"}, {"label": "검토"}, {"label": "승인"},
    ]
    assert content["eq"] == {"latex": "E = mc^2"}
    assert warnings == []
    validate_report_content(TEMPLATE2, content)


def test_example_input_is_valid_widget_v1():
    """few-shot 예시는 실제로 정규화·검증을 통과해야 한다(잘못된 예시 = 함정)."""
    for tmpl in (TEMPLATE, TEMPLATE2):
        example = build_example_input(tmpl)
        assert "blocks" in example and example["blocks"]
        content, warnings = normalize_content(tmpl, example["blocks"])
        assert warnings == []
        validate_report_content(tmpl, content)


def test_authoring_guide_includes_examples():
    by_id = {g["id"]: g for g in build_authoring_guide(TEMPLATE2)}
    assert by_id["eq"]["example"] == "E = mc^2"
    assert by_id["trend"]["columns"][1]["type"] == "number"  # chart 도 columns 노출
    assert isinstance(by_id["share"]["example"], dict)


# ── auto_layout ────────────────────────────────────────────────────────────
def test_auto_layout_packs_flat_template_into_grid():
    """밋밋한(전폭) 템플릿은 위젯 타입별로 12칸 그리드에 매거진식 배치된다."""
    ov = auto_layout(TEMPLATE2)  # eq(equation,6) + trend(chart,6) + share(pie,6) ...
    assert ov, "flat 템플릿이면 overrides 가 생성돼야 한다"
    # 모든 블록에 row/col_span/row_span 부여
    for bid in (b["id"] for b in TEMPLATE2["blocks"]):
        assert set(ov[bid]) == {"row", "col_span", "row_span"}
    # 검증기를 통과해야 한다(행별 col_span 합 ≤ 12).
    validate_layout_overrides(TEMPLATE2, ov)
    # 반폭(6) 위젯들은 둘씩 같은 행을 공유한다.
    rows = [ov[b["id"]]["row"] for b in TEMPLATE2["blocks"]]
    assert len(set(rows)) < len(rows), "일부 위젯은 같은 행에 나란히 배치돼야 한다"


def test_auto_layout_pairs_two_charts_side_by_side():
    tmpl = {
        "version": "widget-v1",
        "blocks": [
            {"id": "h", "type": "heading", "props": {"level": 1}},
            {"id": "c1", "type": "chart", "props": {
                "label": "a", "chart_type": "bar", "x_column_key": "x",
                "columns": [{"key": "x", "label": "X", "type": "text"},
                            {"key": "y", "label": "Y", "type": "number"}],
            }},
            {"id": "c2", "type": "chart", "props": {
                "label": "b", "chart_type": "bar", "x_column_key": "x",
                "columns": [{"key": "x", "label": "X", "type": "text"},
                            {"key": "y", "label": "Y", "type": "number"}],
            }},
        ],
    }
    ov = auto_layout(tmpl)
    assert ov["h"]["col_span"] == 12  # heading 은 전폭, 자기 행
    assert ov["c1"]["col_span"] == 6 and ov["c2"]["col_span"] == 6
    assert ov["c1"]["row"] == ov["c2"]["row"]  # 차트 2개는 한 행에 나란히
    assert ov["h"]["row"] < ov["c1"]["row"]
    validate_layout_overrides(tmpl, ov)


def test_auto_layout_respects_intentional_template_layout():
    """디자이너가 이미 열 배치(col_span<12)를 해둔 템플릿은 건드리지 않는다."""
    tmpl = {
        "version": "widget-v1",
        "blocks": [
            {"id": "a", "type": "rich_text", "props": {},
             "layout": {"row": 1, "col_span": 6, "row_span": 4}},
            {"id": "b", "type": "rich_text", "props": {},
             "layout": {"row": 1, "col_span": 6, "row_span": 4}},
        ],
    }
    assert auto_layout(tmpl) == {}


def test_auto_layout_empty_template():
    assert auto_layout({"version": "widget-v1", "blocks": []}) == {}


# ── extra_blocks (AI 가 위젯 직접 생성) + hide-empty ─────────────────────────
def test_normalize_extra_blocks_builds_widgets():
    """빈 템플릿이어도 AI 가 위젯 정의+내용을 주면 extra_block_defs + content 로 정규화."""
    defs, content, warnings = normalize_extra_blocks([
        {"id": "h", "type": "heading", "content": {"text": "제목"}},
        {"id": "lst", "type": "bulleted_list", "content": ["a", "b"]},
        {"id": "tbl", "type": "table",
         "props": {"columns": [{"key": "n", "label": "이름", "type": "text"}]},
         "content": [{"n": "X"}]},
    ])
    assert [d["id"] for d in defs] == ["h", "lst", "tbl"]
    assert content["h"] == {"text": "제목"}
    assert content["lst"]["items"] == ["a", "b"]
    assert content["tbl"]["rows"] == [{"n": "X"}]
    # 표는 default_props + 준 props 가 병합돼 columns 가 def 에 실린다.
    tbl_def = next(d for d in defs if d["id"] == "tbl")
    assert tbl_def["props"]["columns"][0]["key"] == "n"
    # 빈 템플릿 + 이 extra_blocks 만으로 검증 통과해야 한다.
    empty = {"version": "widget-v1", "blocks": []}
    validate_report_content(empty, content, extra_blocks=defs)


def test_normalize_extra_blocks_skips_empty_and_unknown():
    defs, content, warnings = normalize_extra_blocks([
        {"id": "ok", "type": "heading", "content": {"text": "있음"}},
        {"id": "empty", "type": "heading", "content": {"text": "   "}},   # 빈 내용 → 제외
        {"id": "bad", "type": "no_such_widget", "content": {}},            # 미지 타입 → 제외
        {"type": "heading", "content": {"text": "no id"}},                 # id 없음 → 제외
    ])
    assert [d["id"] for d in defs] == ["ok"]
    assert set(content) == {"ok"}
    assert len(warnings) >= 3


def test_auto_layout_over_extra_blocks_only():
    """빈 템플릿(include_ids=[]) + extra_blocks 만으로도 그리드 배치가 나온다."""
    extra = [
        {"id": "h", "type": "heading"},
        {"id": "c1", "type": "chart"},
        {"id": "c2", "type": "chart"},
    ]
    ov = auto_layout({"version": "widget-v1", "blocks": []},
                     include_ids=[], extra_blocks=extra)
    assert set(ov) == {"h", "c1", "c2"}
    assert ov["h"]["col_span"] == 12          # heading 전폭
    assert ov["c1"]["col_span"] == 6 and ov["c2"]["col_span"] == 6
    assert ov["c1"]["row"] == ov["c2"]["row"]  # 차트 2개 나란히


def test_auto_layout_include_ids_filters():
    """채운 블록만(include_ids) 배치 — 빈 블록은 레이아웃에서 제외."""
    tmpl = {"version": "widget-v1", "blocks": [
        {"id": "a", "type": "heading"},
        {"id": "b", "type": "rich_text"},
        {"id": "c", "type": "table", "props": {"columns": [{"key": "x", "label": "X", "type": "text"}]}},
    ]}
    ov = auto_layout(tmpl, include_ids=["a", "c"])  # b 제외
    assert set(ov) == {"a", "c"}


# ── 고급 위젯 느슨 정규화(passthrough 보정) ──────────────────────────────────
# AI 가 흔히 틀리는 형식(배열만·name/label·links↔edges·points→rows·
# categories→axis_labels·type→kind·task→label·숫자 문자열)을 보정해 검증 통과시킨다.
_EMPTY_TPL = {"version": "widget-v1", "blocks": []}


def _norm_validate(type_, props, content):
    """extra_blocks 경로로 정규화 후 실제 검증 — 통과하면 정규화된 content 반환."""
    defs, c, _w = normalize_extra_blocks(
        [{"id": "b", "type": type_, "props": props, "content": content}]
    )
    validate_report_content(_EMPTY_TPL, c, extra_blocks=defs)
    return c.get("b")


def test_loose_scatter_array_strnum_and_series_name():
    cols = [
        {"key": "x", "label": "X", "type": "number"},
        {"key": "y", "label": "Y", "type": "number"},
    ]
    props = {"label": "s", "mode": "scatter", "x_column_key": "x", "columns": cols}
    # 배열만 + 숫자 문자열 → {rows:[...]} + 숫자 강제
    out = _norm_validate("scatter", props, [{"x": "0.1", "y": "5"}])
    assert out["rows"][0] == {"x": 0.1, "y": 5}
    # points 별칭 → rows, series name → label
    out = _norm_validate(
        "scatter", props, {"points": [{"x": 1, "y": 2}], "series": [{"name": "A", "x_key": "x", "y_key": "y"}]}
    )
    assert "rows" in out and out["series"][0]["label"] == "A"


def test_loose_box_and_tree_and_waffle():
    out = _norm_validate("box", {"label": "b"}, [{"name": "A", "value": "10"}])
    assert out["rows"][0] == {"group": "A", "value": 10}  # name→group, 숫자화
    out = _norm_validate("tree", {"label": "t"}, [{"name": "루트"}, {"name": "자식", "parent": "루트"}])
    assert out["rows"][0]["label"] == "루트"  # name→label
    out = _norm_validate("waffle", {"label": "w"}, {"items": [{"label": "A", "value": "30"}]})
    assert out["rows"][0]["value"] == 30  # items→rows, 숫자화


def test_loose_network_and_sankey_node_edge():
    # network: links→edges, 문자열 노드→{id}, weight 숫자화
    out = _norm_validate(
        "network", {"label": "n"}, {"nodes": ["A", "B"], "links": [{"source": "A", "target": "B", "weight": "2"}]}
    )
    assert out["nodes"][0]["id"] == "A" and out["edges"][0]["weight"] == 2
    # network dict 노드 label만 → id 보정
    out = _norm_validate(
        "network", {"label": "n"}, {"nodes": [{"label": "A"}], "edges": [{"source": "A", "target": "A"}]}
    )
    assert out["nodes"][0]["id"] == "A"
    # sankey: edges→links, 문자열 노드→{label}, id 제거, value 숫자화
    out = _norm_validate(
        "sankey", {"label": "s"}, {"nodes": ["A", "B"], "edges": [{"source": "A", "target": "B", "value": "5"}]}
    )
    assert out["nodes"][0] == {"label": "A"} and out["links"][0]["value"] == 5


def test_loose_heatmap_radar_matrix():
    out = _norm_validate("heatmap", {"label": "h"}, {"x_labels": ["a", "b"], "y_labels": ["r"], "z": [["1", "2"]]})
    assert out["matrix"] == [[1, 2]]  # z→matrix, 원소 숫자화
    out = _norm_validate(
        "radar", {"label": "r"}, {"categories": ["속도", "품질"], "series": [{"name": "A"}], "values": [["1", "2"]]}
    )
    assert out["axis_labels"] == ["속도", "품질"]  # categories→axis_labels
    assert out["values"] == [[1, 2]] and out["series"][0]["label"] == "A"


def test_loose_comparison_and_raci_aliases():
    out = _norm_validate(
        "comparison",
        {"label": "c", "cases": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}]},
        {"cases": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}],
         "rows": [{"key": "r1", "label": "행", "type": "text", "values": {"a": "x", "b": "y"}}]},
    )
    assert out["rows"][0]["kind"] == "text"  # type→kind
    out = _norm_validate(
        "raci_matrix",
        {"label": "r", "default_roles": [{"key": "pm", "label": "PM"}]},
        {"roles": [{"key": "pm", "label": "PM"}], "rows": [{"task": "작업1", "assignments": {"pm": "R"}}]},
    )
    assert out["rows"][0]["label"] == "작업1"  # task→label
