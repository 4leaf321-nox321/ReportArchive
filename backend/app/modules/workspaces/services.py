"""Workspace tree services.

Tree traversal is done in Python (org chart is small enough that recursive
CTEs aren't worth the complexity).
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.reports.models import Report
from app.modules.templates.models import Template
from app.modules.users.models import WorkspaceMember
from app.modules.workspaces.models import Workspace
from app.modules.workspaces.schemas import WorkspaceCreate, WorkspaceUpdate


def list_workspaces(db: Session) -> list[Workspace]:
    return list(
        db.execute(select(Workspace).order_by(Workspace.sort_order, Workspace.slug)).scalars()
    )


def get_descendants_inclusive(db: Session, slug: str) -> list[str]:
    """Returns slug + all descendant slugs (depth-first)."""
    all_ws = list_workspaces(db)
    children_of: dict[str | None, list[str]] = {}
    for w in all_ws:
        children_of.setdefault(w.parent_slug, []).append(w.slug)

    result: list[str] = []
    stack = [slug]
    while stack:
        cur = stack.pop()
        result.append(cur)
        for child in children_of.get(cur, []):
            stack.append(child)
    return result


def get_ancestors(db: Session, slug: str) -> list[Workspace]:
    """Ancestors from root to direct parent (excludes self)."""
    path: list[Workspace] = []
    cur: Optional[str] = slug
    seen: set[str] = set()
    while cur and cur not in seen:
        seen.add(cur)
        ws = db.get(Workspace, cur)
        if not ws or ws.parent_slug is None:
            break
        parent = db.get(Workspace, ws.parent_slug)
        if not parent:
            break
        path.insert(0, parent)
        cur = parent.parent_slug
    return path


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #
def create_workspace(db: Session, payload: WorkspaceCreate) -> Workspace:
    if db.get(Workspace, payload.slug):
        raise ValueError(f"이미 존재하는 부서 슬러그입니다: {payload.slug}")
    if payload.parent_slug:
        parent = db.get(Workspace, payload.parent_slug)
        if not parent:
            raise ValueError(f"상위 부서가 없습니다: {payload.parent_slug}")
        if parent.virtual:
            raise ValueError("가상 부서 아래에 자식을 만들 수 없습니다.")

    ws = Workspace(
        slug=payload.slug,
        name=payload.name,
        description=payload.description,
        parent_slug=payload.parent_slug,
        color=payload.color,
        virtual=False,
        sort_order=payload.sort_order,
    )
    db.add(ws)
    db.commit()
    db.refresh(ws)
    return ws


def _validate_parent_change(
    db: Session, ws: Workspace, new_parent_slug: Optional[str]
) -> None:
    """Validates a parent reassignment. Raises ValueError on:
      - self-parent
      - parent doesn't exist
      - parent is virtual
      - parent is a descendant of `ws` (would create a cycle)
    """
    if new_parent_slug is None:
        return  # promote to root — always safe
    if new_parent_slug == ws.slug:
        raise ValueError("자기 자신을 상위 부서로 지정할 수 없습니다.")
    parent = db.get(Workspace, new_parent_slug)
    if not parent:
        raise ValueError(f"상위 부서가 없습니다: {new_parent_slug}")
    if parent.virtual:
        raise ValueError("가상 부서 아래로 이동할 수 없습니다.")
    descendants = set(get_descendants_inclusive(db, ws.slug))
    if new_parent_slug in descendants:
        raise ValueError(
            "하위 부서 아래로 이동할 수 없습니다 (트리 순환이 발생합니다)."
        )


def update_workspace(db: Session, ws: Workspace, payload: WorkspaceUpdate) -> Workspace:
    fields_set = payload.model_fields_set
    data = payload.model_dump()

    # parent_slug treated specially because `null` is meaningful (= make root).
    # We only touch it if the field was explicitly sent.
    if "parent_slug" in fields_set:
        new_parent = data["parent_slug"]
        if new_parent != ws.parent_slug:
            _validate_parent_change(db, ws, new_parent)
            ws.parent_slug = new_parent

    for key in ("name", "description", "color", "sort_order"):
        if key in fields_set and data[key] is not None:
            setattr(ws, key, data[key])

    db.commit()
    db.refresh(ws)
    return ws


def workspace_blockers(db: Session, slug: str) -> dict:
    """Returns dependency counts that prevent deletion. All-zero = safe to drop."""
    children = (
        db.execute(
            select(func.count(Workspace.slug)).where(Workspace.parent_slug == slug)
        ).scalar()
        or 0
    )
    members = (
        db.execute(
            select(func.count(WorkspaceMember.id)).where(
                WorkspaceMember.workspace_slug == slug
            )
        ).scalar()
        or 0
    )
    reports = (
        db.execute(
            select(func.count(Report.id)).where(Report.workspace_slug == slug)
        ).scalar()
        or 0
    )
    templates = (
        db.execute(
            select(func.count(Template.template_id)).where(
                Template.owner_workspace_slug == slug
            )
        ).scalar()
        or 0
    )
    return {
        "children": int(children),
        "members": int(members),
        "reports": int(reports),
        "templates": int(templates),
    }


def delete_workspace(db: Session, ws: Workspace) -> None:
    blockers = workspace_blockers(db, ws.slug)
    if any(blockers.values()):
        parts = [f"{k}={v}" for k, v in blockers.items() if v]
        raise ValueError(
            f"부서를 삭제할 수 없습니다 (참조 중: {', '.join(parts)}). 먼저 정리하세요."
        )
    db.delete(ws)
    db.commit()
