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
