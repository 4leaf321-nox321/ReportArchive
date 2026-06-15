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
from app.modules.files.schemas import FileFromUrlRequest, FileMeta
from app.modules.users.models import Role
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import created_response, not_found_response, success_response
from app.shared.storage import assert_space_for
from app.shared.url_fetch import UrlFetchError, basename_from_url, fetch_file_from_url


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

# Video extensions get their own (much higher) cap — short demo clips
# and screen captures routinely run into hundreds of MB / low GB.
_VIDEO_EXTENSIONS: frozenset[str] = frozenset({
    ".mp4", ".m4v", ".webm", ".mov", ".ogg", ".ogv", ".mkv", ".avi",
})


def _upload_limit_for(filename: str) -> int:
    ext = Path(filename or "").suffix.lower()
    if ext in _CAD_EXTENSIONS:
        return settings.upload_max_bytes_cad
    if ext in _VIDEO_EXTENSIONS:
        return settings.upload_max_bytes_video
    return settings.upload_max_bytes


# Chunk size for streaming uploads. 8 MB is large enough that we're
# not making a syscall per 64 KB but small enough that the in-flight
# buffer stays modest even with many concurrent uploads.
_UPLOAD_CHUNK = 8 * 1024 * 1024

router = APIRouter()


@router.post("")
async def upload_file(
    file: UploadFile = FastAPIFile(...),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Chunk-streamed upload — never buffers more than `_UPLOAD_CHUNK`
    of the payload in memory. The route reserves the final on-disk path
    up front, streams chunks straight into it, and only registers the
    metadata row after the full transfer succeeds. If the running total
    exceeds the per-extension cap we delete the partial file and 413
    before any DB write.
    """
    import os as _os  # local alias for the file-cleanup branch
    filename = file.filename or "unnamed"
    mime_type = file.content_type or "application/octet-stream"
    limit = _upload_limit_for(filename)

    # Allocate the final path first so a write failure mid-stream still
    # has a known location to clean up.
    file_id, rel_path, abs_path = services.reserve_storage_path(filename, mime_type)

    total = 0
    try:
        with abs_path.open("wb") as buf:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    # Stop draining, drop the partial file, surface 413.
                    raise HTTPException(
                        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        f"파일이 너무 큽니다. 최대 {limit // (1024 * 1024)} MB.",
                    )
                buf.write(chunk)
        if total == 0:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "빈 파일은 업로드할 수 없습니다."
            )
        # 413 (too big for our policy) is separate from 507 (no room on
        # disk). Both can hit on a busy server — guarding here lets the
        # client show a clear error.
        assert_space_for(total)
    except BaseException:
        # Streaming failure or limit hit — best-effort cleanup so we
        # don't litter the upload dir with orphaned partials.
        try:
            if abs_path.exists():
                abs_path.unlink()
        except _os.error:
            pass
        raise

    record = services.register_upload(
        db,
        file_id=file_id,
        filename=filename,
        mime_type=mime_type,
        size=total,
        storage_path=str(rel_path).replace(_os.sep, "/"),
        owner_user_id=actor.user.id,
        workspace_slug=actor.workspace.slug,
    )
    return created_response(data=FileMeta.model_validate(record))


@router.post("/from-url")
def upload_from_url(
    payload: FileFromUrlRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """링크 방식(URL 인제스트) — 서버가 주어진 URL 에서 파일을 **직접 다운로드**해
    저장하고 file_id 를 돌려준다. 바이트가 모델/클라이언트를 거치지 않아 크기·화질
    제약이 없다. SSRF 가드(공인 URL 만, 사설망 차단)는 `url_fetch` 가 담당.

    멀티파트 업로드와 동일하게 확장자별 상한(`_upload_limit_for`)·디스크 여유
    (`assert_space_for`)를 적용하고, 같은 File 메타 행을 만든다."""
    # 확장자별 상한 선택 — filename 우선, 없으면 URL 의 마지막 세그먼트.
    name_for_limit = payload.filename or basename_from_url(payload.url)
    limit = _upload_limit_for(name_for_limit or "")
    try:
        filename, mime_type, content = fetch_file_from_url(payload.url, max_bytes=limit)
    except UrlFetchError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    # 사용자가 파일명을 지정했으면 그걸로 덮어쓴다(다운로드 추정명 대신).
    if payload.filename:
        filename = payload.filename
    assert_space_for(len(content))
    record = services.save_upload(
        db,
        filename=filename,
        mime_type=mime_type,
        contents=content,
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
    if record.owner_user_id != actor.user.id and actor.role != Role.manager:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 파일을 삭제할 권한이 없습니다.")
    services.delete_file(db, record)
    return success_response(message="파일이 삭제되었습니다.")
