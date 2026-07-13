"""File services — disk persistence + metadata management.

Storage layout: every uploaded file lives at
    {settings.upload_dir_path}/{yyyymm}/{file_id}{ext}

Subdirs by year-month keep listing performant when the count grows.
filename + mime_type are recorded from the upload but the on-disk
filename is just the file_id — never derive it from user input.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.files.models import File


# Common extension fallbacks for MIME types we care about. The browser
# usually provides a usable filename, but if it doesn't we fall back to
# a derived extension to keep downloads sensible.
_MIME_EXT_FALLBACK = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
}


def _ext_for(filename: str, mime_type: str) -> str:
    suffix = Path(filename).suffix
    if suffix and len(suffix) <= 8:
        return suffix.lower()
    return _MIME_EXT_FALLBACK.get(mime_type, "")


def _disk_path(storage_path: str) -> Path:
    return settings.upload_dir_path / storage_path


def save_upload(
    db: Session,
    *,
    filename: str,
    mime_type: str,
    contents: bytes,
    owner_user_id: int | None,
    workspace_slug: str,
) -> File:
    """Convenience entry point used by callers that already have the
    entire payload buffered in memory (small files, programmatic
    uploads). Routes use `reserve_storage_path` + `register_upload`
    for chunk-streamed uploads to avoid loading the whole file into
    RAM."""
    file_id = str(uuid.uuid4())
    ext = _ext_for(filename, mime_type)
    yyyymm = datetime.utcnow().strftime("%Y%m")
    rel_dir = Path(yyyymm)
    rel_path = rel_dir / f"{file_id}{ext}"
    abs_path = _disk_path(str(rel_path))
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(contents)

    record = File(
        id=file_id,
        filename=filename,
        mime_type=mime_type,
        size=len(contents),
        storage_path=str(rel_path).replace(os.sep, "/"),
        owner_user_id=owner_user_id,
        workspace_slug=workspace_slug,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def reserve_storage_path(filename: str, mime_type: str) -> tuple[str, Path, Path]:
    """Allocate a final on-disk path for a streaming upload before the
    bytes arrive. Returns `(file_id, relative_path, absolute_path)` —
    the route writes chunks straight into `absolute_path`, then calls
    `register_upload` with the final byte count to commit the metadata
    row. Used by the upload route so 1GB videos don't have to be
    buffered in memory first."""
    file_id = str(uuid.uuid4())
    ext = _ext_for(filename, mime_type)
    yyyymm = datetime.utcnow().strftime("%Y%m")
    rel_path = Path(yyyymm) / f"{file_id}{ext}"
    abs_path = _disk_path(str(rel_path))
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    return file_id, rel_path, abs_path


def register_upload(
    db: Session,
    *,
    file_id: str,
    filename: str,
    mime_type: str,
    size: int,
    storage_path: str,
    owner_user_id: int | None,
    workspace_slug: str,
) -> File:
    """Insert the metadata row for a file already written to disk by
    `reserve_storage_path` + chunk-streamed write."""
    record = File(
        id=file_id,
        filename=filename,
        mime_type=mime_type,
        size=size,
        storage_path=storage_path,
        owner_user_id=owner_user_id,
        workspace_slug=workspace_slug,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_file(db: Session, file_id: str) -> Optional[File]:
    return db.get(File, file_id)


def open_file_path(record: File) -> Path:
    return _disk_path(record.storage_path)


def delete_file(db: Session, record: File) -> None:
    """Removes the disk file and the metadata row. Best-effort — if the
    on-disk file is already gone the row is still cleared."""
    path = _disk_path(record.storage_path)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    db.delete(record)
    db.commit()


def list_workspace_files(db: Session, slug: str) -> dict:
    """부서 스코프 파일 목록 + 참조 정보(부서 삭제/개편 정리용).

    각 파일에 대해 어느 보고서가 참조하는지 표시한다 — referenced_live 는 살아있는
    (휴지통 아님) 보고서가 쓰고 있다는 뜻으로, 지우면 그 보고서가 깨지므로 삭제보다
    재배정을 권하는 신호다."""
    from app.modules.files import orphans

    files = list(
        db.execute(
            select(File)
            .where(File.workspace_slug == slug)
            .order_by(File.size.desc())
        ).scalars()
    )
    ids = {f.id for f in files}
    refmap = orphans.references_for(db, ids)

    items: list[dict] = []
    total_size = 0
    for f in files:
        refs = refmap.get(f.id, [])
        live = [r for r in refs if not r["deleted"]]
        items.append(
            {
                "id": f.id,
                "filename": f.filename,
                "mime_type": f.mime_type,
                "size": f.size,
                "is_image": f.is_image,
                "owner_user_id": f.owner_user_id,
                "uploaded_at": f.uploaded_at.isoformat() if f.uploaded_at else None,
                "referenced_live": len(live) > 0,
                "referenced_any": len(refs) > 0,
                "reference_count": len(refs),
                # 표시용으로 최대 8건만(살아있는 참조 우선).
                "references": (live + [r for r in refs if r["deleted"]])[:8],
            }
        )
        total_size += f.size or 0

    return {
        "workspace_slug": slug,
        "items": items,
        "total_count": len(items),
        "total_size": total_size,
    }


def bulk_delete_files(db: Session, file_ids: list[str]) -> dict:
    """주어진 file_id 들을 일괄 삭제(디스크 unlink + DB 행). 참조 검사는 하지 않는다
    — 호출부(관리자)가 화면에서 참조 여부를 보고 결정한다. 한 번만 commit."""
    deleted = 0
    freed = 0
    failed: list[dict] = []
    for fid in dict.fromkeys(file_ids):  # 중복 제거(순서 유지)
        f = db.get(File, fid)
        if f is None:
            failed.append({"id": fid, "reason": "not_found"})
            continue
        try:
            _disk_path(f.storage_path).unlink(missing_ok=True)
        except OSError:
            pass  # best-effort — 디스크에 없어도 DB 행은 정리
        freed += f.size or 0
        db.delete(f)
        deleted += 1
    db.commit()
    return {"deleted": deleted, "freed_bytes": freed, "failed": failed}


def reassign_files(db: Session, file_ids: list[str], target_slug: str) -> dict:
    """파일들을 다른 부서로 이관(workspace_slug 변경). 부서 병합/이동 시 자료를
    지우지 않고 넘기는 용도. 대상은 실재하는 비가상 부서여야 한다."""
    from app.modules.workspaces.models import Workspace, WorkspaceKind

    target = db.get(Workspace, target_slug)
    if target is None:
        raise ValueError(f"대상 부서를 찾을 수 없습니다: {target_slug}")
    if target.virtual or target.kind == WorkspaceKind.virtual:
        raise ValueError("가상 부서로는 파일을 이동할 수 없습니다.")

    moved = 0
    for fid in dict.fromkeys(file_ids):
        f = db.get(File, fid)
        if f is None:
            continue
        f.workspace_slug = target_slug
        moved += 1
    db.commit()
    return {"reassigned": moved, "target_slug": target_slug}
