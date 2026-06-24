"""Report preset (시작 양식) routes.

  - POST   /api/presets                 snapshot a report → preset (writer)
  - GET    /api/presets?template_id=     list presets visible to the actor
  - POST   /api/presets/{id}/new-report  create a report seeded from a preset
  - DELETE /api/presets/{id}             creator (or sys admin) only
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.presets import services
from app.modules.presets.schemas import (
    PresetCreate,
    PresetInstantiate,
    PresetInstantiateResult,
    PresetSummary,
)
from app.modules.reports import services as report_services
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("")
def list_presets(
    template_id: str | None = Query(default=None),
    scope: str = Query(default="workspace"),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Presets visible to the actor. `scope=all` 이면 소유 부서 무관 전체(작성
    picker — 모든 사용자가 내 공간에서 모든 부서 프리셋으로 시작 가능, 남의 개인
    비공개는 제외). 기본 `scope=workspace` 는 현재 워크스페이스 가시 트리 + 전사 +
    내 개인 + 내가 만든 것(관리 화면의 조직별 분리 유지). 시스템 관리자는 전체."""
    rows = services.list_visible(
        db,
        actor.workspace.slug,
        template_id=template_id,
        all_scopes=(scope == "all"),
        user_id=actor.user.id,
        is_system_admin=actor.user.is_system_admin,
    )
    return success_response(
        data=[PresetSummary.model_validate(r) for r in rows]
    )


@router.post("")
def create_preset(
    payload: PresetCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Snapshot a report the caller can read into a reusable starting form."""
    source = report_services.get_report(db, payload.source_report_id)
    if not source:
        return not_found_response(
            f"Report not found: {payload.source_report_id}"
        )
    if not report_services.can_read_report(db, actor, source):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    preset = services.create_from_report(
        db, source, payload, created_by_user_id=actor.user.id
    )
    return created_response(data=PresetSummary.model_validate(preset))


@router.post("/{preset_id}/new-report")
def new_report_from_preset(
    preset_id: int,
    payload: PresetInstantiate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Create a new report seeded from the preset, in the caller's personal
    space (게시는 이후 별도 액션 — same as a blank new report)."""
    preset = services.get(db, preset_id)
    if not preset:
        return not_found_response(f"Preset not found: {preset_id}")
    target_workspace = f"personal-{actor.user.id}"
    try:
        report = services.instantiate(
            db,
            preset,
            target_workspace=target_workspace,
            title=payload.title,
            folder_id=payload.folder_id,
            owner_user_id=actor.user.id,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(
        data=PresetInstantiateResult(
            id=report.id, workspace_slug=report.workspace_slug
        )
    )


@router.delete("/{preset_id}")
def delete_preset(
    preset_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    preset = services.get(db, preset_id)
    if not preset:
        return not_found_response(f"Preset not found: {preset_id}")
    if (
        preset.created_by_user_id != actor.user.id
        and not actor.user.is_system_admin
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "본인이 만든 프리셋만 삭제할 수 있습니다.",
        )
    services.delete(db, preset)
    return success_response(data={"deleted": True})
