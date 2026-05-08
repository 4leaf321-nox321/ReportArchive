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
    """Returns the workspace's effective member roster:
        1. direct      — rows on this workspace
        2. inherited   — rows on ancestor workspaces (cascades down)
        3. descendant  — rows on child workspaces (admin can manage)

    For ancestor inheritance the closest ancestor wins (one entry per user).
    For descendants, every membership row is shown — a user assigned to two
    different sub-workspaces shows up twice with the appropriate role + slug.
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
                )
            )

    # 3. Descendants (no dedup — show each sub-workspace assignment)
    descendants = [
        s
        for s in ws_services.get_descendants_inclusive(db, workspace_slug)
        if s != workspace_slug
    ]
    for descendant_slug in descendants:
        for row in _query_members_at(db, descendant_slug):
            members.append(
                MemberRead(
                    id=row.WorkspaceMember.id,
                    user_id=row.User.id,
                    email=row.User.email,
                    name=row.User.name,
                    role=row.WorkspaceMember.role,
                    source=MemberSource.descendant,
                    source_workspace_slug=descendant_slug,
                    created_at=row.WorkspaceMember.created_at,
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


def remove_member(db: Session, member: WorkspaceMember) -> None:
    db.delete(member)
    db.commit()


def get_direct_member(
    db: Session, workspace_slug: str, user_id: int
) -> Optional[WorkspaceMember]:
    return db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_slug == workspace_slug,
            WorkspaceMember.user_id == user_id,
        )
    ).scalar_one_or_none()
