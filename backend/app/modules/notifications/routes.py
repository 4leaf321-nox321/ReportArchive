"""Notification inbox routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.notifications import models as _models  # noqa: F401
from app.modules.notifications import services
from app.modules.notifications.schemas import (
    NotificationActor,
    NotificationListResponse,
    NotificationRead,
    UnreadCountResponse,
)
from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace
from app.shared.responses import success_response


router = APIRouter()


def _to_read(db: Session, row) -> NotificationRead:
    actor = None
    if row.actor_user_id is not None:
        u = db.get(User, row.actor_user_id)
        if u is not None:
            actor = NotificationActor.model_validate(u)
    return NotificationRead(
        id=row.id,
        recipient_user_id=row.recipient_user_id,
        actor=actor,
        type=row.type,
        ref_table=row.ref_table,
        ref_id=row.ref_id,
        workspace_slug=row.workspace_slug,
        payload=row.payload,
        created_at=row.created_at,
        read_at=row.read_at,
    )


@router.get("")
def list_my_notifications(
    unread_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    before_id: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    rows = services.list_for_user(
        db,
        user_id=actor.id,
        unread_only=unread_only,
        limit=limit,
        before_id=before_id,
    )
    unread = services.unread_count(db, user_id=actor.id)
    payload = NotificationListResponse(
        items=[_to_read(db, r) for r in rows],
        unread_count=unread,
    )
    return success_response(data=payload.model_dump(mode="json"))


@router.get("/unread-count")
def get_unread_count(
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    return success_response(
        data=UnreadCountResponse(
            unread_count=services.unread_count(db, user_id=actor.id)
        ).model_dump(mode="json")
    )


@router.patch("/{notification_id}/read")
def mark_one_read(
    notification_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    services.mark_read(db, notification_id=notification_id, user_id=actor.id)
    db.commit()
    return success_response(data={"id": notification_id})


@router.post("/mark-all-read")
def mark_all_my_read(
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    count = services.mark_all_read(db, user_id=actor.id)
    db.commit()
    return success_response(data={"count": count})


@router.delete("/read")
def delete_my_read_notifications(
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """Bulk delete every read notification of the current user.

    Path is `/read` rather than `/all` to make the destructive scope
    explicit — unread items are preserved."""
    count = services.delete_all_read(db, user_id=actor.id)
    db.commit()
    return success_response(data={"deleted": count})


@router.delete("/{notification_id}")
def delete_one_notification(
    notification_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    ok = services.delete_one(
        db, notification_id=notification_id, user_id=actor.id
    )
    if not ok:
        # 404 covers both "doesn't exist" and "belongs to another user"
        # — we don't leak the distinction to clients.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    db.commit()
    return success_response(data={"id": notification_id})
