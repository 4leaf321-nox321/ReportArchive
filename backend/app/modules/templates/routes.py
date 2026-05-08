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
    TemplateVersionSummary,
)
from app.shared.auth import CurrentUser, get_current_user, require_admin, require_manager
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
    actor: CurrentUser = Depends(require_admin),
):
    """Deletes ALL versions of a template. Admin-only because templates
    are shared infrastructure — manager-level edits are limited to
    publishing new versions, not destruction. Refuses if any reports
    still reference the template (409)."""
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
