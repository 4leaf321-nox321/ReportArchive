"""Workspace routes — read-only catalog (any user) + admin CRUD."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.users.models import User
from app.modules.workspaces import services
from app.modules.workspaces.models import Workspace, WorkspaceKind
from app.modules.users.models import Role
from app.modules.workspaces.schemas import (
    TFArchiveUpdate,
    TFWorkspaceCreate,
    WorkspaceBulkCreate,
    WorkspaceCreate,
    WorkspaceExternalViewUpdate,
    WorkspaceRead,
    WorkspaceUpdate,
)
from app.shared.auth import (
    CurrentUser,
    _resolve_role,
    get_current_user_no_workspace,
    require_lead,
    require_system_admin,
)
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("")
def list_all_workspaces(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """Return the workspace registry visible to the caller. Tree shape is
    built on the client. Doesn't require X-Workspace-Slug — this endpoint
    is what the client calls to discover workspaces in the first place.

    Visibility rules:
      * org / virtual workspaces — everyone sees them (catalog data).
      * personal workspaces — only the owner (and system admins) see
        them. Without this filter the payload leaks every user's
        display name (the workspace name is "{user.name} (개인)"),
        which is a privacy issue even though the existing UI consumers
        filter `kind=='personal'` for tree rendering.
    """
    all_rows = services.list_workspaces(db)
    if user.is_system_admin:
        visible = all_rows
    else:
        # org/virtual — 전원 노출. personal — 소유자만. TF — **멤버만**
        # (TF조직_설계.md §5: org 처럼 browse-all 이 아니라 멤버십 스코프 —
        # 비멤버 드롭다운엔 TF 가 보이지 않아 존재 자체가 새지 않음).
        my_tf = services.member_tf_slugs(db, user.id)
        visible = [
            w
            for w in all_rows
            if (
                w.kind == WorkspaceKind.personal
                and w.personal_owner_user_id == user.id
            )
            or (w.kind == WorkspaceKind.tf and w.slug in my_tf)
            or w.kind not in (WorkspaceKind.personal, WorkspaceKind.tf)
        ]
    items = [WorkspaceRead.model_validate(w) for w in visible]
    return success_response(data=items)


@router.get("/tf/all")
def list_all_tf(
    db: Session = Depends(get_db),
    _: User = Depends(require_system_admin),
):
    """시스템관리자 감독용 — 모든 TF(보관 포함)를 반환(TF조직_설계.md §4).
    난립 사후 정리·강제 종료·소유자 재지정 화면의 데이터 소스."""
    rows = [
        w for w in services.list_workspaces(db) if w.kind == WorkspaceKind.tf
    ]
    return success_response(data=[WorkspaceRead.model_validate(w) for w in rows])


@router.post("/tf")
def create_tf(
    payload: TFWorkspaceCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_lead),
):
    """TF 개설 — 보직장(org 매니저) 이상 self-service. 개설자=매니저,
    member_emails 로 부서 무관 차출(TF조직_설계.md §4). 미가입 이메일은
    건너뛰고 message 로 알린다."""
    try:
        ws, missing = services.create_tf_workspace(db, payload, actor)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    msg = None
    if missing:
        msg = f"등록되지 않아 추가하지 못한 이메일: {', '.join(missing)}"
    return created_response(data=WorkspaceRead.model_validate(ws), message=msg)


@router.patch("/{slug}/archive")
def set_tf_archived(
    slug: str,
    payload: TFArchiveUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """TF 보관/복원(읽기전용 보존) — 그 TF 의 매니저 또는 시스템관리자
    (TF조직_설계.md §7). org/personal/virtual 은 거부."""
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    if ws.kind != WorkspaceKind.tf:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "TF 만 보관/복원할 수 있습니다."
        )
    if not (
        actor.is_system_admin or _resolve_role(db, actor.id, slug) == Role.manager
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 TF 의 매니저만 보관/복원할 수 있습니다.",
        )
    ws = services.set_workspace_archived(db, ws, actor, payload.archived)
    return success_response(data=WorkspaceRead.model_validate(ws))


@router.post("")
def create_workspace(
    payload: WorkspaceCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        ws = services.create_workspace(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=WorkspaceRead.model_validate(ws))


@router.post("/bulk")
def bulk_create_workspaces(
    payload: WorkspaceBulkCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Bulk-create from a paste table. Parent column carries the parent's
    *name*, not its slug — operators copy from a spreadsheet that doesn't
    know slugs. See `services.bulk_create_workspaces` for resolution rules."""
    try:
        created = services.bulk_create_workspaces(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(
        data=[WorkspaceRead.model_validate(w) for w in created]
    )


@router.patch("/{slug}")
def update_workspace(
    slug: str,
    payload: WorkspaceUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    if ws.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 부서는 수정할 수 없습니다."
        )
    try:
        ws = services.update_workspace(db, ws, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=WorkspaceRead.model_validate(ws))


@router.patch("/{slug}/external-view")
def set_workspace_external_view(
    slug: str,
    payload: WorkspaceExternalViewUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """게시판 기본 공개정책(external_view_default) 토글 — 그 게시판의 매니저
    (조상 매니저 포함) 또는 시스템관리자만. 일반 PATCH /workspaces 는 시스템
    관리자 전용이라, 공개 권한만 매니저에게 위임하려고 별도 엔드포인트로 둔다
    (조직간공개_설계.md §8 (a)). org 게시판에만 의미 — personal/virtual 거부."""
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    if ws.kind != WorkspaceKind.org:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "조직 게시판만 공개 설정을 가질 수 있습니다.",
        )
    if not (
        actor.is_system_admin or _resolve_role(db, actor.id, slug) == Role.manager
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 게시판의 매니저만 공개 설정을 변경할 수 있습니다.",
        )
    ws.external_view_default = payload.external_view_default
    db.commit()
    db.refresh(ws)
    return success_response(data=WorkspaceRead.model_validate(ws))


@router.delete("/{slug}")
def delete_workspace(
    slug: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    if ws.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 부서는 삭제할 수 없습니다."
        )
    # personal-{user_id} workspaces are auto-provisioned per user and own
    # the user's reports — deleting one would either CASCADE-drop those
    # reports or RESTRICT-block, and either outcome is wrong via this
    # API. The user's own personal space is managed by the user-lifecycle
    # flow (signup creates it; user-delete cascades it away).
    if ws.kind == WorkspaceKind.personal:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "개인 작업공간은 이 경로로 삭제할 수 없습니다. "
            "사용자 계정을 삭제하면 함께 제거됩니다.",
        )
    try:
        services.delete_workspace(db, ws)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return success_response(data=None, message="부서가 삭제되었습니다.")


@router.get("/{slug}/dependents")
def workspace_dependents(
    slug: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Returns counts of children/members/reports/templates so the admin UI
    can show 'blocked by N items' before attempting delete."""
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    return success_response(data=services.workspace_blockers(db, slug))
