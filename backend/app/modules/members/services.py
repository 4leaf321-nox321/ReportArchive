"""Business logic for workspace members."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.members.schemas import MemberRead, MemberSource
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces import services as ws_services


def _query_members_at(db: Session, workspace_slug: str):
    return list(
        db.execute(
            select(WorkspaceMember, User)
            .join(User, User.id == WorkspaceMember.user_id)
            .where(WorkspaceMember.workspace_slug == workspace_slug)
        ).all()
    )


def list_effective_members(db: Session, workspace_slug: str) -> list[MemberRead]:
    """Returns only members who actually have access to this workspace:
        1. direct      — rows on this workspace
        2. inherited   — rows on ancestor workspaces (cascades down)

    이전엔 descendant 부서의 멤버까지 합쳐 반환했는데, 자손 부서 멤버는
    이 워크스페이스에 실제 권한이 없는데도 매니저 명단·멤버 명단에 섞여
    "상속된 것처럼" 보여서 혼동을 야기했음. 자손 부서 관리는 그 부서의
    멤버 페이지로 이동해 수행 — 한 화면에 합쳐 보지 않는다.

    For ancestor inheritance the closest ancestor wins (one entry per user) —
    a row on the workspace itself shadows any ancestor inheritance.
    """
    members: list[MemberRead] = []

    # 1. Direct
    seen_via_inheritance: set[int] = set()
    for row in _query_members_at(db, workspace_slug):
        members.append(
            MemberRead(
                id=row.WorkspaceMember.id,
                user_id=row.User.id,
                email=row.User.email,
                name=row.User.name,
                role=row.WorkspaceMember.role,
                source=MemberSource.direct,
                source_workspace_slug=workspace_slug,
                created_at=row.WorkspaceMember.created_at,
                is_home=(row.User.home_workspace_slug == workspace_slug),
            )
        )
        seen_via_inheritance.add(row.User.id)

    # 2. Inherited from ancestors (closest ancestor wins, dedup by user_id)
    for ancestor in ws_services.get_ancestors(db, workspace_slug):
        for row in _query_members_at(db, ancestor.slug):
            if row.User.id in seen_via_inheritance:
                continue
            seen_via_inheritance.add(row.User.id)
            members.append(
                MemberRead(
                    id=row.WorkspaceMember.id,
                    user_id=row.User.id,
                    email=row.User.email,
                    name=row.User.name,
                    role=row.WorkspaceMember.role,
                    source=MemberSource.inherited,
                    source_workspace_slug=ancestor.slug,
                    created_at=None,
                    is_home=(row.User.home_workspace_slug == ancestor.slug),
                )
            )

    return members


def add_member(
    db: Session, workspace_slug: str, user: User, role: Role
) -> WorkspaceMember:
    existing = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.user_id == user.id,
            WorkspaceMember.workspace_slug == workspace_slug,
        )
    ).scalar_one_or_none()
    if existing:
        existing.role = role
        db.commit()
        return existing

    member = WorkspaceMember(
        user_id=user.id,
        workspace_slug=workspace_slug,
        role=role,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


def update_role(db: Session, member: WorkspaceMember, role: Role) -> WorkspaceMember:
    member.role = role
    db.commit()
    db.refresh(member)
    return member


def move_member(
    db: Session, member: WorkspaceMember, new_workspace_slug: str
) -> WorkspaceMember:
    """Reassigns a membership row to a different workspace.

    Caller (route) is responsible for verifying scope — that the target
    workspace is one the actor is allowed to move members into.

    If the user already has a membership on the target workspace, raises
    ValueError; callers should surface that as a 409 so the admin can
    delete the duplicate first.
    """
    if member.workspace_slug == new_workspace_slug:
        return member
    duplicate = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.user_id == member.user_id,
            WorkspaceMember.workspace_slug == new_workspace_slug,
        )
    ).scalar_one_or_none()
    if duplicate is not None:
        raise ValueError(
            f"이미 {new_workspace_slug} 부서의 멤버입니다. "
            "그쪽 멤버십을 먼저 제거하세요."
        )
    member.workspace_slug = new_workspace_slug
    db.commit()
    db.refresh(member)
    return member


def remove_member(db: Session, member: WorkspaceMember) -> None:
    """Drop a workspace_members row. 라우트가 home 부서 보호 규칙을 먼저
    검사한 뒤 호출 — home 인 사용자의 home 부서 row 는 계정 관리 페이지
    에서 home 을 다른 부서로 옮긴 뒤에야 떼낼 수 있다."""
    db.delete(member)
    db.commit()


def is_home_membership(db: Session, member: WorkspaceMember) -> bool:
    """이 멤버십 row 가 사용자의 home(소속) 부서 row 인지 — '본인의 home
    부서를 부서 멤버에서 빼면 모순' 이슈 방지용. 라우트가 삭제/이동 전에
    먼저 확인."""
    user = db.get(User, member.user_id)
    if user is None:
        return False
    return user.home_workspace_slug == member.workspace_slug


def get_direct_member(
    db: Session, workspace_slug: str, user_id: int
) -> Optional[WorkspaceMember]:
    return db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_slug == workspace_slug,
            WorkspaceMember.user_id == user_id,
        )
    ).scalar_one_or_none()
