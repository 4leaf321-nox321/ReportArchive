"""Comment routes — thread/comment CRUD for the inline review flow.

URL layout:
  - GET    /api/reports/{report_id}/threads      list threads (+nested)
  - POST   /api/reports/{report_id}/threads      create thread + head comment
  - POST   /api/threads/{thread_id}/comments     reply
  - PATCH  /api/threads/{thread_id}              resolve / reopen
  - PATCH  /api/comments/{comment_id}            edit own
  - DELETE /api/comments/{comment_id}            delete own

Permission: anyone visible to the report can read+post. Resolve gated
in services. Edit/delete own only. All mutations record an activity
row and may fire notifications — see services.py for the side-effect
matrix.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.comments import models as _models  # noqa: F401
from app.modules.comments import services
from app.modules.comments.models import Comment, CommentThread
from app.modules.comments.models import ThreadStatus
from app.modules.comments.schemas import (
    CommentCreate,
    CommentRead,
    CommentThreadCreate,
    CommentThreadListResponse,
    CommentThreadRead,
    CommentUpdate,
    InboxListResponse,
    InboxThread,
    ThreadStatusUpdate,
)
from app.modules.reports import services as report_services
from app.modules.users.models import User
from app.shared.auth import (
    CurrentUser,
    get_current_user,
    get_current_user_no_workspace,
)
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)


router = APIRouter()


def _to_http(exc: services.CommentError):
    return error_response(
        str(exc), errors=[{"code": exc.code}], status_code=exc.status_code
    )


def _public_only(db: Session, actor: CurrentUser, report) -> bool:
    """이 보고서를 *공개 경로로만* 보고 있는 외부 열람자인가 — 댓글 차단
    가드(조직간공개_설계.md §6). 읽기 게이트(is_visible_to)는 공개분을
    통과시키므로, "본문+첨부만 읽기전용" 을 지키려면 댓글 조회/작성은 여기서
    별도로 막는다. virtual(글로벌/관리자)·멤버 열람자는 False(평소대로 허용)."""
    return (
        not actor.workspace.virtual
        and report is not None
        and report_services.is_public_only_viewer(db, report, actor.workspace.slug)
    )


def _thread_payload(db: Session, thread: CommentThread) -> dict:
    """Build CommentThreadRead with nested comments and author info
    resolved. Done route-side so the schema stays declarative."""
    return CommentThreadRead(
        id=thread.id,
        report_id=thread.report_id,
        page_index=thread.page_index,
        block_id=thread.block_id,
        origin_workspace_slug=thread.origin_workspace_slug,
        author=_author_mini(db, thread.author_user_id),
        author_role_at_creation=thread.author_role_at_creation,
        status=thread.status,
        created_at=thread.created_at,
        resolved_at=thread.resolved_at,
        resolved_by=_author_mini(db, thread.resolved_by_user_id),
        comments=[_comment_payload(db, c) for c in thread.comments or []],
    ).model_dump(mode="json")


def _comment_payload(db: Session, c: Comment) -> dict:
    return CommentRead(
        id=c.id,
        thread_id=c.thread_id,
        author=_author_mini(db, c.author_user_id),
        body=c.body,
        created_at=c.created_at,
        updated_at=c.updated_at,
    ).model_dump(mode="json")


def _author_mini(db: Session, user_id: int | None):
    if user_id is None:
        return None
    u = db.get(User, user_id)
    if u is None:
        return None
    return {"id": u.id, "email": u.email, "name": u.name}


# ──────────────────────────────────────────────────────────────────
# /api/reports/{report_id}/threads
# ──────────────────────────────────────────────────────────────────


@router.get("/comments/inbox")
def list_my_inbox(
    status: str = Query(default="open"),
    limit: int = Query(default=50, ge=1, le=200),
    before_id: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """Cross-workspace comment inbox — every thread on a report owned
    by the actor. Workspace-agnostic dependency (no X-Workspace-Slug
    needed) so the sidebar can hit it from any page.

    Query params:
      - `status` — `open` (default) or `all`. Anything else falls back
        to `open` to keep the API forgiving.
      - `limit` — default 50, max 200.
      - `before_id` — cursor; pass the smallest `thread_id` from the
        previous page to fetch the next batch.
    """
    status_filter: ThreadStatus | None
    if status == "all":
        status_filter = None
    elif status in ("open", "resolved"):
        status_filter = ThreadStatus(status)
    else:
        status_filter = ThreadStatus.open
    items, open_count = services.list_inbox_for_owner(
        db,
        owner_user_id=actor.id,
        status=status_filter,
        limit=limit,
        before_id=before_id,
    )
    payload = InboxListResponse(
        items=[InboxThread.model_validate(i) for i in items],
        open_count=open_count,
    )
    return success_response(data=payload.model_dump(mode="json"))


@router.get("/reports/{report_id}/threads")
def list_threads(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    report = report_services.get_report(db, report_id)
    if not report:
        return not_found_response(f"보고서를 찾을 수 없습니다: {report_id}")
    if not actor.workspace.virtual and not report_services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        return error_response("Out of workspace scope", status_code=403)
    # 외부 공개 열람자에겐 댓글을 숨긴다(빈 목록) — 본문+첨부만 노출(§6).
    if _public_only(db, actor, report):
        return success_response(data={"items": []})

    threads = services.list_threads_for_report(db, report_id)
    payload = CommentThreadListResponse(
        items=[CommentThreadRead.model_validate(t) for t in threads]
    )
    # Schema picks up nested comments via from_attributes, but author
    # objects need manual resolution — rebuild via _thread_payload.
    return success_response(
        data={"items": [_thread_payload(db, t) for t in threads]}
    )


@router.post("/reports/{report_id}/threads")
def create_thread(
    report_id: int,
    payload: CommentThreadCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    report = report_services.get_report(db, report_id)
    if not report:
        return not_found_response(f"보고서를 찾을 수 없습니다: {report_id}")
    if not actor.workspace.virtual and not report_services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        return error_response("Out of workspace scope", status_code=403)
    if _public_only(db, actor, report):
        return error_response(
            "다른 조직의 공개 보고서에는 댓글을 작성할 수 없습니다.", status_code=403
        )

    try:
        thread = services.create_thread(
            db,
            report_id=report_id,
            page_index=payload.page_index,
            block_id=payload.block_id,
            body=payload.body,
            actor_user_id=actor.user.id,
            origin_workspace_slug=actor.workspace.slug,
        )
    except services.CommentError as e:
        return _to_http(e)
    db.commit()
    db.refresh(thread)
    return created_response(data=_thread_payload(db, thread))


# ──────────────────────────────────────────────────────────────────
# /api/threads/{thread_id}
# ──────────────────────────────────────────────────────────────────


@router.post("/threads/{thread_id}/comments")
def reply_to_thread(
    thread_id: int,
    payload: CommentCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    # Visibility: re-derive the report from the thread, check is_visible.
    thread = db.get(CommentThread, thread_id)
    if thread is None:
        return not_found_response(f"스레드를 찾을 수 없습니다: {thread_id}")
    report = report_services.get_report(db, thread.report_id)
    if not actor.workspace.virtual and not report_services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        return error_response("Out of workspace scope", status_code=403)
    if _public_only(db, actor, report):
        return error_response(
            "다른 조직의 공개 보고서에는 댓글을 작성할 수 없습니다.", status_code=403
        )

    try:
        comment = services.add_comment(
            db,
            thread_id=thread_id,
            body=payload.body,
            actor_user_id=actor.user.id,
        )
    except services.CommentError as e:
        return _to_http(e)
    db.commit()
    return created_response(data=_comment_payload(db, comment))


@router.patch("/threads/{thread_id}")
def set_status(
    thread_id: int,
    payload: ThreadStatusUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    # 공개 열람자는 스레드 해결/재오픈도 불가(§6) — thread→report 로 판정.
    thread_row = db.get(CommentThread, thread_id)
    if thread_row is not None and _public_only(
        db, actor, report_services.get_report(db, thread_row.report_id)
    ):
        return error_response(
            "다른 조직의 공개 보고서에는 댓글 상태를 변경할 수 없습니다.",
            status_code=403,
        )
    try:
        thread = services.set_thread_status(
            db,
            thread_id=thread_id,
            new_status=payload.status,
            actor_user_id=actor.user.id,
        )
    except services.CommentError as e:
        return _to_http(e)
    db.commit()
    db.refresh(thread)
    return success_response(data=_thread_payload(db, thread))


# ──────────────────────────────────────────────────────────────────
# /api/comments/{comment_id}  — own-only edit/delete
# ──────────────────────────────────────────────────────────────────


@router.patch("/comments/{comment_id}")
def edit_comment(
    comment_id: int,
    payload: CommentUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    try:
        comment = services.update_comment(
            db,
            comment_id=comment_id,
            body=payload.body,
            actor_user_id=actor.user.id,
        )
    except services.CommentError as e:
        return _to_http(e)
    db.commit()
    return success_response(data=_comment_payload(db, comment))


@router.delete("/comments/{comment_id}")
def remove_comment(
    comment_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    try:
        services.delete_comment(
            db, comment_id=comment_id, actor_user_id=actor.user.id
        )
    except services.CommentError as e:
        return _to_http(e)
    db.commit()
    return success_response(data={"id": comment_id})
