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


# ── 위젯별 정규화 ─────────────────────────────────────────────────────────
def _norm_rich_items(raw) -> list[dict]:
    items: list[dict] = []

    def add(text, depth=0, html=None):
        t = "" if text is None else str(text)
        if not t.strip():
            return
        it = {"depth": max(0, min(5, int(depth or 0))), "text": t}
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


def _with_caption(out: dict, raw) -> dict:
    """AI 가 블록에 caption 을 같이 주면 통과(스키마 허용 위젯에 한해 호출)."""
    if isinstance(raw, dict) and isinstance(raw.get("caption"), str) and raw["caption"].strip():
        out["caption"] = raw["caption"]
    return out


def _normalize_block(wtype: str, raw, props: dict, warnings: list[str], block_id: str):
    if wtype == "heading":
        text = raw if isinstance(raw, str) else (raw.get("text") if isinstance(raw, dict) else None)
        if not text or not str(text).strip():
            return None
        out = {"text": str(text)}
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
        if not items:
            return None
        return _with_caption({"items": items}, raw)

    if wtype == "key_value":
        if not isinstance(raw, dict):
            warnings.append(f"{block_id}: key_value 는 객체(키:값)여야 합니다 — 건너뜀")
            return None
        keys, label_to_key = _columns_maps(props.get("items") or [])
        out = {}
        for k, v in raw.items():
            if k in ("caption", "caption_color", "caption_html", "caption_skip_autofill", "items"):
                continue
            key = k if k in keys else label_to_key.get(str(k).strip()) or (_slug(k) if not keys else None)
            if key is None:
                warnings.append(f"{block_id}: '{k}' 는 정의된 필드가 아니라 무시")
                continue
            out[key] = v
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
                key = ck if ck in keys else label_to_key.get(str(ck).strip()) or (_slug(ck) if not keys else None)
                if key is None:
                    warnings.append(f"{block_id}: 열 '{ck}' 매칭 실패 — 셀 무시")
                    continue
                out_row[key] = cv
            if out_row:
                rows.append(out_row)
        out = {"rows": rows} if rows else {}
        return _with_caption(out, raw) if (rows or _has_caption(raw)) else None

    # 그 외 위젯 — AI 가 정확한 content(dict)를 줬다고 보고 그대로 통과.
    if isinstance(raw, dict):
        return raw
    warnings.append(f"{block_id}: '{wtype}' 위젯은 자동 변환 미지원 — dict content 만 허용, 건너뜀")
    return None


def _has_caption(raw) -> bool:
    return isinstance(raw, dict) and isinstance(raw.get("caption"), str) and bool(raw["caption"].strip())


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
        if wtype == "table":
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
            entry["hint"] = "행 배열로. 각 행은 {열키: 값}. 위 columns 의 key 를 쓰세요."
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
        guide.append(entry)
    return guide
