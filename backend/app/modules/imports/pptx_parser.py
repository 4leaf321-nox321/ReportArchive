"""PPTX → 위젯 세그먼트(휴리스틱, DB 무관·순수).

슬라이드 1개 = 보고서 페이지 1개. 슬라이드 shape 를 (top,left) 순으로 훑어
제목→heading, 텍스트프레임→rich_text, 표→table, 그림→image 세그먼트로 만든다.
차트·SmartArt 등 미지원은 건너뛰고 warnings 에 남긴다(무손실 가장 금지).

반환: {"pages": [{"name", "segments":[...]}], "warnings": [...]}
  세그먼트: {type:'heading', content:{text,level}}
          | {type:'rich_text', content:{items:[{depth,text}]}}
          | {type:'table', content:{columns:[{key,label,type}], rows:[{col_N:val}]}}
          | {type:'image', image_bytes, image_mime, image_ext, alt}
이미지 업로드(→file_id)와 draft 조립은 라우트가 한다(여기선 바이트만 담아 반환).
"""
from __future__ import annotations

from io import BytesIO

MAX_DEPTH = 5


def _pos(shape):
    """(top,left) EMU. None 은 맨 위/왼쪽으로."""
    top = getattr(shape, "top", None)
    left = getattr(shape, "left", None)
    return (top if top is not None else -1, left if left is not None else -1)


def _flatten(shapes):
    """그룹 shape 를 펼쳐 평평한 리스트로."""
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    out = []
    for s in shapes:
        is_group = False
        try:
            is_group = s.shape_type == MSO_SHAPE_TYPE.GROUP
        except Exception:
            is_group = False
        if is_group:
            try:
                out.extend(_flatten(s.shapes))
                continue
            except Exception:
                pass
        out.append(s)
    return out


def _table_segment(rows):
    rows = [r for r in rows if any((c or "").strip() for c in r)] or rows
    if not rows:
        return None
    ncol = max(len(r) for r in rows)
    header = rows[0]
    columns = [
        {
            "key": f"col_{i + 1}",
            "label": (header[i].strip() if i < len(header) and header[i] else "") or f"열 {i + 1}",
            "type": "text",
        }
        for i in range(ncol)
    ]
    body = []
    for r in rows[1:]:
        obj = {}
        for i, col in enumerate(columns):
            obj[col["key"]] = (r[i].strip() if i < len(r) and r[i] else "")
        body.append(obj)
    return {"type": "table", "content": {"columns": columns, "rows": body}}


def _shape_to_segment(shape, *, is_title, slide_no, warnings):
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    stype = None
    try:
        stype = shape.shape_type
    except Exception:
        stype = None

    # 그림
    if stype == MSO_SHAPE_TYPE.PICTURE:
        try:
            img = shape.image
            return {
                "type": "image",
                "image_bytes": img.blob,
                "image_mime": img.content_type or "image/png",
                "image_ext": (img.ext or "png").lstrip("."),
                "alt": (getattr(shape, "name", "") or ""),
            }
        except Exception:
            warnings.append(f"슬라이드 {slide_no}: 이미지 추출 실패 1건")
            return None

    # 표
    if getattr(shape, "has_table", False):
        try:
            tbl = shape.table
            nr, nc = len(tbl.rows), len(tbl.columns)
            rows = [[(tbl.cell(r, c).text or "") for c in range(nc)] for r in range(nr)]
            return _table_segment(rows)
        except Exception:
            warnings.append(f"슬라이드 {slide_no}: 표 추출 실패 1건")
            return None

    # 차트(미지원) — 명시적으로 건너뜀 기록
    if getattr(shape, "has_chart", False):
        warnings.append(f"슬라이드 {slide_no}: 차트 1개 건너뜀(이미지로 다시 붙여주세요)")
        return None

    # 텍스트
    if getattr(shape, "has_text_frame", False):
        try:
            tf = shape.text_frame
            if is_title:
                text = (tf.text or "").strip()
                return {"type": "heading", "content": {"text": text, "level": 1}} if text else None
            items = []
            for p in tf.paragraphs:
                t = (p.text or "").strip()
                if not t:
                    continue
                depth = p.level if isinstance(p.level, int) else 0
                items.append({"depth": max(0, min(MAX_DEPTH, depth)), "text": t})
            return {"type": "rich_text", "content": {"items": items}} if items else None
        except Exception:
            return None

    return None


def parse_pptx(data: bytes) -> dict:
    from pptx import Presentation

    prs = Presentation(BytesIO(data))
    pages = []
    warnings: list[str] = []
    for si, slide in enumerate(prs.slides, 1):
        try:
            title_shape = slide.shapes.title
        except Exception:
            title_shape = None
        name = ""
        # python-pptx 는 접근할 때마다 새 래퍼 객체를 주므로 `is` 비교가 안 된다 →
        # 안정적인 shape_id 로 제목을 식별한다.
        title_id = None
        if title_shape is not None:
            try:
                name = (title_shape.text_frame.text or "").strip()
            except Exception:
                name = ""
            try:
                title_id = title_shape.shape_id
            except Exception:
                title_id = None
        name = name[:120] or f"슬라이드 {si}"

        shapes = _flatten(slide.shapes)
        shapes.sort(key=_pos)
        segments = []
        for shape in shapes:
            try:
                is_title = title_id is not None and shape.shape_id == title_id
            except Exception:
                is_title = False
            seg = _shape_to_segment(
                shape, is_title=is_title, slide_no=si, warnings=warnings
            )
            if seg:
                segments.append(seg)
        pages.append({"name": name, "segments": segments})
    return {"pages": pages, "warnings": warnings}
