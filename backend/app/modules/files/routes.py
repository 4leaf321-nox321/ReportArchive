"""File upload / download / metadata endpoints.

Authorization model:
  - Upload (bearer): any authenticated workspace member. The file is
    tagged with the actor's user_id + active workspace_slug.
  - Upload (ticket / MCP `prepare_upload`): PAT-only, no workspace context.
    The file is tagged with the actor's **personal** workspace, mirroring
    where MCP-created drafts are born (see `create_ai_draft`) — the active
    board is neither needed nor consulted.
  - Download / metadata: any authenticated user. We deliberately don't
    gate downloads by workspace tree right now — file_ids are referenced
    from reports, so practical visibility is gated by report visibility
    one level up. Tighten when needed.
  - Delete: file owner or admin.
"""
from __future__ import annotations

import mimetypes
import re
import zipfile

from fastapi import (
    APIRouter,
    Depends,
    File as FastAPIFile,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from pathlib import Path

from app.config import settings
from app.database import get_db
from app.modules.auth.services import create_upload_ticket, decode_upload_ticket
from app.modules.files import services
from app.modules.files.schemas import FileFromUrlRequest, FileMeta
from app.modules.workspaces.services import ensure_personal_workspace
from app.modules.users.models import Role, User
from app.shared.auth import CurrentUser, get_current_user, get_current_user_no_workspace
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

# Web-renderable raster/vector image extensions we lift out of a .pptx.
# EMF/WMF/TIFF live in decks too but browsers can't render them, so we
# skip those rather than create dead file references.
_PPTX_IMAGE_EXTS: frozenset[str] = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
})
# Hard cap on how many images one extract call will lift — a runaway
# deck (hundreds of slides) shouldn't spawn an unbounded fan-out of File
# rows in a single request. Anything past this is reported as skipped.
_PPTX_MAX_IMAGES = 300

router = APIRouter()


def _natural_key(name: str) -> tuple:
    """Sort `image2.png` before `image10.png` — PowerPoint numbers media
    sequentially, but a plain lexical sort would interleave them. Split on
    digit runs so the numeric chunks compare as integers."""
    parts = re.split(r"(\d+)", name)
    return tuple(int(p) if p.isdigit() else p for p in parts)


async def _stream_to_disk(file: UploadFile) -> tuple[str, str, int, str, str]:
    """Chunk-stream an upload straight to its final on-disk path without ever
    buffering more than `_UPLOAD_CHUNK` in memory. Reserves the path up front,
    enforces the per-extension size cap + disk-space guard, and cleans up the
    partial file on any failure. Returns
    `(file_id, storage_path, size, filename, mime_type)` — the caller writes
    the metadata row with whichever owner/workspace its auth resolved.

    Shared by the JWT/PAT route (`upload_file`) and the ticket route
    (`upload_with_ticket`) so the streaming + limit logic lives in one place.
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

    return file_id, str(rel_path).replace(_os.sep, "/"), total, filename, mime_type


@router.post("")
async def upload_file(
    file: UploadFile = FastAPIFile(...),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Chunk-streamed upload, owned by the authenticated actor + active
    workspace."""
    file_id, storage_path, total, filename, mime_type = await _stream_to_disk(file)
    record = services.register_upload(
        db,
        file_id=file_id,
        filename=filename,
        mime_type=mime_type,
        size=total,
        storage_path=storage_path,
        owner_user_id=actor.user.id,
        workspace_slug=actor.workspace.slug,
    )
    return created_response(data=FileMeta.model_validate(record))


@router.post("/upload-ticket")
def mint_upload_ticket(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """Mint a short-lived (5 min) upload ticket for the **out-of-band** upload
    flow: a CLI agent (Claude Code) curls a local file straight to the MCP
    server's `/files/upload` route — bytes never pass through the model — and
    that route forwards to `upload_with_ticket` below. The ticket carries the
    user + workspace as signed claims so the upload lands with the right
    ownership without re-sending the PAT.

    Deliberately **PAT-only** (`get_current_user_no_workspace`): no active
    board / X-Workspace-Slug is needed or consulted. This route only serves
    MCP `prepare_upload`, whose files get referenced from MCP-created drafts —
    and those drafts are always born in the author's **personal** space (see
    `create_ai_draft`). The file is therefore tagged with `personal-{id}`, and
    file visibility is gated by the *referencing report* one level up, not by
    the file's own workspace (see module docstring). Tying the ticket to the
    active board added nothing — minting per-board was meaningless and only
    broke users viewing a read-only shared/public board. `ensure_personal_workspace`
    is idempotent and guarantees the FK target exists before the ticket points
    at it.
    """
    personal_ws = ensure_personal_workspace(db, user)
    db.commit()
    ticket = create_upload_ticket(user.id, personal_ws.slug)
    return success_response(
        data={
            "ticket": ticket,
            "expires_in_seconds": 300,
        }
    )


@router.post("/upload-with-ticket")
async def upload_with_ticket(
    file: UploadFile = FastAPIFile(...),
    ticket: str = Form(...),
    db: Session = Depends(get_db),
):
    """Ticket-authenticated upload (no bearer auth). Used by the MCP server's
    `/files/upload` proxy on behalf of a CLI agent. The signed ticket supplies
    owner + workspace; everything else mirrors `upload_file`."""
    claims = decode_upload_ticket(ticket)
    if claims is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "업로드 티켓이 유효하지 않거나 만료되었습니다.",
        )
    file_id, storage_path, total, filename, mime_type = await _stream_to_disk(file)
    record = services.register_upload(
        db,
        file_id=file_id,
        filename=filename,
        mime_type=mime_type,
        size=total,
        storage_path=storage_path,
        owner_user_id=claims["user_id"],
        workspace_slug=claims["workspace_slug"],
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


@router.post("/{file_id}/extract-images")
def extract_pptx_images(
    file_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이미 업로드된 **.pptx** 파일에서 슬라이드에 박힌 이미지들을 **각각 별도 파일로**
    뽑아내 새 file_id 목록을 돌려준다. MCP/AI 가 PPT 한 장을 통째 올린 뒤, 그 안의
    그림들을 image 위젯으로 붙일 때 쓴다.

    .pptx 는 사실상 zip 이라 `ppt/media/` 의 이미지 엔트리를 그대로 꺼내 저장한다
    (별도 라이브러리 없음). 웹에서 렌더 가능한 확장자(png/jpg/gif/webp/svg/bmp)만
    추출하고, 개당 업로드 상한을 넘는 항목·전체 상한(_PPTX_MAX_IMAGES) 초과분은
    건너뛴 수로 보고한다. 추출된 각 파일은 원본과 같은 소유자/워크스페이스로 태깅된다.

    반환: `{ source_file_id, images: [FileMeta...], extracted, skipped_oversize,
            skipped_over_limit }`."""
    record = services.get_file(db, file_id)
    if not record:
        return not_found_response(f"파일을 찾을 수 없습니다: {file_id}")
    if not (record.filename or "").lower().endswith(".pptx"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "이미지 추출은 .pptx 파일만 지원합니다.",
        )
    path = services.open_file_path(record)
    if not path.exists():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"메타는 존재하지만 파일이 누락됨: {file_id}"
        )

    per_image_limit = settings.upload_max_bytes
    stem = Path(record.filename).stem
    images: list[FileMeta] = []
    skipped_oversize = 0
    skipped_over_limit = 0
    try:
        with zipfile.ZipFile(path) as zf:
            media = sorted(
                (
                    n
                    for n in zf.namelist()
                    if n.startswith("ppt/media/")
                    and Path(n).suffix.lower() in _PPTX_IMAGE_EXTS
                ),
                key=_natural_key,
            )
            for entry in media:
                if len(images) >= _PPTX_MAX_IMAGES:
                    skipped_over_limit += 1
                    continue
                info = zf.getinfo(entry)
                if info.file_size > per_image_limit:
                    skipped_oversize += 1
                    continue
                data = zf.read(entry)
                ext = Path(entry).suffix.lower()
                mime = mimetypes.guess_type(entry)[0] or "application/octet-stream"
                out = services.save_upload(
                    db,
                    filename=f"{stem}_img{len(images) + 1}{ext}",
                    mime_type=mime,
                    contents=data,
                    owner_user_id=actor.user.id,
                    workspace_slug=actor.workspace.slug,
                )
                images.append(FileMeta.model_validate(out))
    except zipfile.BadZipFile as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "유효한 .pptx 파일이 아닙니다(zip 손상).",
        ) from exc

    return success_response(
        data={
            "source_file_id": file_id,
            "images": images,
            "extracted": len(images),
            "skipped_oversize": skipped_oversize,
            "skipped_over_limit": skipped_over_limit,
        }
    )


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
