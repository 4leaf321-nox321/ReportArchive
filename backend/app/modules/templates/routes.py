"""Template routes — versioned, hybrid visibility, manager+ writes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.templates import services
from app.modules.templates.schemas import (
    TemplateCreate,
    TemplateNewVersion,
    TemplateRead,
    TemplateScopeUpdate,
    TemplateVersionSummary,
)
from app.shared.auth import CurrentUser, get_current_user, require_manager
from app.shared.responses import created_response, not_found_response, success_response

router = APIRouter()


@router.get("")
def list_templates(
    only_latest: bool = True,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    items = services.list_templates(db, actor.workspace.slug, only_latest=only_latest)
    payload = [TemplateRead.from_orm_(t) for t in items]
    return success_response(data=payload)


@router.get("/{template_id}")
def get_latest(
    template_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    template = services.get_latest_version(db, template_id)
    if not template or not services.is_visible(db, template, actor.workspace.slug):
        return not_found_response(f"Template not found: {template_id}")
    return success_response(data=TemplateRead.from_orm_(template))


@router.get("/{template_id}/versions")
def list_versions(
    template_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    versions = services.list_versions(db, template_id)
    if not versions or not services.is_visible(db, versions[0], actor.workspace.slug):
        return not_found_response(f"Template not found: {template_id}")
    payload = [TemplateVersionSummary.model_validate(v) for v in versions]
    return success_response(data=payload)


@router.get("/{template_id}/versions/{version}")
def get_specific_version(
    template_id: str,
    version: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    template = services.get_template(db, template_id, version)
    if not template or not services.is_visible(db, template, actor.workspace.slug):
        return not_found_response(f"Template version not found: {template_id}@{version}")
    return success_response(data=TemplateRead.from_orm_(template))


@router.post("")
def create_template(
    payload: TemplateCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_manager),
):
    # Each requested owner workspace must lie inside the actor's accessible
    # tree (= where they have manager+ access). NULL / empty = global is
    # allowed for any manager+. If global creation needs to be admin-only
    # later, gate it here.
    if payload.owner_workspace_slugs:
        from app.modules.workspaces import services as ws_services

        accessible = set(ws_services.get_descendants_inclusive(db, actor.workspace.slug))
        bad = [s for s in payload.owner_workspace_slugs if s not in accessible]
        if bad:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Cannot create template in workspace(s): {', '.join(bad)}",
            )
    try:
        template = services.create_template(db, payload, created_by_user_id=actor.user.id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=TemplateRead.from_orm_(template))


@router.delete("/{template_id}")
def delete_template(
    template_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_manager),
):
    """Deletes ALL versions of a template. Manager-and-up: template
    lifecycle (create / publish / delete) is the manager role's
    responsibility. Refuses if any reports still reference the
    template (409)."""
    latest = services.get_latest_version(db, template_id)
    if not latest or not services.is_visible(db, latest, actor.workspace.slug):
        return not_found_response(f"Template not found: {template_id}")
    try:
        result = services.delete_template(db, template_id)
    except ValueError as exc:
        # "not found" is 404, "in use" is 409. Distinguish by message.
        msg = str(exc)
        if "not found" in msg.lower():
            return not_found_response(msg)
        raise HTTPException(status.HTTP_409_CONFLICT, msg) from exc
    return success_response(
        data=result,
        message=f"'{template_id}' 템플릿의 {result['deleted_versions']}개 버전이 삭제되었습니다.",
    )


@router.patch("/{template_id}/scope")
def set_template_scope(
    template_id: str,
    payload: TemplateScopeUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_manager),
):
    """다른 부서에 공유 — owner_workspace_slugs(공유 부서)를 통째로 교체한다.
    버전은 올리지 않는다(가시성 메타). 템플릿을 소유한 부서의 매니저만 가능.
    공유 대상 부서는 본인 트리 밖일 수 있다(그게 공유의 목적)."""
    latest = services.get_latest_version(db, template_id)
    if not latest or not services.is_visible(db, latest, actor.workspace.slug):
        return not_found_response(f"Template not found: {template_id}")
    # 권한: 현재 이 템플릿을 *소유한* 부서(들) 중 하나가 본인 관리 트리 안에
    # 있어야 한다. 전사(소유 없음) 템플릿은 여기서 못 바꾼다(관리자 영역).
    current_owners = latest.owner_workspace_slugs or []
    if not current_owners:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "전사 공개 템플릿의 공유 범위는 여기서 바꿀 수 없습니다 (관리자에게 문의).",
        )
    from app.modules.workspaces import services as ws_services

    accessible = set(ws_services.get_descendants_inclusive(db, actor.workspace.slug))
    if not any(s in accessible for s in current_owners):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 템플릿을 소유한 부서의 매니저만 공유 범위를 바꿀 수 있습니다.",
        )
    try:
        template = services.set_template_scope(
            db, template_id, payload.owner_workspace_slugs
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    if template is None:
        return not_found_response(f"Template not found: {template_id}")
    return success_response(data=TemplateRead.from_orm_(template))


@router.post("/{template_id}/versions")
def publish_new_version(
    template_id: str,
    payload: TemplateNewVersion,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_manager),
):
    latest = services.get_latest_version(db, template_id)
    if not latest or not services.is_visible(db, latest, actor.workspace.slug):
        return not_found_response(f"Template not found: {template_id}")
    try:
        template = services.create_new_version(
            db, template_id, payload, created_by_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=TemplateRead.from_orm_(template))
