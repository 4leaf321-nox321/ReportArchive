"""Edit-permission resolution — single source of truth.

`can_edit()` is the function every write path consults.

Decision matrix (공유/권한 체계 개편):

  1. System admin → always allowed (overrides lock too — operational
     convenience).
  2. Hard lock    → veto for everyone except owner (and sys admin, per #1).
  3. Owner        → allowed.
  4. user edit grant (content_grant principal=user, level=edit) → allowed.
  5. workspace edit grant **하위 도달** (사용자가 granted 부서 또는 그 하위
     부서의 멤버) → allowed. ⚠️ 상위 멤버는 통과 못 함(상위 누수 방지) —
     grants/services.reachable_workspace_edit 이 `소속 ∩ descendants(X)` 로 판정.

폐기: 기존 per-mount MountEditPolicy(default/owner_only/coauthor)와 보직장(lead)
자동 편집. coauthor 는 workspace edit grant 로, 추가편집자는 user edit grant 로
흡수됨(p24 백필). 매니저도 편집하려면 명시 공유 필요.

Caller passes a freshly-fetched `report`/composite (no caching — perms must
reflect the row at the time of the write).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

from sqlalchemy.orm import Session

from app.modules.grants import services as grant_services
from app.modules.grants.models import GrantContentType, GrantLevel
from app.modules.reports.models import Report
from app.modules.users.models import User


EditRole = Literal[
    "owner",
    "sys_admin",
    "editor",
    "coauthor",
    "locked",
    "none",
]


@dataclass
class EditDecision:
    """Why a user can or cannot edit. Routes return `role` to the client
    (`ReportRead.edit_role`) so the UI shows the right affordances."""

    allowed: bool
    role: EditRole
    via_workspace_slug: Optional[str] = None


def can_edit(db: Session, user: User, report: Report) -> EditDecision:
    # 1. System admin — bypasses lock.
    if user.is_system_admin:
        return EditDecision(allowed=True, role="sys_admin")

    # 2. Hard lock vetoes everyone except owner.
    if report.author_lock_enabled and user.id != report.owner_user_id:
        return EditDecision(allowed=False, role="locked")

    # 3. Owner — always.
    if user.id == report.owner_user_id:
        return EditDecision(allowed=True, role="owner")

    # 4. user edit grant (구 추가편집자).
    if grant_services.has_user_grant(
        db, GrantContentType.report, report.id, user.id, level=GrantLevel.edit
    ):
        return EditDecision(allowed=True, role="editor")

    # 5. workspace edit grant — 하위 도달(구 coauthor mount).
    if grant_services.reachable_workspace_edit(
        db, GrantContentType.report, report.id, user.id
    ):
        return EditDecision(allowed=True, role="coauthor")

    return EditDecision(allowed=False, role="none")
