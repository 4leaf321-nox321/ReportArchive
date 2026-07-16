"""Notice board routes — system-wide announcements.

Read access: any authenticated user. Write access (create / edit /
delete / pin): system admins only.

Auth model mirrors VOC — intentionally *not* `get_current_user` (which
requires X-Workspace-Slug). Notices live outside the workspace tree; the
header / sidebar link to /notices with no workspace prefix, so we'd fail
the header check for anyone who opens the page before a workspace is
loaded. Instead we use a small notice-specific dep that returns
(user, is_admin) where admin = User.is_system_admin.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.notices import services
from app.modules.notices.schemas import (
    NoticePopupSeen,
    NoticePostCreate,
    NoticePostListResponse,
    NoticePostRead,
    NoticePostUpdate,
)
from app.modules.users.models import User
from app.shared.auth import _resolve_user_from_token, bearer_scheme
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()

# 사용자별 preferences JSONB 에 저장하는 '팝업으로 마지막까지 확인한 공지 id'.
# high-water mark — 이 값보다 큰 id 의 공지(=더 최근)만 팝업 대상.
NOTICE_POPUP_SEEN_KEY = "notice_popup_seen_id"


@dataclass
class NoticeActor:
    """Resolved caller for notice routes — user + system-admin flag."""

    user: User
    is_admin: bool


def notice_actor(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> NoticeActor:
    """Auth dep that doesn't require workspace membership. `is_admin`
    here = SYSTEM admin (User.is_system_admin) — only they can post."""
    user = _resolve_user_from_token(db, credentials)
    return NoticeActor(user=user, is_admin=user.is_system_admin)


def _require_admin(actor: NoticeActor) -> None:
    if not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "공지 작성·수정·삭제는 시스템 관리자만 가능합니다.",
        )


@router.get("")
def list_posts(
    db: Session = Depends(get_db),
    _: NoticeActor = Depends(notice_actor),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """Server-paginated listing (limit / offset). Pinned first, then
    newest first. Any authenticated user can read."""
    rows, total = services.list_posts(db, limit=limit, offset=offset)
    return success_response(
        data=NoticePostListResponse(
            items=[NoticePostRead.model_validate(r) for r in rows],
            total=total,
            limit=limit,
            offset=offset,
        )
    )


@router.post("", status_code=201)
def create_post(
    payload: NoticePostCreate,
    db: Session = Depends(get_db),
    actor: NoticeActor = Depends(notice_actor),
):
    _require_admin(actor)
    post = services.create_post(db, payload, author_user_id=actor.user.id)
    return created_response(
        data=NoticePostRead.model_validate(services._post_to_dict(post))
    )


# --- 팝업(접속 시 1회 노출) ------------------------------------------------ #
# 정책은 서버가 판정한다: 가장 최근 공지가 사용자의 seen high-water mark 보다
# 최신일 때만, 그 '마지막 1건'만 팝업 대상. 기존 공지가 한꺼번에 뜨지 않는다.
@router.get("/popup")
def get_popup(
    db: Session = Depends(get_db),
    actor: NoticeActor = Depends(notice_actor),
):
    """접속자에게 띄울 팝업 공지 1건(없으면 null). 가장 최근 공지가 이미 확인한
    id 이하이면 null."""
    latest = services.latest_post(db)
    seen_id = int((actor.user.preferences or {}).get(NOTICE_POPUP_SEEN_KEY) or 0)
    if latest is None or latest.id <= seen_id:
        return success_response(data=None)
    return success_response(
        data=NoticePostRead.model_validate(services._post_to_dict(latest))
    )


@router.post("/popup/seen")
def mark_popup_seen(
    payload: NoticePopupSeen,
    db: Session = Depends(get_db),
    actor: NoticeActor = Depends(notice_actor),
):
    """팝업을 확인 처리 — seen mark 를 올린다(내려가지는 않음). 이후 이 id
    이하의 공지는 다시 팝업되지 않는다. 기기/브라우저 무관하게 서버에 남는다."""
    user = db.get(User, actor.user.id)
    if user is None:
        return not_found_response("사용자를 찾을 수 없습니다.")
    prefs = dict(user.preferences or {})
    current = int(prefs.get(NOTICE_POPUP_SEEN_KEY) or 0)
    # 새 dict 로 재할당해야 JSONB 변경이 dirty 로 잡힌다(_deep_merge_prefs 와 동일 이유).
    prefs[NOTICE_POPUP_SEEN_KEY] = max(current, payload.notice_id)
    user.preferences = prefs
    db.commit()
    return success_response(data={NOTICE_POPUP_SEEN_KEY: prefs[NOTICE_POPUP_SEEN_KEY]})


@router.get("/{post_id}")
def get_post(
    post_id: int,
    db: Session = Depends(get_db),
    _: NoticeActor = Depends(notice_actor),
):
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"공지를 찾을 수 없습니다: {post_id}")
    return success_response(
        data=NoticePostRead.model_validate(services._post_to_dict(post))
    )


@router.patch("/{post_id}")
def update_post(
    post_id: int,
    payload: NoticePostUpdate,
    db: Session = Depends(get_db),
    actor: NoticeActor = Depends(notice_actor),
):
    _require_admin(actor)
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"공지를 찾을 수 없습니다: {post_id}")
    post = services.update_post(db, post, payload)
    return success_response(
        data=NoticePostRead.model_validate(services._post_to_dict(post))
    )


@router.delete("/{post_id}")
def delete_post(
    post_id: int,
    db: Session = Depends(get_db),
    actor: NoticeActor = Depends(notice_actor),
):
    _require_admin(actor)
    post = services.get_post(db, post_id)
    if not post:
        return not_found_response(f"공지를 찾을 수 없습니다: {post_id}")
    services.delete_post(db, post)
    return success_response(message="삭제되었습니다.")
