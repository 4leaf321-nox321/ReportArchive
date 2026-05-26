"""Comment service layer — thread/comment CRUD + side effects.

Side effects fired here:
  - ReportActivity rows for every thread/comment/resolve event
  - ReportPhase auto-transition: first external comment bumps
    drafting → reviewing (also records phase activity + notification)
  - Notifications: comment.new/reply/resolved + report.phase_to_reviewing

Permission model (Phase 2A — kept simple, refined in Phase 3):
  - Read: anyone who can see the report (reports.is_visible_to)
  - Create thread / reply: same as read
  - Resolve / reopen: thread author OR report owner OR workspace admin
                      where the report is mounted
  - Edit / delete a single comment: only its author

The "author role snapshot" (admin/manager/member) is computed at
thread creation time from the actor's role at the *origin* workspace.
Lead/admin-authored threads carry the snapshot forever so the UI can
mark them as "보직장 의견" even if the role later changes.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.activities.models import ReportActivityType
from app.modules.activities.services import record_activity
from app.modules.comments.models import (
    AuthorRoleSnapshot,
    Comment,
    CommentThread,
    ThreadStatus,
)
from app.modules.mounts.models import ReportMount
from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.reports.models import Report, ReportPhase
from app.modules.users.models import Role, WorkspaceMember


# ──────────────────────────────────────────────────────────────────
# Errors
# ──────────────────────────────────────────────────────────────────


class CommentError(Exception):
    code = "comment_error"
    status_code = 400


class CommentNotFoundError(CommentError):
    code = "comment_not_found"
    status_code = 404


class ThreadNotFoundError(CommentError):
    code = "thread_not_found"
    status_code = 404


class CommentForbiddenError(CommentError):
    code = "comment_forbidden"
    status_code = 403


# ──────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────


def _role_snapshot(
    db: Session, *, actor_user_id: int, workspace_slug: Optional[str]
) -> AuthorRoleSnapshot:
    """Resolve the actor's role at the origin workspace at this moment,
    walking up the parent chain (mirrors _resolve_role in auth.py).
    Returns AuthorRoleSnapshot.admin if any admin membership found,
    manager → manager (display-only — currently no special mark), else
    member.
    """
    if not workspace_slug:
        return AuthorRoleSnapshot.member
    from app.modules.workspaces.models import Workspace

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
            if m.role == Role.manager:
                return AuthorRoleSnapshot.admin
            # manager/user都 → `member` for the visual snapshot. Only
            # admin gets the "보직장 의견" mark in Phase 2; manager
            # role granularity can be added later if needed.
            return AuthorRoleSnapshot.member
        ws = db.get(Workspace, cur)
        if ws is None:
            break
        cur = ws.parent_slug
    return AuthorRoleSnapshot.member


def _excerpt(body: dict, max_chars: int = 80) -> str:
    """Extract plain text from a tiptap doc for activity/notification
    previews. Walks `content`/`text` recursively — no formatting."""
    if not isinstance(body, dict):
        return ""
    parts: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            t = node.get("text")
            if isinstance(t, str):
                parts.append(t)
            for child in node.get("content", []) or []:
                walk(child)

    walk(body)
    text = " ".join(parts).strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _thread_participants(thread: CommentThread) -> set[int]:
    """All distinct user ids that have posted in the thread (author of
    thread + all comment authors)."""
    ids = {thread.author_user_id}
    for c in thread.comments or []:
        ids.add(c.author_user_id)
    return ids


def _can_resolve(
    db: Session, *, thread: CommentThread, report: Report, actor_user_id: int
) -> bool:
    """Resolve permission: thread author + report owner + any workspace
    admin on a board where the report is mounted."""
    if thread.author_user_id == actor_user_id:
        return True
    if report.owner_user_id == actor_user_id:
        return True
    # Workspace admin on any mount of this report.
    mounts = db.execute(
        select(ReportMount.workspace_slug).where(
            ReportMount.report_id == report.id
        )
    ).scalars()
    for ws_slug in mounts:
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == actor_user_id,
                WorkspaceMember.workspace_slug == ws_slug,
            )
        ).scalar_one_or_none()
        if m and m.role == Role.manager:
            return True
    return False


# ──────────────────────────────────────────────────────────────────
# Thread CRUD
# ──────────────────────────────────────────────────────────────────


def list_threads_for_report(
    db: Session, report_id: int
) -> list[CommentThread]:
    """All threads (with nested comments) for a report, ordered by
    creation time. Resolved threads are kept — the UI may collapse
    them but the data should remain queryable.

    Defensive filter: skip threads with zero comments. delete_comment
    cascades the thread away when it removes the last comment, but if
    any historical row slipped through (pre-cascade-fix era, or some
    future bulk delete path), we never surface them to the UI —
    otherwise the pin shows a "1" pointing at nothing.
    """
    rows = list(
        db.execute(
            select(CommentThread)
            .where(CommentThread.report_id == report_id)
            .order_by(CommentThread.created_at)
        ).scalars()
    )
    return [t for t in rows if t.comments]


def list_inbox_for_owner(
    db: Session,
    *,
    owner_user_id: int,
    status: Optional[ThreadStatus] = ThreadStatus.open,
    limit: int = 50,
    before_id: Optional[int] = None,
) -> tuple[list[dict], int]:
    """Personal-inbox feed — threads on reports that `owner_user_id`
    authored. Pure read; no side effects.

    Sort: thread.id DESC so newest threads come first and the cursor
    (`before_id`) collapses to "give me items with id < before_id".
    We chose thread.id over last_comment_at because (a) it's a single
    indexed column → cheap cursor; (b) thread creation order is also a
    reasonable "newest conversation" ordering for triage. "Most-recent-
    reply" ordering can come later as a separate sort option.

    `status=None` returns all (open + resolved); the default is `open`
    (the actionable subset). `open_count` is always computed against
    the same owner filter — gives the sidebar its badge number without
    a second roundtrip.
    """
    from app.modules.workspaces.models import Workspace

    base = (
        select(CommentThread)
        .join(Report, Report.id == CommentThread.report_id)
        .where(Report.owner_user_id == owner_user_id)
    )
    if status is not None:
        base = base.where(CommentThread.status == status)
    if before_id is not None:
        base = base.where(CommentThread.id < before_id)

    rows = list(
        db.execute(
            base.order_by(CommentThread.id.desc()).limit(limit)
        ).scalars()
    )

    # Resolve origin workspace names in one batched query — every row
    # may reference a different workspace, but the set is small (1 per
    # row at worst). Skips a per-row roundtrip during item building.
    origin_slugs = {
        t.origin_workspace_slug
        for t in rows
        if t.origin_workspace_slug
    }
    ws_name_by_slug: dict[str, str] = {}
    if origin_slugs:
        ws_rows = db.execute(
            select(Workspace.slug, Workspace.name).where(
                Workspace.slug.in_(origin_slugs)
            )
        ).all()
        ws_name_by_slug = {slug: name for slug, name in ws_rows}

    items: list[dict] = []
    for t in rows:
        # `comments` is eagerly loaded via lazy=selectin on the
        # CommentThread.comments relationship, so .comments is a list
        # already in memory — no per-row roundtrip.
        comments = list(t.comments or [])
        if not comments:
            # Mirror list_threads_for_report's defensive filter: an
            # empty-comment thread is data debt, not something the
            # inbox should surface as a "1 reply" pointing nowhere.
            continue
        last = comments[-1]
        last_author = None
        if last.author_user_id is not None:
            from app.modules.users.models import User

            u = db.get(User, last.author_user_id)
            if u is not None:
                last_author = {
                    "id": u.id,
                    "email": u.email,
                    "name": u.name,
                }
        report = db.get(Report, t.report_id)
        items.append(
            {
                "thread_id": t.id,
                "report_id": t.report_id,
                "report_title": report.title if report else "",
                "report_workspace_slug": (
                    report.workspace_slug if report else ""
                ),
                "origin_workspace_slug": t.origin_workspace_slug,
                "origin_workspace_name": (
                    ws_name_by_slug.get(t.origin_workspace_slug)
                    if t.origin_workspace_slug
                    else None
                ),
                "page_index": t.page_index,
                "block_id": t.block_id,
                "status": t.status,
                "author_role_at_creation": t.author_role_at_creation,
                "created_at": t.created_at,
                "last_comment_at": last.created_at,
                "last_comment_author": last_author,
                "last_comment_excerpt": _excerpt(last.body),
                "total_comments": len(comments),
            }
        )

    # Open-thread count for the sidebar badge — independent of
    # pagination. SQL COUNT keeps it O(index) rather than materializing
    # rows just to len() them.
    open_count = db.execute(
        select(func.count(CommentThread.id))
        .join(Report, Report.id == CommentThread.report_id)
        .where(
            Report.owner_user_id == owner_user_id,
            CommentThread.status == ThreadStatus.open,
        )
    ).scalar_one()
    return items, int(open_count or 0)


def create_thread(
    db: Session,
    *,
    report_id: int,
    page_index: int,
    block_id: str,
    body: dict,
    actor_user_id: int,
    origin_workspace_slug: Optional[str],
) -> CommentThread:
    report = db.get(Report, report_id)
    if report is None:
        raise CommentError(f"보고서를 찾을 수 없습니다: {report_id}")

    role_snap = _role_snapshot(
        db, actor_user_id=actor_user_id, workspace_slug=origin_workspace_slug
    )

    thread = CommentThread(
        report_id=report_id,
        page_index=page_index,
        block_id=block_id,
        origin_workspace_slug=origin_workspace_slug,
        author_user_id=actor_user_id,
        author_role_at_creation=role_snap,
        status=ThreadStatus.open,
    )
    db.add(thread)
    db.flush()

    # Initial comment (head post).
    head = Comment(
        thread_id=thread.id,
        author_user_id=actor_user_id,
        body=body,
    )
    db.add(head)
    db.flush()

    excerpt = _excerpt(body)

    # Side effect 1: activity log.
    record_activity(
        db,
        report_id=report_id,
        type=ReportActivityType.comment_added,
        actor_user_id=actor_user_id,
        payload={
            "thread_id": thread.id,
            "comment_id": head.id,
            "page_index": page_index,
            "block_id": block_id,
            "excerpt": excerpt,
        },
    )

    # Side effect 2: notify the report owner unless they posted it.
    if report.owner_user_id is not None and report.owner_user_id != actor_user_id:
        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor_user_id,
            type=NotificationType.comment_new,
            ref_table="comment_threads",
            ref_id=thread.id,
            workspace_slug=origin_workspace_slug,
            payload={
                "report_id": report_id,
                "report_title": report.title,
                "excerpt": excerpt,
            },
        )

    # Side effect 3: phase auto-transition on first EXTERNAL comment.
    # An author commenting on their own report is a memo, not a review
    # signal — so we skip the transition then.
    if (
        report.owner_user_id is not None
        and report.owner_user_id != actor_user_id
        and report.phase == ReportPhase.drafting
    ):
        report.phase = ReportPhase.reviewing
        record_activity(
            db,
            report_id=report_id,
            type=ReportActivityType.phase_to_reviewing,
            actor_user_id=actor_user_id,
            payload={"trigger": "comment", "thread_id": thread.id},
        )
        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor_user_id,
            type=NotificationType.report_phase_to_reviewing,
            ref_table="reports",
            ref_id=report_id,
            payload={
                "trigger": "comment",
                "report_title": report.title,
            },
        )

    return thread


def add_comment(
    db: Session,
    *,
    thread_id: int,
    body: dict,
    actor_user_id: int,
) -> Comment:
    thread = db.get(CommentThread, thread_id)
    if thread is None:
        raise ThreadNotFoundError(f"스레드를 찾을 수 없습니다: {thread_id}")
    report = db.get(Report, thread.report_id)
    if report is None:
        raise CommentError("보고서를 찾을 수 없습니다.")

    comment = Comment(
        thread_id=thread_id,
        author_user_id=actor_user_id,
        body=body,
    )
    db.add(comment)
    db.flush()

    excerpt = _excerpt(body)

    record_activity(
        db,
        report_id=thread.report_id,
        type=ReportActivityType.comment_replied,
        actor_user_id=actor_user_id,
        payload={
            "thread_id": thread.id,
            "comment_id": comment.id,
            "excerpt": excerpt,
        },
    )

    # Notify all participants of the thread EXCEPT the actor — they
    # know what they just wrote. Refresh `thread.comments` so the new
    # comment is reflected in the participant set.
    db.refresh(thread)
    recipients = _thread_participants(thread) | {report.owner_user_id or 0}
    recipients.discard(actor_user_id)
    recipients.discard(0)
    for uid in recipients:
        create_notification(
            db,
            recipient_user_id=uid,
            actor_user_id=actor_user_id,
            type=NotificationType.comment_reply,
            ref_table="comment_threads",
            ref_id=thread.id,
            workspace_slug=thread.origin_workspace_slug,
            payload={
                "report_id": thread.report_id,
                "report_title": report.title,
                "excerpt": excerpt,
            },
        )

    return comment


def set_thread_status(
    db: Session,
    *,
    thread_id: int,
    new_status: ThreadStatus,
    actor_user_id: int,
) -> CommentThread:
    thread = db.get(CommentThread, thread_id)
    if thread is None:
        raise ThreadNotFoundError(f"스레드를 찾을 수 없습니다: {thread_id}")
    report = db.get(Report, thread.report_id)
    if report is None:
        raise CommentError("보고서를 찾을 수 없습니다.")

    if thread.status == new_status:
        return thread  # idempotent no-op

    if not _can_resolve(
        db, thread=thread, report=report, actor_user_id=actor_user_id
    ):
        raise CommentForbiddenError(
            "스레드를 변경할 권한이 없습니다 (작성자·보고서 소유자·게시판 admin 만)."
        )

    from datetime import datetime as _dt

    thread.status = new_status
    if new_status == ThreadStatus.resolved:
        thread.resolved_at = _dt.utcnow()
        thread.resolved_by_user_id = actor_user_id
        activity_type = ReportActivityType.thread_resolved
        notif_type = NotificationType.comment_resolved
    else:
        thread.resolved_at = None
        thread.resolved_by_user_id = None
        activity_type = ReportActivityType.thread_reopened
        notif_type = None  # reopen 알림은 별도 type 없음; activity만

    record_activity(
        db,
        report_id=report.id,
        type=activity_type,
        actor_user_id=actor_user_id,
        payload={"thread_id": thread.id},
    )

    if notif_type is not None:
        recipients = _thread_participants(thread) | {report.owner_user_id or 0}
        recipients.discard(actor_user_id)
        recipients.discard(0)
        for uid in recipients:
            create_notification(
                db,
                recipient_user_id=uid,
                actor_user_id=actor_user_id,
                type=notif_type,
                ref_table="comment_threads",
                ref_id=thread.id,
                workspace_slug=thread.origin_workspace_slug,
                payload={
                    "report_id": report.id,
                    "report_title": report.title,
                },
            )

    db.flush()
    return thread


def update_comment(
    db: Session, *, comment_id: int, body: dict, actor_user_id: int
) -> Comment:
    comment = db.get(Comment, comment_id)
    if comment is None:
        raise CommentNotFoundError(f"코멘트를 찾을 수 없습니다: {comment_id}")
    if comment.author_user_id != actor_user_id:
        raise CommentForbiddenError("본인이 작성한 코멘트만 수정 가능합니다.")
    comment.body = body
    db.flush()
    return comment


def delete_comment(
    db: Session, *, comment_id: int, actor_user_id: int
) -> None:
    """Delete one comment. If it was the last remaining comment in its
    thread, the empty thread is cascaded away too — otherwise the
    widget pin would keep showing "1건" pointing at a content-less
    shell. The cleanup runs in the same transaction as the delete.
    """
    comment = db.get(Comment, comment_id)
    if comment is None:
        raise CommentNotFoundError(f"코멘트를 찾을 수 없습니다: {comment_id}")
    if comment.author_user_id != actor_user_id:
        raise CommentForbiddenError("본인이 작성한 코멘트만 삭제 가능합니다.")
    thread_id = comment.thread_id
    db.delete(comment)
    db.flush()
    # Check whether any comments remain in this thread; if not, drop
    # the thread row. select+exists pattern keeps it to one round trip.
    has_more = db.execute(
        select(Comment.id).where(Comment.thread_id == thread_id).limit(1)
    ).first()
    if has_more is None:
        thread = db.get(CommentThread, thread_id)
        if thread is not None:
            db.delete(thread)
            db.flush()
