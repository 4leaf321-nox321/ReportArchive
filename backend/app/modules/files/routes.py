"""File upload / download / metadata endpoints.

Authorization model:
  - Upload: any authenticated user with workspace context. The file is
    tagged with the actor's user_id + active workspace_slug.
  - Download / metadata: any authenticated user. We deliberately don't
    gate downloads by workspace tree right now — file_ids are referenced
    from reports, so practical visibility is gated by report visibility
    one level up. Tighten when needed.
  - Delete: file owner or admin.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File as FastAPIFile, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from pathlib import Path

from app.config import settings
from app.database import get_db
from app.modules.files import services
from app.modules.files.schemas import FileMeta
from app.modules.users.models import Role
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import created_response, not_found_response, success_response
from app.shared.storage import assert_space_for


# Extensions that route through the CAD upload limit instead of the
# general image limit. Listed lowercase; matched against the filename's
# trailing suffix. Includes both web-ready meshes (GLB/GLTF/STL/OBJ)
# and STEP/IGES — STEP/IGES are converted server-side by Phase 5, but
# accepting them through the upload guard here keeps the user flow
# uniform when that phase lands.
_CAD_EXTENSIONS: frozenset[str] = frozenset({
    ".glb", ".gltf",
    ".stl", ".obj", ".ply", ".fbx", ".3mf",
    ".step", ".stp", ".iges", ".igs",
})


def _upload_limit_for(filename: str) -> int:
    ext = Path(filename or "").suffix.lower()
    if ext in _CAD_EXTENSIONS:
        return settings.upload_max_bytes_cad
    return settings.upload_max_bytes

router = APIRouter()


@router.post("")
async def upload_file(
    file: UploadFile = FastAPIFile(...),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    contents = await file.read()
    limit = _upload_limit_for(file.filename or "")
    if len(contents) > limit:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"파일이 너무 큽니다. 최대 {limit // (1024 * 1024)} MB.",
        )
    if len(contents) == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "빈 파일은 업로드할 수 없습니다.")
    # 413 (too big for our policy) is separate from 507 (no room on disk).
    # Both can hit on a busy server — guarding here lets the client show
    # a clear error before we waste an fsync.
    assert_space_for(len(contents))

    record = services.save_upload(
        db,
        filename=file.filename or "unnamed",
        mime_type=file.content_type or "application/octet-stream",
        contents=contents,
        owner_user_id=actor.user.id,
        workspace_slug=actor.workspace.slug,
    )
    return created_response(data=FileMeta.model_validate(record))


@router.get("/{file_id}/meta")
def get_meta(
    file_id: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(get_current_user),
):
    record = services.get_file(db, file_id)
    if not record:
        return not_found_response(f"파일을 찾을 수 없습니다: {file_id}")
    return success_response(data=FileMeta.model_validate(record))


@router.get("/{file_id}")
def download(
    file_id: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(get_current_user),
):
    record = services.get_file(db, file_id)
    if not record:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"파일을 찾을 수 없습니다: {file_id}")
    path = services.open_file_path(record)
    if not path.exists():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"메타는 존재하지만 파일이 누락됨: {file_id}",
        )
    # Inline for images so they render in <img>; attachment disposition
    # for everything else so browsers download with the original filename.
    #
    # Don't build Content-Disposition by hand — HTTP headers are latin-1
    # encoded, and filenames here can contain Korean (e.g. "최종_9_문화원.png").
    # Starlette's FileResponse already produces a proper
    # `... filename*=utf-8''<percent-encoded>` header from `filename=` +
    # `content_disposition_type=`; doing it manually crashed the response
    # serializer with UnicodeEncodeError (500) for any non-ASCII name.
    return FileResponse(
        path=str(path),
        media_type=record.mime_type,
        filename=record.filename,
        content_disposition_type="inline" if record.is_image else "attachment",
    )


@router.delete("/{file_id}")
def delete_file(
    file_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    record = services.get_file(db, file_id)
    if not record:
        return not_found_response(f"파일을 찾을 수 없습니다: {file_id}")
    if record.owner_user_id != actor.user.id and actor.role != Role.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 파일을 삭제할 권한이 없습니다.")
    services.delete_file(db, record)
    return success_response(message="파일이 삭제되었습니다.")
