"""Admin-only system endpoints (storage, etc.)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.admin import services
from app.shared.auth import CurrentUser, require_system_admin
from app.shared.responses import success_response

router = APIRouter()


@router.get("/storage")
def storage_stats(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Disk partition + per-workspace file footprint. Admin-only because
    the response reveals host paths and aggregate per-workspace sizes."""
    return success_response(data=services.get_storage_stats(db))
