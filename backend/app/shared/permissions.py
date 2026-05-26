"""Edit-permission resolution — single source of truth.

`can_edit()` is the function every write path consults. Before Phase 3
this logic was scattered as raw `report.owner_user_id == actor.user.id`
checks; the routes now call this instead so the policy lives in one
place.

Decision matrix (designed 2026-05-25, see 협업개선_설계.md §4.5):

  1. System admin    → always allowed (overrides lock too — operational
                       convenience, see decision #2)
  2. Hard lock       → veto for everyone except owner (and sys admin,
                       per #1)
  3. Owner           → allowed
  4. ReportEditor    → allowed, but lock still vetoes
  5. Per-mount walk  → 'owner_only' skipped; 'default' lets the
                       workspace lead edit IF the author is also a
                       member of that workspace (ancestor walk applies
                       on both sides); 'coauthor' lets any member of
                       the workspace edit (ancestor walk).

Caller passes a freshly-fetched `report` (no caching here — perms must
reflect the row at the time of the write).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.mounts.models import MountEditPolicy, ReportMount
from app.modules.editors.models import ReportEditor
from app.modules.reports.models import Report
from app.modules.users.models import Role, User
from app.shared.auth import _resolve_role


EditRole = Literal[
    "owner",
    "sys_admin",
    "editor",
    "lead",
    "coauthor",
    "locked",
    "none",
]


@dataclass
class EditDecision:
    """Why a user can or cannot edit. Routes can return the `role`
    to the client (`ReportRead.edit_role`) so the UI knows which
    affordances to show without re-implementing the rule."""

    allowed: bool
    role: EditRole
    # When the decision flows from a specific mount (lead/coauthor),
    # record which workspace it came from. ReportMount uses a composite
    # (report_id, workspace_slug) key — slug is the stable id here.
    via_workspace_slug: Optional[str] = None


def can_edit(db: Session, user: User, report: Report) -> EditDecision:
    # 1. System admin — bypasses lock (decision #2). Operational
    #    convenience: emergency content fixes don't require force-unset
    #    then grant-editor dance.
    if user.is_system_admin:
        return EditDecision(allowed=True, role="sys_admin")

    # 2. Hard lock vetoes everyone except owner.
    if report.author_lock_enabled and user.id != report.owner_user_id:
        return EditDecision(allowed=False, role="locked")

    # 3. Owner — always.
    if user.id == report.owner_user_id:
        return EditDecision(allowed=True, role="owner")

    # 4. Explicit editor grant.
    if _is_listed_editor(db, report_id=report.id, user_id=user.id):
        return EditDecision(allowed=True, role="editor")

    # 5. Per-mount evaluation. First match wins; most-permissive policy
    #    of any mount opens the gate (you can't tighten through one
    #    mount what another already opens).
    mounts = db.execute(
        select(ReportMount).where(ReportMount.report_id == report.id)
    ).scalars()
    for mount in mounts:
        if mount.edit_policy == MountEditPolicy.owner_only:
            continue
        # Lead path: user is admin of this workspace (ancestor walk),
        # AND the author is also a member of this workspace (ancestor
        # walk on the author side too — §4.2 "보직장" definition).
        user_role = _resolve_role(db, user.id, mount.workspace_slug)
        if user_role == Role.admin:
            author_role = _resolve_role(
                db, report.owner_user_id, mount.workspace_slug
            )
            if author_role is not None:
                return EditDecision(
                    allowed=True,
                    role="lead",
                    via_workspace_slug=mount.workspace_slug,
                )
        # Coauthor path: any member of the workspace (ancestor walk —
        # decision #1: parent membership counts as child membership).
        if mount.edit_policy == MountEditPolicy.coauthor:
            if user_role is not None:
                return EditDecision(
                    allowed=True,
                    role="coauthor",
                    via_workspace_slug=mount.workspace_slug,
                )

    return EditDecision(allowed=False, role="none")


def _is_listed_editor(db: Session, *, report_id: int, user_id: int) -> bool:
    row = db.execute(
        select(ReportEditor.user_id).where(
            ReportEditor.report_id == report_id,
            ReportEditor.user_id == user_id,
        )
    ).scalar_one_or_none()
    return row is not None
