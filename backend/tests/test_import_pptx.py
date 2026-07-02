"""문서 가져오기 — PPTX → 보고서 초안(휴리스틱). python-pptx 로 인메모리 .pptx 를
만들어 업로드 → 제목/문단/표/이미지 위젯이 extra_blocks 로 생성되는지 검증.
"""
from __future__ import annotations

import base64
from io import BytesIO

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = 2

# 1x1 PNG.
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _h(uid, slug):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _make_pptx() -> bytes:
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[5])  # Title Only
    slide.shapes.title.text = "제목 슬라이드"
    tb = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(5), Inches(1))
    tf = tb.text_frame
    tf.text = "첫 문단"
    tf.add_paragraph().text = "둘째 문단"
    table = slide.shapes.add_table(2, 2, Inches(1), Inches(4), Inches(5), Inches(1)).table
    table.cell(0, 0).text = "이름"
    table.cell(0, 1).text = "값"
    table.cell(1, 0).text = "철수"
    table.cell(1, 1).text = "90"
    slide.shapes.add_picture(BytesIO(_PNG), Inches(1), Inches(6), Inches(1), Inches(1))
    buf = BytesIO()
    prs.save(buf)
    return buf.getvalue()


def _drop_files(file_ids):
    if not file_ids:
        return
    from app.modules.files.models import File

    db = SessionLocal()
    try:
        for fid in file_ids:
            f = db.get(File, fid)
            if f:
                db.delete(f)
        db.commit()
    finally:
        db.close()


def test_import_pptx_returns_draft():
    """PPTX → report_archive_draft_v1 draft(보고서 미생성). 4종 위젯·이미지 file_id 확인."""
    c = TestClient(app)
    data = _make_pptx()
    r = c.post(
        "/api/imports/pptx",
        headers=_h(ADMIN, "personal-2"),
        files={
            "file": (
                "테스트.pptx",
                data,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
        },
    )
    assert r.status_code in (200, 201), r.text
    draft = r.json()["data"]["draft"]
    assert draft["_type"] == "report_archive_draft_v1"
    page = draft["pages"][0]
    extra = page.get("extra_blocks") or []
    content = page.get("content") or {}
    types = {b.get("type") for b in extra}
    assert {"heading", "rich_text", "table", "image"} <= types, types
    img_ids = [b["id"] for b in extra if b.get("type") == "image"]
    assert img_ids
    files = (content.get(img_ids[0]) or {}).get("files") or []
    assert files and files[0].get("file_id"), content.get(img_ids[0])
    assert page.get("name") == "제목 슬라이드"
    _drop_files([f["file_id"] for f in files])


def test_import_pptx_requires_auth():
    c = TestClient(app)
    r = c.post(
        "/api/imports/pptx",
        files={"file": ("x.pptx", b"not-a-pptx", "application/octet-stream")},
    )
    assert r.status_code in (401, 403), r.text
