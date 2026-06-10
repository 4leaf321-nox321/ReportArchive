"""Composite preset (종합보고 양식) routes.

  - GET    /api/composite-presets            list presets visible to the actor
  - POST   /api/composite-presets            snapshot a composite → preset (writer)
  - POST   /api/composite-presets/{id}/new-composite  create a composite from a preset
  - DELETE /api/composite-presets/{id}        creator (or sys admin) only
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.composite_presets import services
from app.modules.composite_presets.models import CompositePreset
from app.modules.composite_presets.schemas import (
    CompositePresetCreate,
    CompositePresetInstantiate,
    CompositePresetSummary,
    CompositePresetUpdate,
)
from app.modules.composites import services as composite_services
from app.modules.composites.schemas import CompositeReportRead
from app.modules.workspaces import services as ws_services
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


def _can_manage(actor: CurrentUser, preset: CompositePreset) -> bool:
    """양식 수정·삭제 권한 — 만든 사람 · 시스템관리자 · (현재 부서)매니저."""
    return (
        preset.created_by_user_id == actor.user.id
        or bool(getattr(actor.user, "is_system_admin", False))
        or actor.is_manager
    )


@router.get("")
def list_composite_presets(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Presets visible to the actor's workspace tree (전사 + own tree)."""
    rows = services.list_visible(db, actor.workspace.slug)
    return success_response(
        data=[CompositePresetSummary.model_validate(r) for r in rows]
    )


@router.post("")
def create_composite_preset(
    payload: CompositePresetCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Snapshot a composite the caller can read into a reusable 양식."""
    source = composite_services.get(db, payload.source_composite_id)
    if source is None:
        return not_found_response(
            f"Composite not found: {payload.source_composite_id}"
        )
    if not composite_services.can_read_composite(db, actor, source):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    preset = services.create_from_composite(
        db, source, payload, created_by_user_id=actor.user.id
    )
    return created_response(data=CompositePresetSummary.model_validate(preset))


@router.post("/{preset_id}/new-composite")
def new_composite_from_preset(
    preset_id: int,
    payload: CompositePresetInstantiate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Create a new composite seeded from the preset. Returns the composite
    plus `seed_groups` (the empty group skeleton the frontend seeds into
    its local `pendingGroups`)."""
    preset = services.get(db, preset_id)
    if preset is None:
        return not_found_response(f"Composite preset not found: {preset_id}")
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Cannot create composite in a virtual workspace; switch to a real workspace.",
        )
    # Same writable-scope gate as POST /api/composites.
    scope = ws_services.get_descendants_inclusive(db, actor.workspace.slug)
    if payload.workspace_slug not in scope:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "종합보고는 현재 부서 또는 하위 부서에만 작성할 수 있습니다.",
        )
    try:
        composite, seed_groups = services.instantiate(
            db, preset, payload, owner_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(
        data={
            "composite": CompositeReportRead.model_validate(composite),
            "seed_groups": seed_groups,
        }
    )


@router.patch("/{preset_id}")
def update_composite_preset(
    preset_id: int,
    payload: CompositePresetUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """메타정보(이름·설명·공개범위) + 그룹 목록 수정. 관리 탭 전용."""
    preset = services.get(db, preset_id)
    if preset is None:
        return not_found_response(f"Composite preset not found: {preset_id}")
    if not _can_manage(actor, preset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 양식을 수정할 권한이 없습니다.",
        )
    preset = services.update(db, preset, payload)
    return success_response(data=CompositePresetSummary.model_validate(preset))


@router.delete("/{preset_id}")
def delete_composite_preset(
    preset_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    preset = services.get(db, preset_id)
    if preset is None:
        return not_found_response(f"Composite preset not found: {preset_id}")
    if not _can_manage(actor, preset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 양식을 삭제할 권한이 없습니다.",
        )
    services.delete(db, preset)
    return success_response(data={"deleted": True})
