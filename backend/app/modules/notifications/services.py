"""Notification service layer.

`create_notification` is the single producer entrypoint — called by
other modules' services on the events they emit. Self-notifications
(actor == recipient) are silently skipped: users don't need to be
told about their own actions.

Reads (`list_for_user`, `unread_count`, mark-read) are the inbox API.
"""
from __future__ import annotations

from datetime import datetime as _dt
from typing import Optional

from sqlalchemy import asc, delete, desc, func, select, update
from sqlalchemy.orm import Session

from app.modules.notifications.models import Notification, NotificationType


# Per-recipient rolling cap. Keeps inbox response sizes bounded and
# prevents one runaway noisy producer from filling the table forever.
# Eviction order: oldest read first, then oldest unread as last resort.
PER_USER_CAP = 1000


def create_notification(
    db: Session,
    *,
    recipient_user_id: int,
    type: NotificationType,
    ref_table: Optional[str] = None,
    ref_id: Optional[int] = None,
    workspace_slug: Optional[str] = None,
    actor_user_id: Optional[int] = None,
    payload: Optional[dict] = None,
) -> Optional[Notification]:
    """Insert a notification row. Skips when actor == recipient.
    Returns the row, or None if skipped. No commit (caller's
    transaction)."""
    if actor_user_id is not None and actor_user_id == recipient_user_id:
        return None

    row = Notification(
        recipient_user_id=recipient_user_id,
        actor_user_id=actor_user_id,
        type=type,
        ref_table=ref_table,
        ref_id=ref_id,
        workspace_slug=workspace_slug,
        payload=payload or {},
    )
    db.add(row)
    db.flush()
    _enforce_cap(db, user_id=recipient_user_id)
    return row


def _enforce_cap(db: Session, *, user_id: int) -> int:
    """Trim this user's notifications down to PER_USER_CAP rows.

    Called lazily on insert — no cron required. Evicts read rows first
    (oldest first), then falls back to oldest unread if the user has
    so much UNREAD backlog that read-eviction alone can't get under
    the cap (degenerate case for users who never open the inbox).

    Returns the number of rows actually deleted (usually 0 — the cap
    only triggers once you accumulate >1000)."""
    total = db.execute(
        select(func.count(Notification.id)).where(
            Notification.recipient_user_id == user_id
        )
    ).scalar() or 0
    overflow = int(total) - PER_USER_CAP
    if overflow <= 0:
        return 0

    deleted = 0
    # Pass 1: oldest READ first.
    ids_to_drop = list(
        db.execute(
            select(Notification.id)
            .where(
                Notification.recipient_user_id == user_id,
                Notification.read_at.is_not(None),
            )
            .order_by(asc(Notification.id))
            .limit(overflow)
        ).scalars()
    )
    if ids_to_drop:
        res = db.execute(
            delete(Notification).where(Notification.id.in_(ids_to_drop))
        )
        deleted += res.rowcount or 0

    # Pass 2: still over? Evict oldest UNREAD. Last resort.
    overflow_remaining = overflow - deleted
    if overflow_remaining > 0:
        ids_to_drop = list(
            db.execute(
                select(Notification.id)
                .where(Notification.recipient_user_id == user_id)
                .order_by(asc(Notification.id))
                .limit(overflow_remaining)
            ).scalars()
        )
        if ids_to_drop:
            res = db.execute(
                delete(Notification).where(Notification.id.in_(ids_to_drop))
            )
            deleted += res.rowcount or 0

    if deleted:
        db.flush()
    return deleted


def list_for_user(
    db: Session,
    *,
    user_id: int,
    unread_only: bool = False,
    limit: int = 50,
    before_id: Optional[int] = None,
) -> list[Notification]:
    query = select(Notification).where(Notification.recipient_user_id == user_id)
    if unread_only:
        query = query.where(Notification.read_at.is_(None))
    if before_id is not None:
        query = query.where(Notification.id < before_id)
    query = query.order_by(desc(Notification.id)).limit(min(limit, 200))
    return list(db.execute(query).scalars())


def unread_count(db: Session, *, user_id: int) -> int:
    n = db.execute(
        select(func.count(Notification.id)).where(
            Notification.recipient_user_id == user_id,
            Notification.read_at.is_(None),
        )
    ).scalar()
    return int(n or 0)


def mark_read(db: Session, *, notification_id: int, user_id: int) -> bool:
    """Returns True if a row was marked. False if not found / not
    owned by this user (defensive — backend never trusts the URL id)."""
    row = db.get(Notification, notification_id)
    if row is None or row.recipient_user_id != user_id:
        return False
    if row.read_at is None:
        row.read_at = _dt.utcnow()
        db.flush()
    return True


def mark_all_read(db: Session, *, user_id: int) -> int:
    """Bulk mark every unread notification of this user as read.
    Returns the count of rows updated."""
    res = db.execute(
        update(Notification)
        .where(
            Notification.recipient_user_id == user_id,
            Notification.read_at.is_(None),
        )
        .values(read_at=_dt.utcnow())
    )
    db.flush()
    return res.rowcount or 0


def delete_one(db: Session, *, notification_id: int, user_id: int) -> bool:
    """Delete a single notification owned by this user.

    Defensive: checks recipient_user_id even though the URL carries
    the id — never trust client-supplied ids."""
    row = db.get(Notification, notification_id)
    if row is None or row.recipient_user_id != user_id:
        return False
    db.delete(row)
    db.flush()
    return True


def delete_all_read(db: Session, *, user_id: int) -> int:
    """Bulk delete every read notification of this user.

    Unread notifications are preserved — if a user wants to clear
    everything, they can mark-all-read first then call this."""
    res = db.execute(
        delete(Notification).where(
            Notification.recipient_user_id == user_id,
            Notification.read_at.is_not(None),
        )
    )
    db.flush()
    return res.rowcount or 0
