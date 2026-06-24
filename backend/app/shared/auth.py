"""JWT-based authentication + workspace context resolver.

Each request must carry:
    Authorization: Bearer <access-token>   — issued by /api/auth/login
    X-Workspace-Slug: <slug>               — the workspace the user is operating in

The token's `sub` claim is the user id. Membership is resolved by walking
up the workspace tree, so a 본부 admin implicitly has admin on all 팀들.

Roles:
    admin   — manage members + base data (categories, workspaces); + manager rights
    manager — manage templates (create/edit/delete) + writer rights
    user    — write/edit/delete reports and composite reports within own workspace
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.auth.services import decode_access_token
from app.modules.users import pat
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind, WorkspaceStatus

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    """Resolved request actor + active workspace context."""

    user: User
    workspace: Workspace
    role: Role  # role on `workspace` (after tree traversal)
    # 조직 간 공개(조직간공개_설계.md §7.3 / Phase 5). 이 게시판의 멤버가
    # 아닌데 *공개 컨텐츠가 있어* 읽기전용으로 진입한 외부 열람자면 True.
    # role 은 편의상 user 로 합성하지만, 이 플래그가 서면 모든 쓰기·곁다리는
    # 거부되고 가시성은 "공개분만" 으로 좁혀진다(can_read_report 참조).
    public_viewer: bool = False
    # 보관된 TF(archived) 에 멤버로 진입(TF조직_설계.md §7). public_viewer 와
    # 달리 **멤버 가시성은 유지**(자기 TF 자료를 읽을 수 있어야 함)하되 쓰기·
    # 게시·댓글만 막는 읽기전용. public_viewer 로 합성하면 가시성이 grant 기반
    # 으로 좁혀져 TF 자체 자료가 안 보이므로 별도 플래그로 둔다.
    read_only: bool = False

    @property
    def is_manager(self) -> bool:
        """이 부서의 '매니저' (workspace_members.role=manager). p8 이전엔
        Role.admin 이었던 것 — 이름만 바뀜, 권한 의미는 동일."""
        return self.role == Role.manager

    # 옛 이름 유지: 외부에서 actor.is_admin 으로 부르던 곳이 있을 수 있어
    # alias. 'admin' 이라는 단어가 User.is_system_admin 과 헷갈리므로 신규
    # 코드는 is_manager 를 쓸 것.
    @property
    def is_admin(self) -> bool:
        return self.is_manager

    @property
    def can_write_reports(self) -> bool:
        # 모든 부서 멤버(매니저/사용자)는 보고서·종합보고를 작성·편집.
        # 가상 부서(_global 등)는 require_writer 가 별도로 거절. 외부 공개
        # 열람자(public_viewer)·보관 TF 진입자(read_only)는 쓰기 불가.
        return (
            not self.public_viewer
            and not self.read_only
            and self.role in (Role.manager, Role.user)
        )


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
    # 개인 액세스 토큰(rat_…) — JWT 와 접두사로 구분. MCP 등 외부 클라이언트용.
    if credentials.credentials.startswith(pat.TOKEN_PREFIX):
        user = pat.resolve_token(db, credentials.credentials)
        if user is None:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "토큰이 유효하지 않거나 취소·만료되었습니다.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        return user
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
        if not any_membership and not user.is_system_admin:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "어느 부서에도 속해있지 않습니다.")
        # 시스템 관리자는 가상 부서에서도 매니저 권한으로 — 다른 부서를
        # 가로질러 데이터를 손볼 수 있어야 한다는 요구사항(시스템 내 모든
        # 데이터 CRUD)을 만족하려면 가상 aggregate 도 read-only 가 아니라
        # write 까지 허용해야 정합. require_writer 의 가상 거절은 그대로
        # 두므로 _global 같은 노드에서의 쓰기는 여전히 막힘.
        synthesized = Role.manager if user.is_system_admin else Role.user
        return CurrentUser(user=user, workspace=workspace, role=synthesized)

    role = _resolve_role(db, user.id, workspace.slug)
    if role is None:
        # 시스템 관리자 bypass — 부서 멤버 row 가 없어도 어떤 부서든 매니저
        # 권한으로 진입 가능. '시스템 관리자는 시스템 내 모든 데이터의 생성/
        # 편집/삭제 권한' 정책의 구현 지점.
        if user.is_system_admin:
            role = Role.manager
        elif _workspace_has_public_content(
            db, workspace.slug
        ) or _grant_services().user_has_container_grant_on_board(
            db, user.id, workspace.slug
        ):
            # 멤버는 아니지만 *읽기전용* 으로 진입을 허용하는 두 경우:
            #   1) 이 게시판에 전체공개(all_org) 컨텐츠가 있음(조직 간 공개, Phase 5)
            #   2) 이 게시판/폴더가 이 사용자(소속 부서 포함)에게 공유됨
            #      (게시판/폴더 단위 grant) — 공유받은 부서가 목록을 브라우즈.
            # role 은 합성 user 지만 public_viewer 플래그가 모든 쓰기·곁다리를
            # 막는다. 가시성은 grant 기반(멤버십)으로 계산돼 공유분만 보인다.
            # 둘 다 아니면 기존대로 403.
            return CurrentUser(
                user=user, workspace=workspace, role=Role.user, public_viewer=True
            )
        else:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"{user.email}는 부서 {workspace.slug}에 접근 권한이 없습니다.",
            )
    # 보관된 TF 는 멤버(시스템관리자 포함)도 읽기전용으로만 — 쓰기·게시·댓글 차단.
    # 복원(un-archive)은 워크스페이스 컨텍스트가 필요 없는 별도 엔드포인트로 한다.
    read_only = (
        workspace.kind == WorkspaceKind.tf
        and workspace.status == WorkspaceStatus.archived
    )
    return CurrentUser(
        user=user, workspace=workspace, role=role, read_only=read_only
    )


def _grant_services():
    # 지연 import — auth 는 저수준 모듈이라 grants 서비스를 top-level 에서 끌면
    # 순환 import 위험이 있다.
    from app.modules.grants import services as grant_services

    return grant_services


def _workspace_has_public_content(db: Session, workspace_slug: str) -> bool:
    """이 org 게시판에 공개(all_org grant)된 컨텐츠가 *이 게시판에 배치된 채로*
    하나라도 있나 — 비멤버 읽기전용 진입 허용 판정(공유/권한 개편).

    1. 공개 보고서: all_org grant 보유 + 이 게시판에 mount(배치).
    2. 공개 종합보고: all_org grant 보유 + home board == 이 게시판.

    배치(W)를 함께 보는 이유: 전사 공개 1건이 모든 게시판을 비멤버에게 열어버리는
    사고를 막는다(콘텐츠가 실제로 이 게시판에 올라와 있을 때만 입장 허용)."""
    from sqlalchemy import and_

    from app.modules.composites.models import CompositeReport
    from app.modules.folders.models import Folder
    from app.modules.grants.models import (
        BoardGrant,
        ContentGrant,
        FolderGrant,
        GrantContentType,
        GrantPrincipalType,
    )
    from app.modules.mounts.models import ReportMount

    ws = db.get(Workspace, workspace_slug)
    if ws is None or ws.kind != WorkspaceKind.org:
        return False

    # 게시판 통째 전체공개 — 그 게시판의 모든 콘텐츠가 공개라 비멤버 입장 허용.
    board_public = db.execute(
        select(BoardGrant.id)
        .where(
            BoardGrant.board_slug == workspace_slug,
            BoardGrant.principal_type == GrantPrincipalType.all_org,
        )
        .limit(1)
    ).first()
    if board_public is not None:
        return True

    # 이 게시판의 폴더가 전체공개면 그 폴더 보고서가 공개라 비멤버 입장 허용.
    folder_public = db.execute(
        select(FolderGrant.id)
        .join(Folder, Folder.id == FolderGrant.folder_id)
        .where(
            Folder.workspace_slug == workspace_slug,
            FolderGrant.principal_type == GrantPrincipalType.all_org,
        )
        .limit(1)
    ).first()
    if folder_public is not None:
        return True

    # 종합보고 기본 전체공개(이 워크스페이스가 home) — 비멤버 입장 허용.
    if _grant_services().composite_default_has_all_org(db, workspace_slug):
        return True

    has_public_report = db.execute(
        select(ReportMount.report_id)
        .join(
            ContentGrant,
            and_(
                ContentGrant.content_type == GrantContentType.report,
                ContentGrant.content_id == ReportMount.report_id,
                ContentGrant.principal_type == GrantPrincipalType.all_org,
            ),
        )
        .where(ReportMount.workspace_slug == workspace_slug)
        .limit(1)
    ).first()
    if has_public_report is not None:
        return True

    has_public_composite = db.execute(
        select(CompositeReport.id)
        .join(
            ContentGrant,
            and_(
                ContentGrant.content_type == GrantContentType.composite,
                ContentGrant.content_id == CompositeReport.id,
                ContentGrant.principal_type == GrantPrincipalType.all_org,
            ),
        )
        .where(CompositeReport.workspace_slug == workspace_slug)
        .limit(1)
    ).first()
    return has_public_composite is not None


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


# 부서 매니저 권한이 필요한 라우트 게이트. p8 이전엔 require_admin/
# require_manager 가 따로 있었지만 의미가 같아져 (manager+admin 합쳐짐)
# 하나로 통합. 기존 import 호환을 위해 require_admin 은 alias 로 유지.
require_manager = require_role(Role.manager)
require_admin = require_manager


def require_system_admin(
    actor: User = Depends(get_current_user_no_workspace),
) -> User:
    """Gate for system-wide actions — workspace tree CRUD, base data
    masters (categories, entities, report types, etc.), server pages.

    This is independent of workspace memberships: even a 부서 관리자
    with `WorkspaceMember.role=admin` cannot manage the system unless
    they also have `User.is_system_admin=true`. The bootstrap admin
    (user id=1) is seeded in the migration; further system admins are
    granted by existing ones via SQL or a future admin UI.
    """
    if not actor.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "시스템 관리자 권한이 필요합니다.",
        )
    return actor


def require_lead(
    actor: User = Depends(get_current_user_no_workspace),
    db: Session = Depends(get_db),
) -> User:
    """TF 개설 게이트 — 보직장(org 부서 매니저) 이상 또는 시스템관리자
    (TF조직_설계.md §4). 워크스페이스 컨텍스트가 필요 없다(개설 시점엔 아직
    TF 가 없으므로). personal 매니저는 제외(services.user_is_lead 참조)."""
    from app.modules.workspaces import services as ws_services

    if not ws_services.user_is_lead(db, actor):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "TF 개설 권한이 없습니다 (부서 매니저 이상만 가능).",
        )
    return actor


def require_writer(actor: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """Allow any authenticated workspace member to write reports / composites,
    but reject virtual aggregate workspaces (e.g. `_global`) — those are
    read-only views and writes there would have no meaningful target.
    """
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "가상(통합) 부서에서는 쓰기 작업을 할 수 없습니다. 실제 부서를 선택하세요.",
        )
    if actor.public_viewer:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "다른 조직의 공개 게시판은 읽기 전용입니다.",
        )
    if actor.read_only:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "보관된 TF 는 읽기 전용입니다. 복원 후 작업하세요.",
        )
    if actor.role not in (Role.manager, Role.user):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"권한 부족 (현재: {actor.role.value})",
        )
    return actor
