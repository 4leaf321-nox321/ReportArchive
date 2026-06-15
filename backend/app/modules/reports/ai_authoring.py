"""AI 작성 포맷 → widget-v1 content 변환기.

AI(Claude)가 만든 *느슨한* 블록 입력을 받아, 템플릿이 정의한 위젯에 맞는 엄격한
widget-v1 content 로 정규화한다. 정규화 후엔 app.widgets.validate_report_content 로
검증해, 안 맞으면 그 에러를 AI 에게 돌려 재시도하게 한다(이 모듈은 정규화만 담당).

v1 지원 위젯(텍스트 5종): heading / rich_text / bulleted_list / key_value / table.
그 외 타입은 AI 가 정확한 content(dict)를 주면 그대로 통과, 아니면 건너뛴다.

설계: MCP보고서작성_설계.md
"""
from __future__ import annotations

import re

from app.widgets import get_widget

_SLUG_RE = re.compile(r"[^a-z0-9_]+")


def _slug(s: str) -> str:
    """임의 키를 widget content 키 패턴(^[a-z][a-z0-9_]*)에 맞게 best-effort 변환."""
    out = _SLUG_RE.sub("_", str(s).strip().lower()).strip("_")
    if not out:
        return "field"
    if not out[0].isalpha():
        out = "f_" + out
    return out[:64]


def _columns_maps(columns: list[dict]) -> tuple[set[str], dict[str, str]]:
    """columns 정의 → (열키 집합, 라벨→열키 매핑). AI 가 라벨로 줘도 키로 매핑하려고."""
    keys: set[str] = set()
    label_to_key: dict[str, str] = {}
    for c in columns or []:
        if not isinstance(c, dict):
            continue
        k = c.get("key")
        if not k:
            continue
        keys.add(k)
        lbl = c.get("label")
        if lbl:
            label_to_key[str(lbl).strip()] = k
    return keys, label_to_key


def _resolve_col_key(ck, keys: set[str], label_to_key: dict[str, str]):
    """행 셀의 키(ck)를 열키로 해석. 정의된 열이 있으면 키/라벨로만 매핑하고,
    열 정의가 없는 표(자유 표)면 slug 로 떨어뜨린다. 매칭 실패 시 None."""
    ck_s = str(ck).strip()
    if ck in keys:
        return ck
    mapped = label_to_key.get(ck_s)
    if mapped:
        return mapped
    return _slug(ck) if not keys else None


# 숫자 위젯(차트/파이/진행률 등) 셀 별칭 — AI 가 한글/영문 키로 줘도 매핑.
_LABEL_ALIASES = ("label", "name", "항목", "이름", "구분", "분류")
_VALUE_ALIASES = ("value", "값", "수치", "비중", "비율", "양")
# dict 를 {라벨:값} 매핑으로 해석할 때 데이터가 아닌 메타 키(건너뜀).
_RESERVED_KEYS = {
    "caption", "caption_color", "caption_html", "caption_skip_autofill",
    "items", "rows", "unit", "chart_type", "hole", "colorscale",
    "reverse_scale", "text_info", "text_position", "sort", "show_legend",
    "default_max", "x_axis_title", "y_axis_title", "x_column_key",
    "orientation", "start_date", "end_date", "display_mode", "number",
}


def _num(v):
    """숫자 위젯 값 — 문자열 '70', '1,200', '60%' 도 숫자로(검증이 number 요구)."""
    if isinstance(v, bool) or isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        if s.endswith("%"):
            s = s[:-1].strip()
        try:
            f = float(s)
            return int(f) if f.is_integer() else f
        except ValueError:
            return v
    return v


def _pick(d: dict, aliases):
    """dict 에서 별칭 키 중 처음 매칭되는 값(없으면 None)."""
    for a in aliases:
        if a in d:
            return d[a]
    return None


# ── 마크다운 표식 제거 ────────────────────────────────────────────────────
# 위젯 텍스트는 **평문**으로 렌더된다(마크다운 파서 없음). AI 가 습관적으로
# 섞어 보내는 마크다운 표식이 그대로 별표/우물정자로 보이므로 보수적으로 벗긴다.
# 보수적 = 오탐이 적은 것만: 굵게 `**x**`, 인라인코드 `` `x` ``, 줄머리 표식
# (#, >, -, *, +). 밑줄(_) 기반은 file_id·__init__ 등과 충돌해 건드리지 않는다.
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_MD_CODE_RE = re.compile(r"`([^`\n]+)`")
_MD_LEAD_RE = re.compile(r"^[ \t]{0,3}(?:#{1,6}|>|[-*+])[ \t]+")


def _strip_md(s):
    """한 줄 텍스트에서 마크다운 표식 제거(평문화). 문자열이 아니면 그대로."""
    if not isinstance(s, str) or not s:
        return s
    out = _MD_BOLD_RE.sub(r"\1", s)
    out = _MD_CODE_RE.sub(r"\1", out)
    out = _MD_LEAD_RE.sub("", out)
    return out


# ── 위젯별 정규화 ─────────────────────────────────────────────────────────
def _norm_rich_items(raw) -> list[dict]:
    items: list[dict] = []

    def add(text, depth=0, html=None):
        t = "" if text is None else str(text)
        if not t.strip():
            return
        # 평문 텍스트는 마크다운 표식 제거. html(에디터 rich 마크업)이 따로
        # 오면 그건 HTML 이라 건드리지 않는다.
        it = {"depth": max(0, min(5, int(depth or 0))), "text": _strip_md(t)}
        if html:
            it["html"] = str(html)
        items.append(it)

    if isinstance(raw, str):
        for line in raw.split("\n"):
            add(line)
    elif isinstance(raw, list):
        for el in raw:
            if isinstance(el, str):
                add(el)
            elif isinstance(el, dict) and ("text" in el):
                add(el.get("text"), el.get("depth", 0), el.get("html"))
    elif isinstance(raw, dict):
        if isinstance(raw.get("items"), list):
            return _norm_rich_items(raw["items"])
        if "text" in raw:
            add(raw.get("text"), raw.get("depth", 0), raw.get("html"))
        elif isinstance(raw.get("markdown"), str):
            for line in raw["markdown"].split("\n"):
                add(line)
    return items


def _truthy(v) -> bool:
    """느슨한 boolean 해석 — AI 가 true/"true"/1/"yes" 등으로 줘도 받아들인다."""
    if v is True:
        return True
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes", "y", "on")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    return False


def _with_caption(out: dict, raw) -> dict:
    """AI 가 블록에 caption / 제목 생략 플래그를 같이 주면 통과(스키마 허용 위젯에
    한해 호출). 캡션을 쓰는 모든 위젯이 이 헬퍼를 거치므로 한 곳에서 처리한다."""
    if not isinstance(raw, dict):
        return out
    # 제목 생략 — caption_skip_autofill: true 면 제목 행을 비워둔다(템플릿 라벨
    # 자동 채움을 끔). 화면의 "제목 생략" 토글과 동일. skip 일 땐 caption 이
    # 의미가 없어(편집 UI 도 켜면 caption 을 지움) 함께 비운다.
    if _truthy(raw.get("caption_skip_autofill")):
        out["caption_skip_autofill"] = True
        out.pop("caption", None)
        return out
    if isinstance(raw.get("caption"), str) and raw["caption"].strip():
        out["caption"] = raw["caption"]
    return out


def _coerce_scalar_or_list(v):
    """숫자 강제 — 값이 리스트면 각 원소를(예: density groups[].values), 아니면 스칼라를."""
    if isinstance(v, list):
        return [_num(x) for x in v]
    return _num(v)


def _coerce_matrix(v):
    """중첩(2D+) 숫자 배열의 모든 원소를 숫자로 강제(heatmap/contour matrix, radar values)."""
    if isinstance(v, list):
        return [_coerce_matrix(x) for x in v]
    return _num(v)


def _loose_item(item, lspec: dict):
    """리스트 항목 1개를 느슨 보정 — 키 별칭·제거·숫자강제, 문자열 항목은 from_string 으로 감쌈."""
    if not isinstance(item, dict):
        fs = lspec.get("from_string")
        if fs is not None and isinstance(item, (str, int, float)) and not isinstance(item, bool):
            return {fs: str(item)}
        return item
    out = dict(item)
    for wrong, right in (lspec.get("aliases") or {}).items():
        if wrong in out and right not in out:
            out[right] = out.pop(wrong)
    for k in lspec.get("drop") or []:
        out.pop(k, None)
    num = lspec.get("num")
    if num == "all":
        out = {
            k: (_num(v) if not isinstance(v, (dict, list)) else v) for k, v in out.items()
        }
    elif isinstance(num, (list, tuple)):
        for k in num:
            if k in out:
                out[k] = _coerce_scalar_or_list(out[k])
    return out


# 통과(passthrough) 위젯의 **느슨 입력 보정** 규칙. describe_widgets 가 경고하는
# 흔한 환각/형식 실수를 widget-v1 로 맞춰 검증 통과율을 높인다:
#   - 배열만 줌 → 위젯의 주(主) 리스트 키로 감싸기(array_to)
#   - 키 별칭: name→label, links↔edges, points/dots/data→rows, categories→axis_labels,
#     type→kind, task→label, show_points→show_dots, z/values/data→matrix 등
#   - 숫자 문자열 → 숫자(num), 2D 행렬 원소 강제(matrix), 노드 id 보정(node_id)
# (heading…equation 11종은 위에서 전용 정규화. 파일/임베드 위젯은 여기 없음 = 그대로 통과.)
_PASSTHROUGH: dict[str, dict] = {
    "scatter": {
        "array_to": "rows",
        "key_aliases": {"points": "rows", "dots": "rows", "data": "rows", "items": "rows"},
        "lists": {"rows": {"num": "all"}, "series": {"aliases": {"name": "label"}}},
    },
    "scatter3d": {
        "array_to": "rows",
        "key_aliases": {"points": "rows", "dots": "rows", "data": "rows", "items": "rows"},
        "lists": {"rows": {"num": "all"}, "series": {"aliases": {"name": "label"}}},
    },
    "heatmap": {
        "key_aliases": {"z": "matrix", "values": "matrix", "data": "matrix"},
        "matrix": ["matrix"],
    },
    "contour": {
        "key_aliases": {"z": "matrix", "values": "matrix", "data": "matrix"},
        "matrix": ["matrix"],
        "lists": {"rows": {"num": "all"}},
    },
    "radar": {
        "key_aliases": {"categories": "axis_labels"},
        "matrix": ["values"],
        "lists": {"series": {"aliases": {"name": "label"}}},
    },
    "box": {
        "array_to": "rows",
        "lists": {"rows": {"num": ["value"], "aliases": {"name": "group"}}},
    },
    "density": {
        "array_to": "groups",
        "key_aliases": {"show_points": "show_dots"},
        "lists": {"groups": {"num": ["values"]}},
    },
    "tree": {
        "array_to": "rows",
        "lists": {"rows": {"aliases": {"name": "label", "title": "label"}}},
    },
    "mind_map": {
        "array_to": "rows",
        "lists": {"rows": {"aliases": {"name": "label", "title": "label"}}},
    },
    "treemap": {
        "array_to": "rows",
        "lists": {"rows": {"num": ["value"], "aliases": {"name": "label"}}},
    },
    "packing": {
        "array_to": "rows",
        "lists": {"rows": {"num": ["value"], "aliases": {"name": "label"}}},
    },
    "waffle": {
        "array_to": "rows",
        "key_aliases": {"items": "rows", "data": "rows"},
        "lists": {"rows": {"num": ["value"], "aliases": {"name": "label"}}},
    },
    "network": {
        "key_aliases": {"links": "edges"},
        "lists": {
            "nodes": {"from_string": "id", "node_id": True, "num": ["value"]},
            "edges": {"num": ["weight", "value"]},
        },
    },
    "sankey": {
        "key_aliases": {"edges": "links"},
        "lists": {
            "nodes": {"from_string": "label", "drop": ["id"]},
            "links": {"num": ["value"]},
        },
    },
    "quadrant": {
        "lists": {"plot_items": {"num": ["x", "y", "size", "weight"]}},
    },
    "comparison": {
        "lists": {"rows": {"aliases": {"type": "kind"}}},
    },
    "raci_matrix": {
        "lists": {"rows": {"aliases": {"task": "label"}}},
    },
}


def _normalize_passthrough(wtype: str, raw, warnings: list[str], block_id: str):
    """11종 전용 정규화 밖의 위젯 — 설정(_PASSTHROUGH)이 있으면 느슨 보정,
    없으면(파일/임베드 등) dict 만 그대로 통과."""
    spec = _PASSTHROUGH.get(wtype)
    if spec is None:
        if isinstance(raw, dict):
            return raw
        warnings.append(f"{block_id}: '{wtype}' 위젯은 자동 변환 미지원 — dict content 만 허용, 건너뜀")
        return None
    if isinstance(raw, list):
        if spec.get("array_to"):
            raw = {spec["array_to"]: raw}
        else:
            warnings.append(f"{block_id}: '{wtype}' 는 배열만으론 부족 — 객체 content 필요, 건너뜀")
            return None
    if not isinstance(raw, dict):
        warnings.append(f"{block_id}: '{wtype}' content 형식 불일치 — 건너뜀")
        return None
    out = dict(raw)
    for wrong, right in (spec.get("key_aliases") or {}).items():
        if wrong in out and right not in out:
            out[right] = out.pop(wrong)
    for k in spec.get("matrix") or []:
        if k in out and isinstance(out[k], list):
            out[k] = _coerce_matrix(out[k])
    for lk, lspec in (spec.get("lists") or {}).items():
        if lk in out and isinstance(out[lk], list):
            items = []
            for it in out[lk]:
                ni = _loose_item(it, lspec)
                if (
                    lspec.get("node_id")
                    and isinstance(ni, dict)
                    and "id" not in ni
                    and ni.get("label")
                ):
                    ni["id"] = ni["label"]
                items.append(ni)
            out[lk] = items
    return out or None


def _normalize_block(wtype: str, raw, props: dict, warnings: list[str], block_id: str):
    if wtype == "heading":
        text = raw if isinstance(raw, str) else (raw.get("text") if isinstance(raw, dict) else None)
        if not text or not str(text).strip():
            return None
        out = {"text": _strip_md(str(text))}
        if isinstance(raw, dict) and raw.get("text_html"):
            out["text_html"] = str(raw["text_html"])
        return out

    if wtype == "rich_text":
        items = _norm_rich_items(raw)
        if not items and not _has_caption(raw):
            return None
        out: dict = {"items": items} if items else {}
        return _with_caption(out, raw)

    if wtype == "bulleted_list":
        if isinstance(raw, str):
            items = [x.strip() for x in raw.split("\n") if x.strip()]
        elif isinstance(raw, list):
            items = [str(x).strip() for x in raw if str(x).strip()]
        elif isinstance(raw, dict) and isinstance(raw.get("items"), list):
            items = [str(x).strip() for x in raw["items"] if str(x).strip()]
        else:
            items = []
        # 평문 렌더 — 마크다운 표식 제거(특히 AI 가 붙이는 줄머리 "- " 와 **굵게**).
        items = [_strip_md(x) for x in items]
        if not items:
            return None
        return _with_caption({"items": items}, raw)

    if wtype == "key_value":
        if not isinstance(raw, dict):
            warnings.append(f"{block_id}: key_value 는 객체(키:값)여야 합니다 — 건너뜀")
            return None
        keys, label_to_key = _columns_maps(props.get("items") or [])
        data = {
            k: v
            for k, v in raw.items()
            if k not in ("caption", "caption_color", "caption_html", "caption_skip_autofill", "items")
        }
        out = {}
        if keys:
            # 템플릿이 필드를 정의함 — 키/라벨로 매핑(정의에 없는 키는 무시).
            for k, v in data.items():
                key = k if k in keys else label_to_key.get(str(k).strip())
                if key is None:
                    warnings.append(f"{block_id}: '{k}' 는 정의된 필드가 아니라 무시")
                    continue
                out[key] = v
        else:
            # 필드 정의가 없음(예: AI 가 직접 만든 key_value) — 입력 키로 필드를
            # **합성**한다. 한글 라벨도 그대로 보존하고, 키는 유일 슬러그로(한글이라
            # 슬러그가 'field'/빈값/충돌이면 f_1, f_2 …). 없으면 위젯이 빈 채로 렌더됨.
            items = []
            used: set[str] = set()
            for i, (k, v) in enumerate(data.items(), 1):
                slug = _slug(k)
                if slug in ("field", "") or slug in used:
                    slug = f"f_{i}"
                used.add(slug)
                items.append({"key": slug, "label": str(k), "type": "text"})
                out[slug] = v
            if items:
                out["items"] = items
        return _with_caption(out, raw) if (out or _has_caption(raw)) else None

    if wtype == "table":
        cols = props.get("columns") or []
        keys, label_to_key = _columns_maps(cols)
        if isinstance(raw, dict) and isinstance(raw.get("rows"), list):
            rows_in = raw["rows"]
        elif isinstance(raw, list):
            rows_in = raw
        else:
            warnings.append(f"{block_id}: table 은 행 배열이거나 {{rows:[...]}} 여야 합니다 — 건너뜀")
            return None
        rows = []
        for row in rows_in:
            if not isinstance(row, dict):
                continue
            out_row = {}
            for ck, cv in row.items():
                key = _resolve_col_key(ck, keys, label_to_key)
                if key is None:
                    warnings.append(f"{block_id}: 열 '{ck}' 매칭 실패 — 셀 무시")
                    continue
                out_row[key] = cv
            if out_row:
                rows.append(out_row)
        out = {"rows": rows} if rows else {}
        return _with_caption(out, raw) if (rows or _has_caption(raw)) else None

    if wtype == "chart":
        # table 과 같은 열 모델(props.columns: {key,label,type}). x축 텍스트 열 +
        # 숫자 계열 열. 숫자 열은 '120' 같은 문자열도 숫자로 강제(렌더 위해).
        cols = [c for c in (props.get("columns") or []) if isinstance(c, dict)]
        keys, label_to_key = _columns_maps(cols)
        num_keys = {c["key"] for c in cols if c.get("type") == "number" and c.get("key")}
        if isinstance(raw, dict) and isinstance(raw.get("rows"), list):
            rows_in = raw["rows"]
        elif isinstance(raw, list):
            rows_in = raw
        else:
            warnings.append(f"{block_id}: chart 는 행 배열이거나 {{rows:[...]}} 여야 합니다 — 건너뜀")
            return None
        rows = []
        for row in rows_in:
            if not isinstance(row, dict):
                continue
            out_row = {}
            for ck, cv in row.items():
                key = _resolve_col_key(ck, keys, label_to_key)
                if key is None:
                    warnings.append(f"{block_id}: 열 '{ck}' 매칭 실패 — 셀 무시")
                    continue
                out_row[key] = _num(cv) if key in num_keys else cv
            if out_row:
                rows.append(out_row)
        out: dict = {"rows": rows} if rows else {}
        if isinstance(raw, dict):
            for f in ("chart_type", "x_axis_title", "y_axis_title"):
                if raw.get(f):
                    out[f] = raw[f]
        return _with_caption(out, raw) if (rows or _has_caption(raw)) else None

    if wtype == "pie":
        rows = _norm_value_rows(raw, warnings, block_id)
        if rows is None:
            return None
        out = {"rows": rows} if rows else {}
        if isinstance(raw, dict):
            if isinstance(raw.get("unit"), str):
                out["unit"] = raw["unit"]
            # 파이/도넛 표시 옵션 — AI 가 지정하면 보존(미지정 시 위젯 기본). 이 키들은
            # _RESERVED_KEYS 라 {라벨:값} 매핑 입력에서도 데이터 행으로 새지 않는다.
            # 값의 enum·범위 검증은 validate_report_content 가 맡으므로, 여기선
            # 형(型)만 가볍게 보고 통과시킨다(잘못된 값은 그쪽에서 잡아 재시도).
            if raw.get("chart_type") in ("pie", "donut"):
                out["chart_type"] = raw["chart_type"]
            if raw.get("hole") is not None:
                out["hole"] = _num(raw["hole"])
            for k in ("text_info", "text_position", "colorscale"):
                if isinstance(raw.get(k), str):
                    out[k] = raw[k]
            for k in ("reverse_scale", "sort", "show_legend"):
                if isinstance(raw.get(k), bool):
                    out[k] = raw[k]
        return _with_caption(out, raw) if (rows or _has_caption(raw)) else None

    if wtype == "progress_bar":
        items = _norm_progress_items(raw, warnings, block_id)
        if items is None:
            return None
        out = {"items": items} if items else {}
        if isinstance(raw, dict):
            if isinstance(raw.get("unit"), str):
                out["unit"] = raw["unit"]
            if raw.get("default_max") is not None:
                out["default_max"] = _num(raw["default_max"])
        return _with_caption(out, raw) if (items or _has_caption(raw)) else None

    if wtype == "milestone":
        items = _norm_milestone_items(raw, warnings, block_id)
        if items is None:
            return None
        out = {"items": items} if items else {}
        return _with_caption(out, raw) if (items or _has_caption(raw)) else None

    if wtype == "flowchart":
        items = _norm_flow_items(raw, warnings, block_id)
        if items is None:
            return None
        out = {"items": items} if items else {}
        if isinstance(raw, dict) and raw.get("orientation") in ("horizontal", "vertical"):
            out["orientation"] = raw["orientation"]
        return _with_caption(out, raw) if (items or _has_caption(raw)) else None

    if wtype == "equation":
        latex = raw if isinstance(raw, str) else (raw.get("latex") if isinstance(raw, dict) else None)
        if not latex or not str(latex).strip():
            return None
        out = {"latex": str(latex)}
        if isinstance(raw, dict):
            if raw.get("number"):
                out["number"] = str(raw["number"])
            if raw.get("display_mode") in ("display", "inline"):
                out["display_mode"] = raw["display_mode"]
        return _with_caption(out, raw)

    # 그 외 위젯 — 설정이 있으면 느슨 보정(배열 래핑·키 별칭·숫자강제 등),
    # 없으면(파일/임베드) dict 만 그대로 통과.
    return _normalize_passthrough(wtype, raw, warnings, block_id)


def _has_caption(raw) -> bool:
    return isinstance(raw, dict) and isinstance(raw.get("caption"), str) and bool(raw["caption"].strip())


def _norm_value_rows(raw, warnings: list[str], block_id: str):
    """pie 류 — [{label, value(, color)}] 로. 허용 입력:
    {항목:값} 매핑 / [{label,value}] 배열(한·영 키 별칭) / {rows:[...]}. 형식 못 맞추면 None."""
    if isinstance(raw, dict) and not isinstance(raw.get("rows"), list):
        # {라벨: 값} 매핑 — 데이터 아닌 메타 키는 건너뜀.
        out = []
        for k, v in raw.items():
            if k in _RESERVED_KEYS:
                continue
            out.append({"label": str(k), "value": _num(v)})
        return out
    if isinstance(raw, dict):
        rows_in = raw["rows"]
    elif isinstance(raw, list):
        rows_in = raw
    else:
        warnings.append(f"{block_id}: 비중 데이터는 {{항목:값}} 객체나 행 배열이어야 합니다 — 건너뜀")
        return None
    rows = []
    for row in rows_in:
        if not isinstance(row, dict):
            continue
        item = {}
        label = _pick(row, _LABEL_ALIASES)
        if label is not None:
            item["label"] = str(label)
        value = _pick(row, _VALUE_ALIASES)
        if value is not None:
            item["value"] = _num(value)
        if isinstance(row.get("color"), str):
            item["color"] = row["color"]
        if item:
            rows.append(item)
    return rows


def _norm_progress_items(raw, warnings: list[str], block_id: str):
    """progress_bar — [{label, value(, max, note, status)}]. {작업:값} 매핑도 허용."""
    if isinstance(raw, dict) and not isinstance(raw.get("items"), list):
        return [
            {"label": str(k), "value": _num(v)}
            for k, v in raw.items()
            if k not in _RESERVED_KEYS
        ]
    if isinstance(raw, dict):
        items_in = raw["items"]
    elif isinstance(raw, list):
        items_in = raw
    else:
        warnings.append(f"{block_id}: 진행률은 {{작업:값}} 객체나 [{{label,value}}] 배열이어야 합니다 — 건너뜀")
        return None
    out = []
    for it in items_in:
        if not isinstance(it, dict):
            continue
        o = {}
        label = _pick(it, _LABEL_ALIASES + ("작업", "task"))
        if label is not None:
            o["label"] = str(label)
        value = _pick(it, _VALUE_ALIASES + ("진행률", "progress"))
        if value is not None:
            o["value"] = _num(value)
        mx = _pick(it, ("max", "목표", "target"))
        if mx is not None:
            o["max"] = _num(mx)
        note = _pick(it, ("note", "비고", "메모"))
        if note is not None:
            o["note"] = str(note)
        if it.get("status") in ("pending", "in_progress", "done", "blocked"):
            o["status"] = it["status"]
        if o:
            out.append(o)
    return out


def _norm_milestone_items(raw, warnings: list[str], block_id: str):
    """milestone — [{date, label(, note, status)}]. date 는 YYYY-MM-DD(검증이 잡음)."""
    if isinstance(raw, dict) and isinstance(raw.get("items"), list):
        items_in = raw["items"]
    elif isinstance(raw, list):
        items_in = raw
    else:
        warnings.append(f"{block_id}: 마일스톤은 [{{date,label}}] 배열이어야 합니다 — 건너뜀")
        return None
    out = []
    for it in items_in:
        if not isinstance(it, dict):
            continue
        o = {}
        date = _pick(it, ("date", "날짜", "일자", "일정"))
        if date is not None:
            o["date"] = str(date)
        label = _pick(it, _LABEL_ALIASES + ("내용", "마일스톤"))
        if label is not None:
            o["label"] = str(label)
        note = _pick(it, ("note", "비고", "메모"))
        if note is not None:
            o["note"] = str(note)
        if it.get("status") in ("pending", "done", "delayed"):
            o["status"] = it["status"]
        if o:
            out.append(o)
    return out


def _norm_flow_items(raw, warnings: list[str], block_id: str):
    """flowchart — [{label(, description)}]. 단계 문자열 배열/줄바꿈 문자열도 허용."""
    if isinstance(raw, str):
        return [{"label": s.strip()} for s in raw.split("\n") if s.strip()]
    if isinstance(raw, dict) and isinstance(raw.get("items"), list):
        items_in = raw["items"]
    elif isinstance(raw, list):
        items_in = raw
    else:
        warnings.append(f"{block_id}: 순서도는 단계 문자열 배열이나 [{{label}}] 이어야 합니다 — 건너뜀")
        return None
    out = []
    for it in items_in:
        if isinstance(it, str):
            if it.strip():
                out.append({"label": it.strip()})
        elif isinstance(it, dict):
            o = {}
            label = _pick(it, _LABEL_ALIASES + ("단계", "step", "내용"))
            if label is not None:
                o["label"] = str(label)
            desc = _pick(it, ("description", "desc", "설명", "비고"))
            if desc is not None:
                o["description"] = str(desc)
            if o:
                out.append(o)
    return out


# ── 자동 레이아웃 ──────────────────────────────────────────────────────────
# AI/MCP 초안은 레이아웃을 못 준다(create_report_draft 는 내용만 받음). 템플릿이
# 열 배치를 안 해두면 모든 위젯이 전폭·세로로만 쌓여 밋밋하다. 여기서 위젯 타입별
# 크기 휴리스틱으로 12칸 그리드에 매거진식(차트 2단, 표·비교표 전폭 등)으로 재배치한
# layout_overrides 를 만들어 ai-draft 가 적용한다. 프런트는 같은 row 의 블록을
# col_span 누적으로 가로 배치하고(ReportDetailPage.buildRglItems) 세로 빈칸은
# 압축하므로(compactVerticalLayout), row 는 절대좌표가 아닌 논리 행 번호면 된다.
_GRID_COLS = 12

# (col_span, row_span). 시각 위젯(차트·다이어그램 = 프런트 WIDGETS_DEFAULT_NO_AUTOFIT)
# 은 고정 높이라 row_span 이 실제 높이가 되고, 텍스트류는 auto-fit 이라 초기값이다.
# row_span 단위는 프런트 REPORT_ROW_HEIGHT(8px) 기준 — 34 ≈ 270px.
_LAYOUT_SPEC: dict[str, tuple[int, int]] = {
    "heading": (12, 4),
    "rich_text": (12, 12),
    "key_value": (6, 12),
    "bulleted_list": (6, 10),
    "table": (12, 16),
    "image": (6, 30),
    "attachment": (12, 6),
    "video": (6, 30),
    "html_embed": (12, 40),
    "chart": (6, 34),
    "scatter": (6, 34),
    "scatter3d": (6, 38),
    "heatmap": (6, 34),
    "contour": (6, 34),
    "treemap": (6, 34),
    "packing": (6, 34),
    "tree": (6, 34),
    "network": (6, 34),
    "mind_map": (6, 34),
    "pie": (6, 34),
    "waffle": (6, 34),
    "box": (6, 34),
    "density": (6, 34),
    "radar": (6, 34),
    "equation": (6, 8),
    "milestone": (12, 16),
    "flowchart": (12, 14),
    "progress_bar": (6, 12),
    "raci_matrix": (12, 16),
    "comparison": (12, 18),
    "cad_3d": (12, 40),
    "quadrant": (6, 34),
    "sankey": (12, 40),
}
_LAYOUT_DEFAULT = (12, 28)


def _is_flat_layout(blocks: list[dict]) -> bool:
    """템플릿이 열 배치를 안 한 '밋밋한'(전부 전폭 또는 미지정) 상태인지. 디자이너가
    의도적으로 2단 등 배치를 해둔 템플릿이면 손대지 않으려는 가드."""
    for b in blocks:
        cs = (b.get("layout") or {}).get("col_span")
        if cs is not None and cs != _GRID_COLS:
            return False
    return True


def auto_layout(
    template_schema: dict,
    include_ids: list[str] | None = None,
    extra_blocks: list[dict] | None = None,
) -> dict:
    """템플릿 블록(+AI 가 추가한 extra 블록)을 위젯 타입별 크기 휴리스틱으로 12칸
    그리드에 매거진식 재배치한 layout_overrides({block_id: {row, col_span, row_span}}).
    의도적 열 배치가 있으면 빈 dict 로 원본 존중.

    - include_ids: 주면 그 id 의 템플릿 블록만 배치(=AI 가 채운 것만 보일 때). None=전부.
    - extra_blocks: AI 가 직접 정의해 추가한 블록들([{id, type, ...}]). 템플릿 블록
      뒤에 같은 규칙으로 흐른다. 빈 템플릿이어도 이걸로 레이아웃이 만들어진다."""
    tpl = [
        b
        for b in (template_schema.get("blocks") or [])
        if isinstance(b, dict) and b.get("id")
    ]
    if include_ids is not None:
        keep = set(include_ids)
        tpl = [b for b in tpl if b["id"] in keep]
    blocks = tpl + [
        b for b in (extra_blocks or []) if isinstance(b, dict) and b.get("id")
    ]
    if not blocks or not _is_flat_layout(blocks):
        return {}
    overrides: dict = {}
    row = 1
    used = 0
    for b in blocks:
        span, height = _LAYOUT_SPEC.get(b.get("type"), _LAYOUT_DEFAULT)
        span = max(1, min(_GRID_COLS, span))
        if used + span > _GRID_COLS:
            row += 1
            used = 0
        overrides[b["id"]] = {"row": row, "col_span": span, "row_span": height}
        used += span
        if used >= _GRID_COLS:
            row += 1
            used = 0
    return overrides


# ── 공개 API ─────────────────────────────────────────────────────────────
def normalize_content(template_schema: dict, blocks_input: dict) -> tuple[dict, list[str]]:
    """AI 의 느슨한 블록 입력 → widget-v1 content(block_id→content). 매핑 못한 건
    warnings 로 알린다(검증은 호출부에서 validate_report_content 로)."""
    by_id = {
        b["id"]: b
        for b in (template_schema.get("blocks") or [])
        if isinstance(b, dict) and b.get("id")
    }
    content: dict = {}
    warnings: list[str] = []
    for block_id, raw in (blocks_input or {}).items():
        b = by_id.get(block_id)
        if b is None:
            warnings.append(f"템플릿에 없는 block_id '{block_id}' — 건너뜀")
            continue
        norm = _normalize_block(b.get("type"), raw, b.get("props") or {}, warnings, block_id)
        if norm is not None:
            content[block_id] = norm
    return content, warnings


def normalize_extra_blocks(extra_input: list[dict] | None) -> tuple[list[dict], dict, list[str]]:
    """AI 가 **직접 정의한 위젯 목록** → (extra_block_defs, content, warnings).
    빈 템플릿(블록 0개)이거나 템플릿에 없는 위젯이 필요할 때, AI 가 위젯을
    만들면서 보고서를 짓게 한다. 각 항목: {id, type, props?, content}.
      - props 는 위젯 default_props 와 병합(표·차트 등 필수 props 자동 채움).
      - content 는 느슨한 입력 → _normalize_block 으로 정규화.
    내용이 비면(정규화 결과 None) 그 블록은 추가하지 않는다(= '채운 것만' 원칙)."""
    defs: list[dict] = []
    content: dict = {}
    warnings: list[str] = []
    seen: set[str] = set()
    for item in extra_input or []:
        if not isinstance(item, dict):
            continue
        bid, btype = item.get("id"), item.get("type")
        if not isinstance(bid, str) or not bid or not isinstance(btype, str) or not btype:
            warnings.append("extra block: id/type 누락 — 건너뜀")
            continue
        if bid in seen:
            warnings.append(f"extra block '{bid}': 중복 id — 건너뜀")
            continue
        try:
            w = get_widget(btype)
        except Exception:
            warnings.append(f"extra block '{bid}': 알 수 없는 위젯 '{btype}' — 건너뜀")
            continue
        props = {**(w.get("default_props") or {}), **(item.get("props") or {})}
        norm = _normalize_block(btype, item.get("content"), props, warnings, bid)
        if norm is None:
            warnings.append(f"extra block '{bid}'({btype}): 내용 없음/형식 불일치 — 건너뜀")
            continue
        seen.add(bid)
        defs.append({"id": bid, "type": btype, "props": props})
        content[bid] = norm
    return defs, content, warnings


def build_authoring_guide(template_schema: dict) -> list[dict]:
    """각 블록을 AI 가 채울 수 있게 안내. describe_template 도구 출력/프롬프트용.
    반환: [{id, type, label, required, slot, hint}] — hint 에 표/선택지의 열키·라벨·옵션."""
    guide: list[dict] = []
    for b in template_schema.get("blocks") or []:
        if not isinstance(b, dict) or not b.get("id"):
            continue
        wtype = b.get("type")
        props = b.get("props") or {}
        try:
            w = get_widget(wtype)
            has_content = bool(w.get("has_content", True))
        except Exception:
            has_content = True
        entry = {
            "id": b["id"],
            "type": wtype,
            "label": props.get("label") or b["id"],
            "required": bool(props.get("required")),
            "fillable": has_content,
        }
        if props.get("placeholder"):
            entry["placeholder"] = props["placeholder"]
        if wtype in ("table", "chart"):
            entry["columns"] = [
                {
                    "key": c.get("key"),
                    "label": c.get("label"),
                    "type": c.get("type"),
                    **({"options": c["options"]} if c.get("options") else {}),
                }
                for c in (props.get("columns") or [])
                if isinstance(c, dict)
            ]
            if wtype == "table":
                entry["hint"] = "행 배열로. 각 행은 {열키: 값}. 위 columns 의 key 를 쓰세요."
            else:
                entry["hint"] = "행 배열로. x축 열 + 숫자 계열 열을 columns 의 key(또는 label)로 채우세요."
        elif wtype == "key_value":
            fields = props.get("items") or []
            if fields:
                entry["fields"] = [
                    {"key": f.get("key"), "label": f.get("label"), "type": f.get("type"),
                     **({"options": f["options"]} if f.get("options") else {})}
                    for f in fields if isinstance(f, dict)
                ]
            entry["hint"] = "{필드키: 값} 객체로."
        elif wtype == "rich_text":
            entry["hint"] = "문단 문자열, 또는 [{text, depth}] (depth 0~5 들여쓰기)."
        elif wtype == "bulleted_list":
            entry["hint"] = "문자열 배열(각 항목 한 줄)."
        elif wtype == "heading":
            entry["hint"] = "제목 문자열."
        elif wtype == "pie":
            entry["hint"] = "{항목: 값} 객체 또는 [{label, value}] 배열(비중)."
        elif wtype == "progress_bar":
            entry["hint"] = "[{label, value, max?}] 또는 {작업: 값} 객체. 기본 목표는 100."
        elif wtype == "milestone":
            entry["hint"] = "[{date: 'YYYY-MM-DD', label, status?}] 배열."
        elif wtype == "flowchart":
            entry["hint"] = "단계 문자열 배열 ['1단계','2단계'] 또는 [{label, description}]."
        elif wtype == "equation":
            entry["hint"] = "LaTeX 문자열. 예: 'E = mc^2'."
        # few-shot: 이 블록을 실제 라벨·열키·선택지로 채운 예시(있으면).
        example = _example_for(wtype, props)
        if example is not None:
            entry["example"] = example
        guide.append(entry)
    return guide


# ── few-shot 예시 생성 ────────────────────────────────────────────────────
def _sample_value(field: dict):
    """필드/열 정의 → 타입에 맞는 예시 값(select 는 첫 옵션, number 0, date 날짜)."""
    t = field.get("type")
    if t == "select" and field.get("options"):
        return field["options"][0]
    if t in ("number", "integer"):
        return 0
    if t == "date":
        return "2026-01-01"
    return "값"


def _example_for(wtype: str, props: dict):
    """이 위젯을 채운 **느슨한 입력** 예시. 템플릿의 실제 라벨/열키/옵션을 써서
    AI 가 그대로 흉내내면 되도록(few-shot). 미지원 위젯은 None."""
    if wtype == "heading":
        return props.get("default_text") or "제목 텍스트"
    if wtype == "rich_text":
        return ["첫 번째 문단입니다.", "두 번째 문단입니다."]
    if wtype == "bulleted_list":
        return ["첫째 항목", "둘째 항목", "셋째 항목"]
    if wtype == "key_value":
        fields = [f for f in (props.get("items") or []) if isinstance(f, dict) and (f.get("label") or f.get("key"))]
        if fields:
            return {(f.get("label") or f.get("key")): _sample_value(f) for f in fields}
        return {"항목": "값"}
    if wtype == "table":
        cols = [c for c in (props.get("columns") or []) if isinstance(c, dict) and (c.get("label") or c.get("key"))]
        if cols:
            return [{(c.get("label") or c.get("key")): _sample_value(c) for c in cols}]
        return [{"열1": "값", "열2": "값"}]
    if wtype == "chart":
        cols = [c for c in (props.get("columns") or []) if isinstance(c, dict) and (c.get("label") or c.get("key"))]
        if not cols:
            return [{"항목": "1월", "값": 120}, {"항목": "2월", "값": 150}]
        rows = []
        for i in range(2):
            row = {}
            for c in cols:
                name = c.get("label") or c.get("key")
                row[name] = (120 + 30 * i) if c.get("type") == "number" else f"항목{i + 1}"
            rows.append(row)
        return rows
    if wtype == "pie":
        return {"항목 A": 40, "항목 B": 35, "항목 C": 25}
    if wtype == "progress_bar":
        return [{"label": "설계", "value": 100}, {"label": "구현", "value": 60}]
    if wtype == "milestone":
        return [{"date": "2026-01-15", "label": "킥오프"}, {"date": "2026-03-01", "label": "1차 완료"}]
    if wtype == "flowchart":
        return ["요청 접수", "검토", "승인", "완료"]
    if wtype == "equation":
        return "E = mc^2"
    return None


def build_example_input(template_schema: dict) -> dict:
    """템플릿 전체를 채운 AI 입력 예시({title, blocks}). describe_template 가 한 번에
    보여줘서, AI 가 ai_draft 호출 형태를 그대로 흉내내게 한다(few-shot)."""
    blocks: dict = {}
    for b in template_schema.get("blocks") or []:
        if not isinstance(b, dict) or not b.get("id"):
            continue
        ex = _example_for(b.get("type"), b.get("props") or {})
        if ex is not None:
            blocks[b["id"]] = ex
    return {"title": "<보고서 제목>", "blocks": blocks}
