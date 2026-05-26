"""Mount service layer — promote/demote reports across org boards.

The two key actions:

  * `mount_report(report_id, workspace_slugs, by_user)` — create
    ReportMount rows for one or more org boards. Side-effects:
      - emits `mount.new_to_me` to the report owner (if mounter != owner)
      - emits `mount.new_in_board` to each board's members
      - bumps the report's phase drafting → reviewing if this is the
        first time the report became publicly visible (any mount exists)

  * `unmount_report(report_id, workspace_slug, by_user)` — delete one
    ReportMount row. Removes visibility from that board. Idempotent
    (no error if the mount is already gone). Does NOT touch phase —
    going back to all-personal is treated as an editorial decision,
    not a regression of the review state.

Permission gates live here, not in the route layer, so the same checks
apply to service-internal callers (e.g. a future "auto-mount via
composite include" flow).
"""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.folders.models import Folder, FolderKind
from app.modules.mounts.models import MountEditPolicy, ReportMount
from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.reports.models import Report, ReportPhase
from app.modules.users.models import Role, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind


class MountError(Exception):
    """Base class so the route layer can translate to 4xx easily."""

    code = "mount_error"
    status_code = 400


class MountForbiddenError(MountError):
    code = "mount_forbidden"
    status_code = 403


class MountTargetInvalidError(MountError):
    code = "mount_target_invalid"
    status_code = 400


def _ensure_can_mount(
    db: Session, report: Report, actor_user_id: int
) -> None:
    """Phase 1 rule: only the report owner can mount their own reports.

    Phase 3 will extend this to allow workspace admins to mount on
    behalf of users (the "팀장이 부하 보고서를 게시판에 올림" flow),
    but for now we keep it tight — the simplest defensible model.
    """
    if report.owner_user_id is None:
        # Orphan reports have no owner to authorize — admin-only flow
        # will land in Phase 3.
        raise MountForbiddenError(
            "owner가 없는 보고서는 현재 게시할 수 없습니다 (관리자 도구 필요)."
        )
    if report.owner_user_id != actor_user_id:
        raise MountForbiddenError(
            "본인이 작성한 보고서만 조직 게시판에 게시할 수 있습니다."
        )


def _ensure_target_is_org_workspace(
    db: Session, workspace_slug: str, actor_user_id: int
) -> Workspace:
    """The target board must (a) exist, (b) be an org workspace —
    mounting to personal/virtual is meaningless — and (c) be one the
    actor has access to.

    Access matches the auth layer's `_resolve_role` semantics: walk up
    the parent chain from the target, and accept any membership found
    along the way. So a user with membership at a parent (e.g. 본부)
    can publish to any descendant team without separate memberships.
    """
    ws = db.get(Workspace, workspace_slug)
    if ws is None:
        raise MountTargetInvalidError(
            f"게시 대상 워크스페이스를 찾을 수 없습니다: {workspace_slug}"
        )
    if ws.kind != WorkspaceKind.org:
        raise MountTargetInvalidError(
            f"조직 워크스페이스에만 게시할 수 있습니다 (kind={ws.kind.value})."
        )
    # Ancestor walk — mirror _resolve_role(auth.py).
    visited: set[str] = set()
    cur: Optional[str] = workspace_slug
    while cur and cur not in visited:
        visited.add(cur)
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == actor_user_id,
                WorkspaceMember.workspace_slug == cur,
            )
        ).scalar_one_or_none()
        if m is not None:
            return ws
        anc = db.get(Workspace, cur)
        if anc is None:
            break
        cur = anc.parent_slug
    raise MountForbiddenError(
        f"접근 권한이 없는 워크스페이스에는 게시할 수 없습니다: {workspace_slug}"
    )


def _board_lead_user_id(db: Session, workspace_slug: str) -> Optional[int]:
    """Returns the user_id with the highest role on this workspace
    (admin > manager > user). Used for 'mount.new_in_board' targeting.

    For Phase 1 we only notify a single board lead per mount to keep
    inboxes quiet; broadcasting to every board member can land later
    behind a per-workspace notification policy.
    """
    rows = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_slug == workspace_slug
        )
    ).scalars().all()
    if not rows:
        return None
    priority = {Role.admin: 0, Role.manager: 1, Role.user: 2}
    rows.sort(key=lambda m: priority.get(m.role, 99))
    return rows[0].user_id


def list_mounts_for_report(db: Session, report_id: int) -> list[ReportMount]:
    return list(
        db.execute(
            select(ReportMount)
            .where(ReportMount.report_id == report_id)
            .order_by(ReportMount.mounted_at)
        ).scalars()
    )


def _validate_folder_for_workspace(
    db: Session, folder_id: int, workspace_slug: str
) -> None:
    """Ensure the folder id is an org folder of the right workspace.
    Personal folders or other-workspace folders aren't a valid mount
    placement target."""
    folder = db.get(Folder, folder_id)
    if folder is None:
        raise MountTargetInvalidError(f"폴더를 찾을 수 없습니다: {folder_id}")
    if folder.kind != FolderKind.org or folder.workspace_slug != workspace_slug:
        raise MountTargetInvalidError(
            f"{workspace_slug} 게시판의 폴더만 선택할 수 있습니다."
        )


def mount_report(
    db: Session,
    *,
    report_id: int,
    workspace_slugs: Iterable[str],
    actor_user_id: int,
    edit_policy: MountEditPolicy = MountEditPolicy.default,
    note: str = "",
    folder_id: Optional[int] = None,
) -> list[ReportMount]:
    """Promote a report to one or more org boards. Idempotent per-board
    (an existing mount stays and its edit_policy/note are NOT updated
    — use a dedicated PATCH endpoint for that in Phase 3).

    Returns only newly-created mount rows. Notifications are emitted
    for new rows only — re-mounting an already-mounted report does not
    re-notify.
    """
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")
    _ensure_can_mount(db, report, actor_user_id)

    # Pre-load existing mounts so the dedupe is one query, not N.
    existing = {
        m.workspace_slug: m
        for m in db.execute(
            select(ReportMount).where(ReportMount.report_id == report_id)
        ).scalars()
    }
    had_any_mount_before = len(existing) > 0

    created: list[ReportMount] = []
    for slug in workspace_slugs:
        if slug in existing:
            continue  # idempotent skip
        _ensure_target_is_org_workspace(db, slug, actor_user_id)
        # Validate folder is in this workspace (skip if no folder picked
        # — defaults to 미분류). One folder_id is applied to every new
        # mount; per-board variation requires separate POST calls.
        if folder_id is not None:
            _validate_folder_for_workspace(db, folder_id, slug)
        row = ReportMount(
            report_id=report_id,
            workspace_slug=slug,
            edit_policy=edit_policy,
            mounted_by_user_id=actor_user_id,
            note=note,
            folder_id=folder_id,
        )
        db.add(row)
        created.append(row)
    db.flush()

    # Notify the report owner that their report just got mounted (only
    # if someone else mounted it; self-mount is implicit).
    for row in created:
        if report.owner_user_id is not None and report.owner_user_id != actor_user_id:
            create_notification(
                db,
                recipient_user_id=report.owner_user_id,
                actor_user_id=actor_user_id,
                type=NotificationType.mount_new_to_me,
                ref_table="reports",
                ref_id=report_id,
                workspace_slug=row.workspace_slug,
                payload={"report_title": report.title},
            )
        # Notify the board lead so they see "new report on my board".
        lead_id = _board_lead_user_id(db, row.workspace_slug)
        if lead_id is not None:
            create_notification(
                db,
                recipient_user_id=lead_id,
                actor_user_id=actor_user_id,
                type=NotificationType.mount_new_in_board,
                ref_table="reports",
                ref_id=report_id,
                workspace_slug=row.workspace_slug,
                payload={"report_title": report.title},
            )

    # Phase auto-transition: the first time a report becomes publicly
    # visible (had no mounts → now has at least one), bump
    # drafting → reviewing. Matches §8.3 spec. Re-mounts after unmount
    # also trigger this if the report had returned to drafting.
    if not had_any_mount_before and created and report.phase == ReportPhase.drafting:
        report.phase = ReportPhase.reviewing
        if report.owner_user_id is not None:
            create_notification(
                db,
                recipient_user_id=report.owner_user_id,
                actor_user_id=actor_user_id,
                type=NotificationType.report_phase_to_reviewing,
                ref_table="reports",
                ref_id=report_id,
                payload={"trigger": "mount", "report_title": report.title},
            )

    return created


def set_mount_folder(
    db: Session,
    *,
    report_id: int,
    workspace_slug: str,
    folder_id: Optional[int],
    actor_user_id: int,
) -> ReportMount:
    """Metadata-only — move an existing mount between org folders (or
    to 미분류 with folder_id=None). Permission: report owner OR the
    mounter OR a workspace admin/manager on that board. Workspace
    members aren't allowed to reorganize someone else's report.
    """
    row = db.get(ReportMount, (report_id, workspace_slug))
    if row is None:
        raise MountTargetInvalidError(
            f"게시 정보를 찾을 수 없습니다: report={report_id} board={workspace_slug}"
        )
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")

    is_owner = report.owner_user_id == actor_user_id
    is_mounter = row.mounted_by_user_id == actor_user_id
    is_board_admin = False
    if not (is_owner or is_mounter):
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == actor_user_id,
                WorkspaceMember.workspace_slug == workspace_slug,
            )
        ).scalar_one_or_none()
        is_board_admin = m is not None and m.role in (
            Role.admin,
            Role.manager,
        )
    if not (is_owner or is_mounter or is_board_admin):
        raise MountForbiddenError(
            "이 보고서의 폴더 위치를 변경할 권한이 없습니다."
        )

    if folder_id is not None:
        _validate_folder_for_workspace(db, folder_id, workspace_slug)
    row.folder_id = folder_id
    db.flush()
    return row


def set_mount_edit_policy(
    db: Session,
    *,
    report_id: int,
    workspace_slug: str,
    edit_policy: MountEditPolicy,
    actor_user_id: int,
) -> ReportMount:
    """Change the per-board edit policy. Phase 3.

    Owner-only — letting a board admin tighten a policy on someone
    else's report would be confusing ("내 보고서인데 왜 owner_only 가
    풀려있지?"). Folder placement was different because it's an
    organizational concern; policy is an author concern.
    """
    row = db.get(ReportMount, (report_id, workspace_slug))
    if row is None:
        raise MountTargetInvalidError(
            f"게시 정보를 찾을 수 없습니다: report={report_id} board={workspace_slug}"
        )
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")
    if report.owner_user_id != actor_user_id:
        raise MountForbiddenError(
            "편집 정책 변경은 작성자만 가능합니다."
        )
    row.edit_policy = edit_policy
    db.flush()
    return row


def unmount_report(
    db: Session,
    *,
    report_id: int,
    workspace_slug: str,
    actor_user_id: int,
) -> bool:
    """Remove one mount. Idempotent — missing row returns False instead
    of erroring. Permission: report owner OR workspace admin on the
    board may unmount.

    Returns True if a row was deleted, False if it didn't exist.
    """
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")

    is_owner = report.owner_user_id == actor_user_id
    is_board_admin = False
    if not is_owner:
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == actor_user_id,
                WorkspaceMember.workspace_slug == workspace_slug,
            )
        ).scalar_one_or_none()
        is_board_admin = m is not None and m.role == Role.admin
    if not (is_owner or is_board_admin):
        raise MountForbiddenError(
            "본인 보고서를 게시 해제하거나 해당 게시판 관리자만 가능합니다."
        )

    row = db.get(ReportMount, (report_id, workspace_slug))
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True
