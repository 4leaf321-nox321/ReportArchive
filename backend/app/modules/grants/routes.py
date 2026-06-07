"""통합 공유(grant) 라우트 — 보고서·종합보고 공통.

  GET    /api/{content_type}/{id}/shares   목록(can_view)
  POST   /api/{content_type}/{id}/shares   추가/갱신(소유자+시스템관리자)
  DELETE /api/{content_type}/{id}/shares/{grant_id}  제거(소유자+시스템관리자)

content_type ∈ {reports, composites}.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.composites import services as composite_services
from app.modules.folders.models import Folder, FolderKind
from app.modules.grants import services as services
from app.modules.grants.models import (
    BoardGrant,
    ContentGrant,
    FolderGrant,
    GrantContentType,
    GrantPrincipalType,
)
from app.modules.grants.schemas import GrantCreate, GrantRead
from app.modules.reports import services as report_services
from app.modules.users.models import Role, User
from app.modules.workspaces.models import Workspace, WorkspaceKind
from app.shared.auth import CurrentUser, _resolve_role, require_writer
from app.shared.responses import created_response, success_response

router = APIRouter()


_TYPE_MAP = {
    "reports": GrantContentType.report,
    "composites": GrantContentType.composite,
}


def _resolve_content(db: Session, content_type: str, content_id: int):
    """(GrantContentType, content_obj, owner_user_id) 반환. 없으면 404."""
    ct = _TYPE_MAP.get(content_type)
    if ct is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown content type")
    if ct == GrantContentType.report:
        obj = report_services.get_report(db, content_id)
    else:
        obj = composite_services.get(db, content_id)
    if obj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Content not found")
    return ct, obj, obj.owner_user_id


def _can_read(db, ct, obj, actor) -> bool:
    if ct == GrantContentType.report:
        return report_services.can_read_report(db, actor, obj)
    return composite_services.can_read_composite(db, actor, obj)


def _ensure_manager(actor: CurrentUser, owner_user_id: Optional[int]) -> None:
    """공유 추가/삭제 권한 — 소유자 또는 시스템관리자(EditorsDialog 와 동일 정책)."""
    is_owner = owner_user_id is not None and owner_user_id == actor.user.id
    is_sys_admin = bool(getattr(actor.user, "is_system_admin", False))
    if not (is_owner or is_sys_admin):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "공유 설정은 작성자(또는 시스템 관리자)만 변경할 수 있습니다.",
        )


def _label_for(db: Session, grant: ContentGrant) -> Optional[str]:
    if grant.principal_type == GrantPrincipalType.all_org:
        return "전체 공개"
    if grant.principal_type == GrantPrincipalType.workspace:
        ws = db.get(Workspace, grant.principal_ref)
        return ws.name if ws else grant.principal_ref
    if grant.principal_type == GrantPrincipalType.user:
        try:
            u = db.get(User, int(grant.principal_ref))
        except (TypeError, ValueError):
            u = None
        return u.name if u else grant.principal_ref
    return None


def _to_read(db: Session, grant: ContentGrant) -> GrantRead:
    obj = GrantRead.model_validate(grant)
    obj.principal_label = _label_for(db, grant)
    if grant.created_by_user_id is not None:
        cb = db.get(User, grant.created_by_user_id)
        obj.created_by_name = cb.name if cb else None
    return obj


# --------------------------------------------------------------------------- #
# 폴더(folder) 통째 공유 — /api/folders/{id}/shares
# (content_type 라우트보다 *먼저* 등록해야 folder_id:int 가 그쪽에 안 잡힘)
# --------------------------------------------------------------------------- #
def _resolve_folder(db: Session, folder_id: int) -> Folder:
    f = db.get(Folder, folder_id)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "폴더를 찾을 수 없습니다.")
    if f.kind != FolderKind.org:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "조직 폴더만 공유할 수 있습니다."
        )
    return f


@router.get("/folders/{folder_id}/shares")
def list_folder_shares(
    folder_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    _resolve_folder(db, folder_id)
    grants = services.list_folder_grants(db, folder_id)
    return success_response(
        data=[_to_read(db, g).model_dump(mode="json") for g in grants]
    )


@router.post("/folders/{folder_id}/shares")
def add_folder_share(
    folder_id: int,
    payload: GrantCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    folder = _resolve_folder(db, folder_id)
    _ensure_board_manager(db, actor, folder.workspace_slug)
    if payload.principal_type == GrantPrincipalType.workspace:
        ws = db.get(Workspace, payload.principal_ref)
        if ws is None or ws.kind != WorkspaceKind.org:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "조직 부서만 공유 대상이 될 수 있습니다."
            )
    elif payload.principal_type == GrantPrincipalType.user:
        try:
            uid = int(payload.principal_ref)
        except (TypeError, ValueError):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "잘못된 사용자 id")
        if db.get(User, uid) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다.")
    grant = services.upsert_folder_grant(
        db,
        folder_id,
        payload.principal_type,
        payload.principal_ref,
        payload.level,
        created_by_user_id=actor.user.id,
    )
    db.commit()
    db.refresh(grant)
    return created_response(data=_to_read(db, grant).model_dump(mode="json"))


@router.delete("/folders/{folder_id}/shares/{grant_id}")
def remove_folder_share(
    folder_id: int,
    grant_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    folder = _resolve_folder(db, folder_id)
    _ensure_board_manager(db, actor, folder.workspace_slug)
    grant = db.get(FolderGrant, grant_id)
    if grant is None or grant.folder_id != folder_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "공유 항목을 찾을 수 없습니다.")
    services.delete_folder_grant(db, grant)
    db.commit()
    return success_response(data=None, message="Deleted")


@router.get("/{content_type}/{content_id:int}/shares")
def list_shares(
    content_type: str,
    content_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    ct, obj, _owner = _resolve_content(db, content_type, content_id)
    if not _can_read(db, ct, obj, actor):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of scope")
    grants = services.list_grants(db, ct, content_id)
    return success_response(data=[_to_read(db, g).model_dump(mode="json") for g in grants])


@router.post("/{content_type}/{content_id:int}/shares")
def add_share(
    content_type: str,
    content_id: int,
    payload: GrantCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    ct, obj, owner = _resolve_content(db, content_type, content_id)
    _ensure_manager(actor, owner)

    # 대상 검증.
    if payload.principal_type == GrantPrincipalType.workspace:
        ws = db.get(Workspace, payload.principal_ref)
        if ws is None or ws.kind != WorkspaceKind.org:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "조직 부서만 공유 대상이 될 수 있습니다."
            )
    elif payload.principal_type == GrantPrincipalType.user:
        try:
            uid = int(payload.principal_ref)
        except (TypeError, ValueError):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "잘못된 사용자 id")
        if db.get(User, uid) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다.")

    grant = services.upsert_grant(
        db,
        ct,
        content_id,
        payload.principal_type,
        payload.principal_ref,
        payload.level,
        created_by_user_id=actor.user.id,
    )
    db.commit()
    db.refresh(grant)
    return created_response(data=_to_read(db, grant).model_dump(mode="json"))


@router.delete("/{content_type}/{content_id:int}/shares/{grant_id}")
def remove_share(
    content_type: str,
    content_id: int,
    grant_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    ct, obj, owner = _resolve_content(db, content_type, content_id)
    _ensure_manager(actor, owner)
    grant = db.get(ContentGrant, grant_id)
    if grant is None or grant.content_type != ct or grant.content_id != content_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "공유 항목을 찾을 수 없습니다.")
    services.delete_grant(db, grant)
    db.commit()
    return success_response(data=None, message="Deleted")


# --------------------------------------------------------------------------- #
# 게시판(board) 통째 공유 — /api/workspaces/{slug}/shares
# --------------------------------------------------------------------------- #
def _resolve_board(db: Session, slug: str) -> Workspace:
    ws = db.get(Workspace, slug)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "게시판을 찾을 수 없습니다.")
    if ws.kind != WorkspaceKind.org:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "조직 게시판만 공유할 수 있습니다."
        )
    return ws


def _ensure_board_manager(db: Session, actor: CurrentUser, slug: str) -> None:
    """게시판 공유 설정 — 그 게시판 매니저(조상 포함) 또는 시스템관리자만
    (옛 external-view 토글과 동일 게이트)."""
    is_sys_admin = bool(getattr(actor.user, "is_system_admin", False))
    is_manager = _resolve_role(db, actor.user.id, slug) == Role.manager
    if not (is_sys_admin or is_manager):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "게시판 공유는 그 게시판 매니저(또는 시스템 관리자)만 변경할 수 있습니다.",
        )


@router.get("/workspaces/{slug}/shares")
def list_board_shares(
    slug: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    _resolve_board(db, slug)
    grants = services.list_board_grants(db, slug)
    return success_response(
        data=[_to_read(db, g).model_dump(mode="json") for g in grants]
    )


@router.post("/workspaces/{slug}/shares")
def add_board_share(
    slug: str,
    payload: GrantCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    _resolve_board(db, slug)
    _ensure_board_manager(db, actor, slug)
    if payload.principal_type == GrantPrincipalType.workspace:
        ws = db.get(Workspace, payload.principal_ref)
        if ws is None or ws.kind != WorkspaceKind.org:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "조직 부서만 공유 대상이 될 수 있습니다."
            )
    elif payload.principal_type == GrantPrincipalType.user:
        try:
            uid = int(payload.principal_ref)
        except (TypeError, ValueError):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "잘못된 사용자 id")
        if db.get(User, uid) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다.")
    grant = services.upsert_board_grant(
        db,
        slug,
        payload.principal_type,
        payload.principal_ref,
        payload.level,
        created_by_user_id=actor.user.id,
    )
    db.commit()
    db.refresh(grant)
    return created_response(data=_to_read(db, grant).model_dump(mode="json"))


@router.delete("/workspaces/{slug}/shares/{grant_id}")
def remove_board_share(
    slug: str,
    grant_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    _resolve_board(db, slug)
    _ensure_board_manager(db, actor, slug)
    grant = db.get(BoardGrant, grant_id)
    if grant is None or grant.board_slug != slug:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "공유 항목을 찾을 수 없습니다.")
    services.delete_board_grant(db, grant)
    db.commit()
    return success_response(data=None, message="Deleted")
