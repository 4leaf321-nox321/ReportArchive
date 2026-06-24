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
    PresetUpdate,
    PresetUpdateFromReport,
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


def _can_manage_preset(actor: CurrentUser, preset) -> bool:
    """양식 수정·삭제 권한 — 작성자 또는 시스템관리자. ⚠ actor.is_manager 는
    쓰지 않는다: 내용 편집은 personal 컨텍스트(모두가 자기 personal 의 매니저)
    에서 호출돼 매니저 게이트가 무력화되기 때문(삭제 권한과 동일선상)."""
    return (
        preset.created_by_user_id == actor.user.id
        or actor.user.is_system_admin
    )


@router.patch("/{preset_id}")
def update_preset(
    preset_id: int,
    payload: PresetUpdate,
    db: Session = Depends(get_db),
    # 소유자 관리 작업이라 require_writer(게시판 쓰기) 가 아니라 소유권만 게이트.
    # require_writer 면 다른 조직 공개 게시판 열람 중(public_viewer)일 때 본인
    # 양식 수정이 "읽기 전용" 으로 잘못 막힌다.
    actor: CurrentUser = Depends(get_current_user),
):
    """양식 메타정보(이름·설명·공개범위) 수정 — 작성자 또는 시스템관리자."""
    preset = services.get(db, preset_id)
    if not preset:
        return not_found_response(f"Preset not found: {preset_id}")
    if not _can_manage_preset(actor, preset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 양식을 수정할 권한이 없습니다."
        )
    preset = services.update(db, preset, payload)
    return success_response(data=PresetSummary.model_validate(preset))


@router.post("/{preset_id}/update-from-report")
def update_preset_from_report(
    preset_id: int,
    payload: PresetUpdateFromReport,
    db: Session = Depends(get_db),
    # 소유자 관리 작업 — 소유권(_can_manage_preset)만 게이트(아래). source 보고서는
    # can_read_report 로 따로 검사한다. require_writer 였으면 cross-org 열람 중 막힘.
    actor: CurrentUser = Depends(get_current_user),
):
    """양식 내용(seed)을 source 보고서로 갱신 — 양식 편집 세션의 '양식에 반영'.
    작성자/시스템관리자만, source 보고서는 읽을 수 있어야 한다."""
    preset = services.get(db, preset_id)
    if not preset:
        return not_found_response(f"Preset not found: {preset_id}")
    if not _can_manage_preset(actor, preset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 양식을 수정할 권한이 없습니다."
        )
    source = report_services.get_report(db, payload.source_report_id)
    if not source:
        return not_found_response(
            f"Report not found: {payload.source_report_id}"
        )
    if not report_services.can_read_report(db, actor, source):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    preset = services.update_seed_from_report(db, preset, source)
    return success_response(data=PresetSummary.model_validate(preset))


@router.delete("/{preset_id}")
def delete_preset(
    preset_id: int,
    db: Session = Depends(get_db),
    # 소유자 관리 작업이라 소유권만 게이트(아래 _can_manage_preset). require_writer
    # 였을 때 다른 조직 공개 게시판 열람 중(public_viewer)이면 본인 양식 삭제가
    # "다른 조직의 공개 게시판은 읽기 전용입니다" 로 잘못 막히던 버그 수정.
    actor: CurrentUser = Depends(get_current_user),
):
    preset = services.get(db, preset_id)
    if not preset:
        return not_found_response(f"Preset not found: {preset_id}")
    if not _can_manage_preset(actor, preset):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "본인이 만든 프리셋만 삭제할 수 있습니다.",
        )
    services.delete(db, preset)
    return success_response(data={"deleted": True})
