"""Report routes — CRUD scoped to the actor's workspace tree."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.reports import services
from app.modules.reports.schemas import (
    LockInfo,
    ReportCreate,
    ReportRead,
    ReportSummary,
    ReportUpdate,
)
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)

router = APIRouter()


def _read_with_perms(db: Session, actor: CurrentUser, report) -> ReportRead:
    """Build a ReportRead and stamp the per-actor edit decision.

    Used by detail/update/publish/unpublish/lock returns so the frontend
    can disable edit affordances without re-implementing the rule.
    List endpoints skip this — per-row resolution is too expensive and
    the list page falls back to optimistic show + 403 on save."""
    from app.shared.permissions import can_edit

    obj = ReportRead.model_validate(report)
    decision = can_edit(db, actor.user, report)
    obj.can_edit = decision.allowed
    obj.edit_role = decision.role
    return obj


def _lock_conflict_response(exc: services.LockError):
    """Translate a service-layer LockError into a 409 in the standard
    {success, message, errors} envelope. `errors[0]` carries a stable
    `code` string the frontend dispatches on; `holder` (when known) lets
    the takeover dialog render '현재 OO 편집 중' without a re-fetch.
    """
    detail: dict = {"code": exc.code, "message": str(exc)}
    if exc.holder is not None:
        detail["holder"] = LockInfo.model_validate({
            "user_id": exc.holder.user_id,
            "user_name": getattr(exc.holder.user, "name", None),
            "user_email": getattr(exc.holder.user, "email", None),
            "acquired_at": exc.holder.acquired_at,
            "expires_at": exc.holder.expires_at,
        }).model_dump(mode="json")
    return error_response(str(exc), errors=[detail], status_code=409)


@router.get("")
def list_reports(
    entity_ids: list[int] | None = Query(default=None, alias="entity_ids"),
    folder_id: str | None = Query(
        default=None,
        description=(
            "Personal-space folder filter. Pass an integer id to show "
            "only that folder's reports, or 'uncategorized' for "
            "folder_id IS NULL. Ignored on org workspaces."
        ),
    ),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """List reports in the actor's workspace tree.

    Optional `entity_ids` (repeated) applies the N-axis tag filter:
    OR within an axis, AND across axes. Sent by the list-page filter
    bar; absent for the default unfiltered view.

    `folder_id` is meaningful only in personal-workspace context; the
    backend currently ignores it on org workspaces because folders are
    a per-user concept (Phase 4 may extend cross-workspace folders).
    """
    # Translate the folder filter — string-typed at the API edge so we
    # can carry the special "uncategorized" sentinel without overloading
    # integer semantics. Defensive: silently drop garbage.
    folder_filter: int | str | None = None
    if folder_id == "uncategorized":
        folder_filter = "uncategorized"
    elif folder_id is not None:
        try:
            folder_filter = int(folder_id)
        except ValueError:
            folder_filter = None
    reports = services.list_reports_in_workspace(
        db,
        actor.workspace.slug,
        is_global_view=actor.workspace.virtual,
        entity_ids=entity_ids,
        folder_filter=folder_filter,
    )
    payload = [ReportSummary.model_validate(r) for r in reports]
    return success_response(data=payload)


@router.get("/{report_id}")
def get_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("")
def create_report(
    payload: ReportCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Cannot create report in a virtual workspace; switch to a real workspace.",
        )
    # Phase 1: every new report is born in the creator's personal
    # workspace, regardless of which workspace they're currently
    # browsing. Promotion to org boards is a deliberate "게시" action
    # afterwards. This is the structural enforcement of the "개인
    # 작업공간과 조직 게시판 분리" decision (협업개선_설계.md §2).
    target_workspace = f"personal-{actor.user.id}"
    try:
        report = services.create_report(
            db, target_workspace, payload, owner_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=_read_with_perms(db, actor, report))


@router.put("/{report_id}/author-lock")
def set_author_lock(
    report_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Toggle the author lock. Body: {enabled: bool, reason?: str}.

    Permission: report owner OR system admin (force unset). System
    admins can override the lock to unblock a stuck workflow when the
    author is unavailable — that path emits a separate
    `report.lock_force_unset` notification to the owner so they know.
    """
    from datetime import datetime as _dt
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification
    from app.modules.mounts.models import ReportMount
    from app.modules.users.models import WorkspaceMember, Role
    from sqlalchemy import select

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")

    enabled = bool(payload.get("enabled"))
    reason = (payload.get("reason") or "").strip()
    is_owner = report.owner_user_id == actor.user.id
    is_system_admin = actor.user.is_system_admin
    is_force_unset = (not enabled) and not is_owner and is_system_admin

    if not is_owner and not is_force_unset:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "작성자만 잠금/해제 가능합니다 (또는 시스템 관리자의 강제 해제).",
        )

    report.author_lock_enabled = enabled
    if enabled:
        report.author_lock_reason = reason
        report.author_lock_set_at = _dt.utcnow()
    else:
        report.author_lock_reason = ""
        report.author_lock_set_at = None

    record_activity(
        db,
        report_id=report.id,
        type=(
            ReportActivityType.lock_force_unset if is_force_unset
            else ReportActivityType.locked if enabled
            else ReportActivityType.unlocked
        ),
        actor_user_id=actor.user.id,
        payload={"reason": reason} if enabled else {},
    )

    # Notify on lock — every board lead the report is mounted to should
    # know so they don't try editing and hit a wall.
    if enabled:
        mount_slugs = list(
            db.execute(
                select(ReportMount.workspace_slug).where(
                    ReportMount.report_id == report.id
                )
            ).scalars()
        )
        notified: set[int] = set()
        for slug in mount_slugs:
            leads = db.execute(
                select(WorkspaceMember.user_id).where(
                    WorkspaceMember.workspace_slug == slug,
                    WorkspaceMember.role == Role.manager,
                )
            ).scalars()
            for uid in leads:
                if uid in notified or uid == actor.user.id:
                    continue
                notified.add(uid)
                create_notification(
                    db,
                    recipient_user_id=uid,
                    actor_user_id=actor.user.id,
                    type=NotificationType.report_locked,
                    ref_table="reports",
                    ref_id=report.id,
                    workspace_slug=slug,
                    payload={
                        "report_title": report.title,
                        "reason": reason,
                    },
                )
    # Force-unset path notifies the owner about the override.
    if is_force_unset and report.owner_user_id is not None:
        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor.user.id,
            type=NotificationType.report_lock_force_unset,
            ref_table="reports",
            ref_id=report.id,
            payload={"report_title": report.title},
        )

    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("/{report_id}/publish")
def publish_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Owner-only: bump phase → finalized. Editing is gated downstream
    based on phase (finalized = read-only at the frontend layer; the
    backend update path will reject in Phase 2C alongside author lock).

    Recording: activity row + notification to mounted-board members are
    fired here. Idempotent — already-finalized just returns the current
    state.
    """
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification
    from app.modules.reports.models import ReportPhase
    from app.modules.mounts.models import ReportMount
    from app.modules.users.models import WorkspaceMember
    from sqlalchemy import select

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "발행은 작성자만 가능합니다."
        )
    if report.phase == ReportPhase.finalized:
        return success_response(data=_read_with_perms(db, actor, report))

    previous = report.phase
    report.phase = ReportPhase.finalized
    record_activity(
        db,
        report_id=report.id,
        type=ReportActivityType.phase_to_finalized,
        actor_user_id=actor.user.id,
        payload={"previous_phase": previous.value},
    )
    # Notify all members of every workspace this report is mounted to.
    mount_slugs = [
        m for m in db.execute(
            select(ReportMount.workspace_slug).where(
                ReportMount.report_id == report.id
            )
        ).scalars()
    ]
    notified: set[int] = set()
    for slug in mount_slugs:
        members = db.execute(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_slug == slug
            )
        ).scalars()
        for uid in members:
            if uid in notified or uid == actor.user.id:
                continue
            notified.add(uid)
            create_notification(
                db,
                recipient_user_id=uid,
                actor_user_id=actor.user.id,
                type=NotificationType.report_phase_to_finalized,
                ref_table="reports",
                ref_id=report.id,
                workspace_slug=slug,
                payload={"report_title": report.title},
            )
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("/{report_id}/unpublish")
def unpublish_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Owner-only: finalized → drafting. Lets the owner make changes
    after publishing. (Sets to drafting, not reviewing — re-publishing
    is a deliberate re-trigger.)
    """
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.reports.models import ReportPhase

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "발행 취소는 작성자만 가능합니다."
        )
    if report.phase != ReportPhase.finalized:
        return success_response(data=_read_with_perms(db, actor, report))

    report.phase = ReportPhase.drafting
    record_activity(
        db,
        report_id=report.id,
        type=ReportActivityType.phase_to_drafting,
        actor_user_id=actor.user.id,
        payload={"trigger": "unpublish"},
    )
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.put("/{report_id}/folder")
def move_report_to_folder(
    report_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Metadata-only assignment of a report to a personal folder.

    Separate from the main PATCH /reports/{id} because (a) it doesn't
    touch content/structure (no lock needed), (b) only the report owner
    can move their own report (folders are per-user), and (c) the UI
    needs a one-shot endpoint that doesn't require the optimistic
    revision dance — folder placement is independent of content
    revisions.

    Body: { "folder_id": int | null }  (null = uncategorized)
    """
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "본인 보고서만 폴더 이동할 수 있습니다.",
        )
    folder_id = payload.get("folder_id")
    if folder_id is not None and not isinstance(folder_id, int):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "folder_id must be int or null"
        )
    # If a folder id is given, sanity-check it belongs to the report's
    # owner (not just the actor — for sys admin moving another user's
    # report). Without this, forging a folder id could park a report
    # under someone else's folder.
    if folder_id is not None:
        from app.modules.folders.models import Folder

        folder = db.get(Folder, folder_id)
        expected_owner = report.owner_user_id
        if folder is None or folder.user_id != expected_owner:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"폴더를 찾을 수 없거나 권한이 없습니다: {folder_id}",
            )
    report.folder_id = folder_id
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.patch("/{report_id}")
def update_report(
    report_id: int,
    payload: ReportUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    # Phase 3 — single can_edit() check. Subsumes the Phase 2 hard-lock
    # veto (decision_role='locked') and adds boss/coauthor/editor paths.
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        if decision.role == "locked":
            reason = report.author_lock_reason or "사유 미기재"
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"작성자가 수정 잠금 상태입니다 (사유: {reason}). 잠금 해제 후 다시 시도하세요.",
            )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없습니다.",
        )
    # Phase 2B — finalized reports are read-only. Author must unpublish
    # (POST /reports/{id}/unpublish) to make changes.
    from app.modules.reports.models import ReportPhase

    if report.phase == ReportPhase.finalized:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "발행된 보고서는 편집할 수 없습니다. '발행 취소' 후 수정하세요.",
        )
    try:
        report = services.update_report(
            db,
            report,
            payload,
            updated_by_user_id=actor.user.id,
            expected_revision=payload.expected_revision,
        )
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    # Phase 3 — notify owner when a non-owner edits. Decision #4: no
    # debounce. Activity log already has the full sequence; the inbox
    # just gets one row per save (user can mass-clear).
    if (
        report.owner_user_id is not None
        and report.owner_user_id != actor.user.id
    ):
        from app.modules.notifications.models import NotificationType
        from app.modules.notifications.services import create_notification

        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor.user.id,
            type=NotificationType.report_edited_by_other,
            ref_table="reports",
            ref_id=report.id,
            payload={
                "report_title": report.title,
                "editor_role": decision.role,
            },
        )
        db.commit()

    return success_response(data=_read_with_perms(db, actor, report))


# --------------------------------------------------------------------------- #
# Edit lock endpoints                                                         #
# --------------------------------------------------------------------------- #


def _resolve_writable_report(
    db: Session, report_id: int, actor: CurrentUser
):
    """Shared guard for the three lock endpoints. Returns the report or
    raises the standard 404/403. Kept inline (not a Depends) because all
    three handlers need to surface the report object itself."""
    report = services.get_report(db, report_id)
    if not report:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"Report not found: {report_id}"
        )
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return report


@router.post("/{report_id}/lock")
def acquire_lock(
    report_id: int,
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Claim or refresh the edit lock. Pass `?force=true` to override an
    existing live lock (the previous holder will fail their next heartbeat
    / save and be bounced back to view mode)."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.acquire_lock(db, report, actor.user.id, force=force)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    db.refresh(report)
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.post("/{report_id}/lock/heartbeat")
def heartbeat_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Extend the caller's lock TTL. Returns 409 if the caller doesn't hold
    a live lock — the frontend treats that as "you got bumped" and exits
    edit mode."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.heartbeat_lock(db, report, actor.user.id)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.delete("/{report_id}/lock")
def release_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Drop the lock. Idempotent — releases for non-holders or already-
    expired locks return 200 with a no-op so the frontend can fire-and-
    forget from beforeunload handlers."""
    report = _resolve_writable_report(db, report_id, actor)
    services.release_lock(db, report, actor.user.id)
    db.commit()
    return success_response(data=None, message="Released")


@router.delete("/{report_id}")
def delete_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    services.delete_report(db, report)
    return success_response(data=None, message="Deleted")
