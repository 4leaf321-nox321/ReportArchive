"""Editor grant routes — Phase 3.

Endpoint shape:
  GET    /api/reports/{report_id}/editors            list current
  POST   /api/reports/{report_id}/editors            { user_id }  → add
  DELETE /api/reports/{report_id}/editors/{user_id}  → remove

All operations are owner-only. The author lock is independent — grants
can still be added/removed while a report is locked (locking is about
content, not access policy).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.editors import models as _models  # noqa: F401  (mapper registration)
from app.modules.editors import services
from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.reports import services as report_services
from app.modules.users.models import User
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import not_found_response, success_response


router = APIRouter(prefix="/reports")


class EditorMini(BaseModel):
    id: int
    name: str | None = None
    email: str | None = None
    added_at: str | None = None
    added_by_user_id: int | None = None


class AddEditorBody(BaseModel):
    user_id: int


def _require_owner(report, actor_user_id: int) -> None:
    """Owner-only guard. System admin override is deliberately NOT
    granted for grant management — letting a sys admin silently add
    themselves to every report would defeat the audit trail. They can
    still edit content (decision #2) but can't escalate by grant."""
    if report.owner_user_id != actor_user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "추가 편집자 관리는 작성자만 가능합니다.",
        )


def _resolve_report(db: Session, report_id: int, actor: CurrentUser):
    report = report_services.get_report(db, report_id)
    if not report:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"Report not found: {report_id}"
        )
    if not report_services.can_read_report(db, actor, report):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Out of workspace scope"
        )
    return report


@router.get("/{report_id}/editors")
def list_report_editors(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    report = _resolve_report(db, report_id, actor)
    # Reading the list is broader than mutation — anyone with report
    # visibility sees who else can edit. Helps the "왜 김부장이 내
    # 보고서에 편집권을 가진 거지?" investigation.
    rows = services.list_editors(db, report_id=report.id)
    user_by_id = {
        u.id: u for u in services.get_editor_users(db, report_id=report.id)
    }
    items = [
        EditorMini(
            id=r.user_id,
            name=user_by_id.get(r.user_id).name if r.user_id in user_by_id else None,
            email=user_by_id.get(r.user_id).email if r.user_id in user_by_id else None,
            added_at=r.added_at.isoformat() if r.added_at else None,
            added_by_user_id=r.added_by_user_id,
        )
        for r in rows
    ]
    return success_response(data={"items": [it.model_dump() for it in items]})


@router.post("/{report_id}/editors")
def add_report_editor(
    report_id: int,
    body: AddEditorBody,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity

    report = _resolve_report(db, report_id, actor)
    _require_owner(report, actor.user.id)

    target = db.get(User, body.user_id)
    if target is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"사용자를 찾을 수 없습니다: {body.user_id}",
        )

    # Idempotent — re-adding doesn't error.
    services.add_editor(
        db,
        report_id=report.id,
        user_id=target.id,
        added_by_user_id=actor.user.id,
    )

    # Audit trail + notification to the newly-granted editor.
    record_activity(
        db,
        report_id=report.id,
        type=ReportActivityType.editor_added,
        actor_user_id=actor.user.id,
        payload={
            "editor_user_id": target.id,
            "editor_name": target.name,
        },
    )
    create_notification(
        db,
        recipient_user_id=target.id,
        actor_user_id=actor.user.id,
        type=NotificationType.editor_added,
        ref_table="reports",
        ref_id=report.id,
        payload={"report_title": report.title},
    )
    db.commit()
    return success_response(
        data={"report_id": report.id, "user_id": target.id}
    )


@router.delete("/{report_id}/editors/{user_id}")
def remove_report_editor(
    report_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity

    report = _resolve_report(db, report_id, actor)
    _require_owner(report, actor.user.id)

    removed = services.remove_editor(
        db, report_id=report.id, user_id=user_id
    )
    if not removed:
        return not_found_response(
            f"Editor grant not found: report={report_id}, user={user_id}"
        )

    target = db.get(User, user_id)
    record_activity(
        db,
        report_id=report.id,
        type=ReportActivityType.editor_removed,
        actor_user_id=actor.user.id,
        payload={
            "editor_user_id": user_id,
            "editor_name": target.name if target else None,
        },
    )
    db.commit()
    return success_response(
        data={"report_id": report.id, "user_id": user_id}
    )
