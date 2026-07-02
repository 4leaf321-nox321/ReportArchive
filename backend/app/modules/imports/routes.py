"""문서 가져오기 라우트 — POST /api/imports/pptx.

업로드된 .pptx 를 휴리스틱 파싱(pptx_parser) → 위젯 세그먼트 → 이미지 업로드 →
기존 draft 조립(normalize_extra_blocks) → 개인공간 drafting 보고서 생성.
빈(blocks:[]) 호스트 템플릿에 모든 위젯을 extra_blocks 로 담는다(설계 §6.4).
게이트: 인증만(개인 초안 생성이라 보드 쓰기 불필요 — create_ai_draft 와 동일).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.modules.files import services as files_services
from app.modules.imports.pptx_parser import parse_pptx
from app.modules.reports import ai_authoring
from app.modules.reports import services as report_services
from app.modules.reports.schemas import ReportCreate, ReportPage
from app.modules.templates import services as template_services
from app.modules.templates.models import Template
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import created_response, error_response

router = APIRouter()

# 임의 구조 문서를 담는 전용 빈 호스트 템플릿(blocks:[]). 모든 위젯은 extra_blocks 로.
_BLANK_TEMPLATE_ID = "__import_blank__"


def ensure_import_template(db: Session) -> Template:
    """가져오기용 빈 템플릿(멱등 get-or-create). 전사 공개·게시·최신."""
    tpl = template_services.get_template(db, _BLANK_TEMPLATE_ID, 1)
    if tpl:
        return tpl
    tpl = Template(
        template_id=_BLANK_TEMPLATE_ID,
        version=1,
        name="문서 가져오기",
        description="문서 가져오기용 빈 템플릿(모든 위젯은 보고서별 추가 블록으로).",
        category="misc",
        schema={"version": "widget-v1", "blocks": []},
        owner_workspace_slugs=None,
        is_published=True,
        is_latest=True,
        created_by_user_id=None,
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return tpl


def _build_import_page(template_id: str, version: int, name: str, extra_input: list[dict]):
    """세그먼트({id,type,content}) → ReportPage. 문서는 선형이라 **풀폭 세로 스택**
    (auto_layout 의 2단 패킹 대신). content 정규화·prop 기본값은 normalize_extra_blocks
    재사용(AI 초안과 동일 경로)."""
    defs, content, warnings = ai_authoring.normalize_extra_blocks(extra_input)
    blocks_order = [d["id"] for d in defs]
    layout_overrides: dict = {}
    for i, d in enumerate(defs):
        _, height = ai_authoring._LAYOUT_SPEC.get(d["type"], ai_authoring._LAYOUT_DEFAULT)
        layout_overrides[d["id"]] = {"row": i + 1, "col_span": 12, "row_span": height}
    page = ReportPage(
        template_id=template_id,
        template_version=version,
        name=(name[:120] if name else None),
        content=content,
        extra_blocks=defs,
        blocks_order=blocks_order,
        layout_overrides=layout_overrides or None,
        block_sections={},
    )
    return page, warnings


@router.post("/pptx")
async def import_pptx(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 워크스페이스에선 문서를 가져올 수 없습니다."
        )
    data = await file.read()
    if not data:
        return error_response("빈 파일입니다.", status_code=400)
    if len(data) > settings.upload_max_bytes:
        return error_response("파일이 너무 큽니다.", status_code=400)

    try:
        parsed = parse_pptx(data)
    except Exception as exc:  # noqa: BLE001 — 손상/비-PPTX
        return error_response(f"PPTX 를 읽지 못했습니다: {exc}", status_code=400)

    tpl = ensure_import_template(db)
    uid = actor.user.id
    ws = f"personal-{uid}"
    warnings = list(parsed.get("warnings") or [])
    pages: list[ReportPage] = []

    for pi, page in enumerate(parsed.get("pages") or [], 1):
        extra_input: list[dict] = []
        for n, seg in enumerate(page.get("segments") or [], 1):
            bid = f"imp_{pi}_{n}"
            if seg["type"] == "image":
                try:
                    rec = files_services.save_upload(
                        db,
                        filename=f"import.{seg.get('image_ext') or 'png'}",
                        mime_type=seg.get("image_mime") or "image/png",
                        contents=seg["image_bytes"],
                        owner_user_id=uid,
                        workspace_slug=ws,
                    )
                    extra_input.append(
                        {
                            "id": bid,
                            "type": "image",
                            "content": {"files": [{"file_id": rec.id, "alt": seg.get("alt") or ""}]},
                        }
                    )
                except Exception:  # noqa: BLE001
                    warnings.append(f"p{pi}: 이미지 업로드 실패 1건")
            elif seg["type"] == "table":
                # 표는 열 정의를 props.columns 에, 값을 content.rows 에 둔다(위젯 규약).
                cont = seg.get("content") or {}
                extra_input.append(
                    {
                        "id": bid,
                        "type": "table",
                        "props": {"columns": cont.get("columns") or []},
                        "content": {"rows": cont.get("rows") or []},
                    }
                )
            else:
                extra_input.append({"id": bid, "type": seg["type"], "content": seg["content"]})

        rp, w = _build_import_page(tpl.template_id, tpl.version, page.get("name") or f"슬라이드 {pi}", extra_input)
        warnings += [f"p{pi}: {x}" for x in w]
        pages.append(rp)

    if not pages or all(not p.extra_blocks for p in pages):
        return error_response(
            "가져올 내용이 없습니다(지원하는 텍스트·표·이미지를 찾지 못함).", status_code=400
        )

    title = (file.filename or "가져온 문서").rsplit(".", 1)[0][:200] or "가져온 문서"
    report_create = ReportCreate(
        template_id=tpl.template_id,
        template_version=tpl.version,
        title=title,
        pages=pages,
        tags=[],
    )
    try:
        report = report_services.create_report(db, ws, report_create, owner_user_id=uid)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)

    return created_response(
        data={
            "id": report.id,
            "workspace_slug": report.workspace_slug,
            "warnings": warnings,
        }
    )
