"""JWT-based authentication + workspace context resolver.

Each request must carry:
    Authorization: Bearer <access-token>   — issued by /api/auth/login
    X-Workspace-Slug: <slug>               — the workspace the user is operating in

The token's `sub` claim is the user id. Membership is resolved by walking
up the workspace tree, so a 본부 admin implicitly has admin on all 팀들.

Roles:
    admin   — manage members + base data (categories, workspaces); + manager rights
    manager — write/edit/delete reports + create/edit templates
    user    — read reports
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.auth.services import decode_access_token
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    """Resolved request actor + active workspace context."""

    user: User
    workspace: Workspace
    role: Role  # role on `workspace` (after tree traversal)

    @property
    def is_admin(self) -> bool:
        return self.role == Role.admin

    @property
    def can_write_reports(self) -> bool:
        return self.role in (Role.admin, Role.manager)


# --------------------------------------------------------------------------- #
# Resolvers
# --------------------------------------------------------------------------- #
def _resolve_user_from_token(
    db: Session, credentials: Optional[HTTPAuthorizationCredentials]
) -> User:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "인증 토큰이 필요합니다.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_access_token(credentials.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "토큰이 만료되었습니다. 다시 로그인하세요.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "토큰이 유효하지 않습니다.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "토큰에 사용자 정보가 없습니다.")

    try:
        user_id = int(sub)
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "토큰의 사용자 식별자가 잘못되었습니다.")

    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "사용자를 찾을 수 없거나 비활성입니다.")
    return user


def _resolve_workspace(db: Session, slug: Optional[str]) -> Workspace:
    if not slug:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "X-Workspace-Slug 헤더가 필요합니다.",
        )
    ws = db.get(Workspace, slug)
    if not ws:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"부서를 찾을 수 없습니다: {slug}")
    return ws


def _resolve_role(db: Session, user_id: int, workspace_slug: str) -> Optional[Role]:
    """Returns the user's role on the workspace by walking up the tree.

    A membership at an ancestor (e.g. 본부) implicitly grants the same role
    on descendants (팀). The closest ancestor wins — direct membership on
    the workspace itself takes precedence.
    """
    visited: set[str] = set()
    cur: Optional[str] = workspace_slug
    while cur and cur not in visited:
        visited.add(cur)
        membership = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == user_id,
                WorkspaceMember.workspace_slug == cur,
            )
        ).scalar_one_or_none()
        if membership:
            return membership.role
        ws = db.get(Workspace, cur)
        if not ws:
            break
        cur = ws.parent_slug
    return None


# --------------------------------------------------------------------------- #
# FastAPI dependencies
# --------------------------------------------------------------------------- #
def get_current_user(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
) -> CurrentUser:
    user = _resolve_user_from_token(db, credentials)
    workspace = _resolve_workspace(db, x_workspace_slug)

    # Virtual workspaces (e.g. _global) are aggregate views — anyone with any
    # membership can read, but no write privileges granted.
    if workspace.virtual:
        any_membership = db.execute(
            select(WorkspaceMember).where(WorkspaceMember.user_id == user.id)
        ).first()
        if not any_membership:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "어느 부서에도 속해있지 않습니다.")
        return CurrentUser(user=user, workspace=workspace, role=Role.user)

    role = _resolve_role(db, user.id, workspace.slug)
    if role is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"{user.email}는 부서 {workspace.slug}에 접근 권한이 없습니다.",
        )
    return CurrentUser(user=user, workspace=workspace, role=role)


def get_current_user_no_workspace(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> User:
    """For endpoints that need the user but don't require a workspace context
    (e.g. /api/me — used to discover what workspaces the user can see)."""
    return _resolve_user_from_token(db, credentials)


def require_role(*allowed: Role):
    """Dependency factory — endpoint allows only the given roles."""

    def _check(actor: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if actor.role not in allowed:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"권한 부족 (필요: {[r.value for r in allowed]}, 현재: {actor.role.value})",
            )
        return actor

    return _check


require_admin = require_role(Role.admin)
require_manager = require_role(Role.admin, Role.manager)
require_writer = require_manager  # alias for "can write reports"
