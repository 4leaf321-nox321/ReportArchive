"""HTML embed bundle services — disk persistence + safe path resolution.

Storage layout: {settings.embed_bundles_dir_path}/{bundle_id}/<relpath...>
preserving the uploaded folder structure so the main HTML's relative
references (src/href/fetch) resolve naturally when served.
"""
from __future__ import annotations

import mimetypes
import shutil
import uuid
from pathlib import Path, PurePosixPath
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.modules.embed.models import HtmlEmbedBundle


# Explicit MIME overrides so scripts/styles/wasm execute correctly — the
# stdlib mimetypes table is inconsistent across platforms (e.g. .js can
# come back as text/plain), and a wrong Content-Type makes the browser
# refuse to run a module or render an svg.
_MIME_OVERRIDE = {
    ".html": "text/html",
    ".htm": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
}


def new_bundle_id() -> str:
    """Unguessable 128-bit id (uuid4 hex). Doubles as the access capability."""
    return uuid.uuid4().hex


def bundle_dir(bundle_id: str) -> Path:
    return settings.embed_bundles_dir_path / bundle_id


def normalize_relpath(relpath: str) -> Optional[str]:
    """Sanitize a client-supplied relpath into a safe posix relpath inside
    the bundle. Drops empty / "." / ".." segments and rejects anything that
    would escape the bundle root. Returns None if nothing usable remains."""
    rel = PurePosixPath((relpath or "").replace("\\", "/"))
    parts = [p for p in rel.parts if p not in ("", ".", "..") and p != "/"]
    if not parts:
        return None
    return "/".join(parts)


def safe_target(bundle_id: str, relpath: str) -> Optional[Path]:
    """Resolve relpath to an absolute path *inside* the bundle dir, or None
    if it normalizes away or escapes (path traversal guard)."""
    norm = normalize_relpath(relpath)
    if norm is None:
        return None
    base = bundle_dir(bundle_id).resolve()
    target = (base / norm).resolve()
    if target != base and base not in target.parents:
        return None  # escaped the bundle root
    return target


def serve_path(bundle_id: str, relpath: str) -> Optional[Path]:
    """Path to an existing file in the bundle, or None (404)."""
    target = safe_target(bundle_id, relpath)
    if target is None or not target.is_file():
        return None
    return target


def guess_mime(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _MIME_OVERRIDE:
        return _MIME_OVERRIDE[ext]
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def register_bundle(
    db: Session,
    *,
    bundle_id: str,
    entry_path: str,
    file_count: int,
    total_bytes: int,
    owner_user_id: int | None,
    workspace_slug: str,
) -> HtmlEmbedBundle:
    record = HtmlEmbedBundle(
        id=bundle_id,
        entry_path=entry_path,
        file_count=file_count,
        total_bytes=total_bytes,
        owner_user_id=owner_user_id,
        workspace_slug=workspace_slug,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_bundle(db: Session, bundle_id: str) -> Optional[HtmlEmbedBundle]:
    return db.get(HtmlEmbedBundle, bundle_id)


def delete_bundle(db: Session, record: HtmlEmbedBundle) -> None:
    """Remove the on-disk folder + metadata row. Best-effort on the files."""
    shutil.rmtree(bundle_dir(record.id), ignore_errors=True)
    db.delete(record)
    db.commit()
