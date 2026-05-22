"""VOC routes — posts + comments. Visibility is system-wide (any
authenticated user can read/write own content); status / priority
changes and deleting others' content require admin role.

Auth model is intentionally *not* `get_current_user` (which requires
X-Workspace-Slug). VOC lives outside the workspace tree — the
sidebar links to /voc with no workspace prefix, so we'd fail the
header check for anyone who opens the page before a workspace is
loaded. Instead we use a small VOC-specific dep that returns
(user, is_admin) where admin = holds admin role in *any* workspace.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.voc import services
from app.modules.voc.models import VocCategory, VocStatus
from app.modules.voc.schemas import (
    VocCommentCreate,
    VocCommentRead,
    VocCommentUpdate,
    VocPostCreate,
    VocPostDetail,
    VocPostListResponse,
    VocPostPriorityUpdate,
    VocPostRead,
    VocPostStatusUpdate,
    VocPostUpdate,
)
from app.shared.auth import (
    _resolve_user_from_token,
    bearer_scheme,
)
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@dataclass
class VocActor:
    """Resolved caller for VOC routes — user + global admin flag +
    optional workspace context (carried via header for triage
    metadata, never required)."""

    user: User
    is_admin: bool
    workspace_slug: Optional[str]


def voc_actor(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
) -> VocActor:
    """Auth dep that doesn't require workspace membership. `is_admin`
    here is broader than the usual workspace-scoped admin check: any
    user who is admin in *any* workspace counts as a VOC admin.
    That's the right granularity for a system-wide board where
    triaging feedback shouldn't be gated on which team's page you
    happen to be looking at."""
    user = _resolve_user_from_token(db, credentials)
    is_admin = (
        db.execute(
            select(WorkspaceMember.id)
            .where(
                WorkspaceMember.user_id == user.id,
                WorkspaceMember.role == Role.admin,
            )
            .limit(1)
        ).first()
        is not None
    )
    return VocActor(user=user, is_admin=is_admin, workspace_slug=x_workspace_slug)


def _can_modify_post(actor: VocActor, post) -> bool:
    """Author can edit/delete their own post; admin can edit/delete
    anyone's. Returns False otherwise."""
    if actor.is_admin:
        return True
    return post.author_user_id == actor.user.id


def _can_modify_comment(actor: VocActor, comment) -> bool:
    if actor.is_admin:
        return True
    return comment.author_user_id == actor.user.id


@router.get("")
def list_posts(
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
    status: Optional[VocStatus] = None,
    category: Optional[VocCategory] = None,
    mine: bool = False,
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """Listing — server-paginated with limit / offset. Default page is
    200 because the client virtualizes within a chunk and auto-fetches
    the next chunk on scroll; 200 keeps the JSON ~100 KB while giving
    the virtualizer enough headroom that small scrolls don't trigger
    a network round-trip.

    Filters: status / category / mine (current user's posts only)."""
    rows, total = services.list_posts(
        db,
        status=status,
        category=category,
        author_user_id=actor.user.id if mine else None,
        limit=limit,
        offset=offset,
    )
    return success_response(
        data=VocPostListResponse(
            items=[VocPostRead.model_validate(r) for r in rows],
            total=total,
            limit=limit,
            offset=offset,
        )
    )


@router.post("", status_code=201)
def create_post(
    payload: VocPostCreate,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    # If the caller didn't pin a workspace_slug on the payload, fall back
    # to whatever workspace they currently have in the header — useful
    # triage context for admins reading the post later. Header is
    # optional, so this stays None if the caller didn't send one.
    if payload.workspace_slug is None and actor.workspace_slug:
        payload = payload.model_copy(update={"workspace_slug": actor.workspace_slug})
    post = services.create_post(db, payload, author_user_id=actor.user.id)
    return created_response(data=VocPostRead.model_validate(services._post_to_dict(post)))


@router.get("/{post_id}")
def get_post(
    post_id: int,
    db: Session = Depends(get_db),
    _: VocActor = Depends(voc_actor),
):
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"VOC 글을 찾을 수 없습니다: {post_id}")
    return success_response(data=VocPostDetail.model_validate(services.post_detail_dict(post)))


@router.patch("/{post_id}")
def update_post(
    post_id: int,
    payload: VocPostUpdate,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"VOC 글을 찾을 수 없습니다: {post_id}")
    if not _can_modify_post(actor, post):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 글을 수정할 권한이 없습니다.")
    post = services.update_post(db, post, payload)
    return success_response(data=VocPostRead.model_validate(services._post_to_dict(post)))


@router.delete("/{post_id}")
def delete_post(
    post_id: int,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"VOC 글을 찾을 수 없습니다: {post_id}")
    if not _can_modify_post(actor, post):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 글을 삭제할 권한이 없습니다.")
    services.delete_post(db, post)
    return success_response(message="삭제되었습니다.")


# --- Admin triage --------------------------------------------------------- #
# Status / priority changes are a triage action — admin-only so a random
# poster can't mark their own bug "wontfix" or boost their priority.
@router.patch("/{post_id}/status")
def change_status(
    post_id: int,
    payload: VocPostStatusUpdate,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    if not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "상태 변경은 관리자만 가능합니다."
        )
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"VOC 글을 찾을 수 없습니다: {post_id}")
    post = services.set_status(db, post, payload.status)
    return success_response(data=VocPostRead.model_validate(services._post_to_dict(post)))


@router.patch("/{post_id}/priority")
def change_priority(
    post_id: int,
    payload: VocPostPriorityUpdate,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    if not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "우선순위 변경은 관리자만 가능합니다."
        )
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"VOC 글을 찾을 수 없습니다: {post_id}")
    post = services.set_priority(db, post, payload.priority)
    return success_response(data=VocPostRead.model_validate(services._post_to_dict(post)))


# --- Comments ------------------------------------------------------------- #
@router.post("/{post_id}/comments", status_code=201)
def add_comment(
    post_id: int,
    payload: VocCommentCreate,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"VOC 글을 찾을 수 없습니다: {post_id}")
    comment = services.create_comment(db, post, payload, author_user_id=actor.user.id)
    return created_response(
        data=VocCommentRead.model_validate(services._comment_to_dict(comment))
    )


@router.patch("/comments/{comment_id}")
def edit_comment(
    comment_id: int,
    payload: VocCommentUpdate,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    comment = services.get_comment(db, comment_id)
    if not comment:
        return not_found_response(f"댓글을 찾을 수 없습니다: {comment_id}")
    if not _can_modify_comment(actor, comment):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 댓글을 수정할 권한이 없습니다.")
    comment = services.update_comment(db, comment, payload)
    return success_response(
        data=VocCommentRead.model_validate(services._comment_to_dict(comment))
    )


@router.delete("/comments/{comment_id}")
def delete_comment(
    comment_id: int,
    db: Session = Depends(get_db),
    actor: VocActor = Depends(voc_actor),
):
    comment = services.get_comment(db, comment_id)
    if not comment:
        return not_found_response(f"댓글을 찾을 수 없습니다: {comment_id}")
    if not _can_modify_comment(actor, comment):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 댓글을 삭제할 권한이 없습니다.")
    services.delete_comment(db, comment)
    return success_response(message="삭제되었습니다.")
