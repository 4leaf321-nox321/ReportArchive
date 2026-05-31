"""HTML embed bundle endpoints.

Authorization model (HTML임베드_번들_설계.md §4):
  - Create (POST): any authenticated writer with workspace context.
  - Serve (GET): **no auth** — the unguessable bundle_id is the capability.
    The sandboxed iframe loads files via this URL and its fetch() can't
    carry cookies (null origin), so we don't gate it; access control is the
    secret id. Responses carry Access-Control-Allow-Origin: * so the
    null-origin iframe's fetch() works.
  - Delete: bundle owner or manager.
"""
from __future__ import annotations

import os as _os
import shutil

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

from app.config import settings
from app.database import get_db
from app.modules.embed import services
from app.modules.embed.schemas import BundleMeta
from app.modules.users.models import Role
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import created_response, not_found_response, success_response
from app.shared.storage import assert_space_for

_UPLOAD_CHUNK = 8 * 1024 * 1024

router = APIRouter()


@router.post("")
async def create_bundle(
    files: list[UploadFile] = FastAPIFile(...),
    entry_path: str = Form(...),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Create a bundle from a folder upload. Each file carries its relative
    path as its multipart filename (frontend sets it via FormData). Files
    are streamed to disk preserving structure; the running byte total is
    capped. `entry_path` must resolve to one of the uploaded files."""
    if not files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "업로드할 파일이 없습니다.")
    if len(files) > settings.embed_max_files:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"파일이 너무 많습니다. 최대 {settings.embed_max_files}개.",
        )

    bundle_id = services.new_bundle_id()
    base = services.bundle_dir(bundle_id)
    base.mkdir(parents=True, exist_ok=True)

    total = 0
    written = 0
    try:
        for uf in files:
            target = services.safe_target(bundle_id, uf.filename or "")
            if target is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"잘못된 파일 경로: {uf.filename!r}",
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as buf:
                while True:
                    chunk = await uf.read(_UPLOAD_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > settings.embed_max_bytes:
                        raise HTTPException(
                            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            f"번들이 너무 큽니다. 최대 "
                            f"{settings.embed_max_bytes // (1024 * 1024)} MB.",
                        )
                    buf.write(chunk)
            written += 1
        if total == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "빈 번들은 올릴 수 없습니다.")
        assert_space_for(total)

        entry_norm = services.normalize_relpath(entry_path)
        if entry_norm is None or services.serve_path(bundle_id, entry_norm) is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"메인 HTML 파일을 찾을 수 없습니다: {entry_path!r}",
            )
    except BaseException:
        # Any failure — drop the partial bundle dir so we don't litter disk.
        shutil.rmtree(base, ignore_errors=True)
        raise

    record = services.register_bundle(
        db,
        bundle_id=bundle_id,
        entry_path=entry_norm,
        file_count=written,
        total_bytes=total,
        owner_user_id=actor.user.id,
        workspace_slug=actor.workspace.slug,
    )
    return created_response(data=BundleMeta.model_validate(record))


@router.delete("/{bundle_id}")
def delete_bundle(
    bundle_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    record = services.get_bundle(db, bundle_id)
    if not record:
        return not_found_response(f"번들을 찾을 수 없습니다: {bundle_id}")
    if record.owner_user_id != actor.user.id and actor.role != Role.manager:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 번들을 삭제할 권한이 없습니다.")
    services.delete_bundle(db, record)
    return success_response(message="번들이 삭제되었습니다.")


@router.get("/{bundle_id}/{rel_path:path}")
def serve_bundle_file(
    bundle_id: str,
    rel_path: str,
    db: Session = Depends(get_db),
):
    """Serve a file from the bundle. No auth — bundle_id is the capability.
    ACAO:* lets the sandboxed (null-origin) iframe fetch() its siblings."""
    record = services.get_bundle(db, bundle_id)
    if not record:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "번들을 찾을 수 없습니다.")
    path = services.serve_path(bundle_id, rel_path)
    if path is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "파일을 찾을 수 없습니다.")
    return FileResponse(
        path=str(path),
        media_type=services.guess_mime(path),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "X-Content-Type-Options": "nosniff",
            # CSP sandbox makes the served document opaque-origin even when
            # opened as a *top-level* tab (the "새 탭" / open-in-new-tab UX) —
            # not just inside our sandboxed iframe. Without this, a top-level
            # /api/embed/... page would run author JS on the app's own origin
            # and could read the viewer's localStorage access token. The
            # directive mirrors the iframe's sandbox="allow-scripts" (no
            # allow-same-origin) so behaviour is identical everywhere; the
            # null origin + ACAO:* keeps sibling fetch() working (§4, §8.1).
            "Content-Security-Policy": "sandbox allow-scripts",
            # Bundle contents are immutable per id; let browsers cache.
            "Cache-Control": "public, max-age=3600",
        },
    )
