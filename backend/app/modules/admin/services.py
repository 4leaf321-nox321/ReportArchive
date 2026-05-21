"""Admin services — system-level visibility (storage, etc.).

Routes under this module are gated to admins only; the data they expose
(host paths, disk usage, per-workspace footprint) shouldn't leak to
regular users.
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.files.models import File
from app.modules.workspaces.models import Workspace
from app.shared.storage import SAFETY_MARGIN_BYTES, disk_usage


def get_storage_stats(db: Session) -> dict:
    """Snapshot the upload partition + the app's footprint inside it.

    Two distinct numbers that are easy to confuse:
      - `partition.*`  — the WHOLE filesystem backing upload_dir_path;
        what `df` would show. Drives the upload guard.
      - `upload_dir.*` — the bytes accounted to ReportArchive (SUM of
        files.size). Tells the operator what THIS app contributes,
        independent of other tenants on the same partition.
    """
    upload_path = settings.upload_dir_path
    total, used, free = disk_usage()

    app_size = (
        db.execute(select(func.coalesce(func.sum(File.size), 0))).scalar() or 0
    )
    app_count = db.execute(select(func.count(File.id))).scalar() or 0

    # Workspace breakdown — join in display name so the admin UI doesn't
    # need a second round-trip to translate slugs back to labels.
    rows = db.execute(
        select(
            File.workspace_slug,
            Workspace.name,
            func.coalesce(func.sum(File.size), 0).label("size_bytes"),
            func.count(File.id).label("file_count"),
        )
        .join(Workspace, Workspace.slug == File.workspace_slug, isouter=True)
        .group_by(File.workspace_slug, Workspace.name)
        .order_by(func.sum(File.size).desc())
    ).all()

    return {
        "partition": {
            "path": str(upload_path),
            "total_bytes": int(total),
            "used_bytes": int(used),
            "free_bytes": int(free),
            "percent_used": round(used * 100 / total, 2) if total else 0.0,
        },
        "upload_dir": {
            "path": str(upload_path),
            "size_bytes": int(app_size),
            "file_count": int(app_count),
        },
        "by_workspace": [
            {
                "workspace_slug": slug,
                "workspace_name": name,
                "size_bytes": int(size),
                "file_count": int(count),
            }
            for slug, name, size, count in rows
        ],
        "safety_margin_bytes": SAFETY_MARGIN_BYTES,
        "upload_max_bytes": settings.upload_max_bytes,
    }
