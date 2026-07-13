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

from sqlalchemy import select
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


# ── 부서 스코프 번들 관리(시스템관리자) — 부서 삭제/개편 정리용 ─────────────
# html_embed_bundles.workspace_slug=RESTRICT 라 부서에 번들이 남으면 삭제가 막힌다.
# files 정리와 대칭 구조(목록+참조표시·일괄삭제·재배정).


def list_workspace_bundles(db: Session, slug: str) -> dict:
    """부서가 소유한 임베드 번들 목록 + 참조 정보(어느 보고서가 bundle_id 로 쓰는지).
    referenced_live=살아있는 보고서가 사용 중(삭제 시 그 보고서 임베드가 깨짐)."""
    from app.modules.files import orphans

    bundles = list(
        db.execute(
            select(HtmlEmbedBundle)
            .where(HtmlEmbedBundle.workspace_slug == slug)
            .order_by(HtmlEmbedBundle.total_bytes.desc())
        ).scalars()
    )
    ids = {b.id for b in bundles}
    refmap = orphans.bundle_references_for(db, ids)

    items: list[dict] = []
    total = 0
    for b in bundles:
        refs = refmap.get(b.id, [])
        live = [r for r in refs if not r["deleted"]]
        items.append(
            {
                "id": b.id,
                "entry_path": b.entry_path,
                "file_count": b.file_count,
                "total_bytes": b.total_bytes,
                "owner_user_id": b.owner_user_id,
                "created_at": b.created_at.isoformat() if b.created_at else None,
                "referenced_live": len(live) > 0,
                "referenced_any": len(refs) > 0,
                "reference_count": len(refs),
                "references": (live + [r for r in refs if r["deleted"]])[:8],
            }
        )
        total += b.total_bytes or 0

    return {
        "workspace_slug": slug,
        "items": items,
        "total_count": len(items),
        "total_bytes": total,
    }


def bulk_delete_bundles(db: Session, bundle_ids: list[str]) -> dict:
    """번들 일괄 삭제(디스크 폴더 rmtree + DB 행). 참조 검사는 호출부(관리자)가 화면
    에서 보고 결정. 한 번만 commit."""
    deleted = 0
    freed = 0
    failed: list[dict] = []
    for bid in dict.fromkeys(bundle_ids):
        b = db.get(HtmlEmbedBundle, bid)
        if b is None:
            failed.append({"id": bid, "reason": "not_found"})
            continue
        shutil.rmtree(bundle_dir(bid), ignore_errors=True)
        freed += b.total_bytes or 0
        db.delete(b)
        deleted += 1
    db.commit()
    return {"deleted": deleted, "freed_bytes": freed, "failed": failed}


def reassign_bundles(db: Session, bundle_ids: list[str], target_slug: str) -> dict:
    """번들들을 다른 부서로 이관(workspace_slug 변경). 대상은 실재 비가상 부서."""
    from app.modules.workspaces.models import Workspace, WorkspaceKind

    target = db.get(Workspace, target_slug)
    if target is None:
        raise ValueError(f"대상 부서를 찾을 수 없습니다: {target_slug}")
    if target.virtual or target.kind == WorkspaceKind.virtual:
        raise ValueError("가상 부서로는 번들을 이동할 수 없습니다.")

    moved = 0
    for bid in dict.fromkeys(bundle_ids):
        b = db.get(HtmlEmbedBundle, bid)
        if b is None:
            continue
        b.workspace_slug = target_slug
        moved += 1
    db.commit()
    return {"reassigned": moved, "target_slug": target_slug}
