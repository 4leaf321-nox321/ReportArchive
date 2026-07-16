"""Notice services — announcement post CRUD.

Kept intentionally thin (no comments, no triage). Pinned notices sort
first, then newest-first by creation time.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.notices.models import NoticePost
from app.modules.notices.schemas import NoticePostCreate, NoticePostUpdate


def list_posts(
    db: Session,
    *,
    limit: int = 200,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Returns (page_items, total). Server-side pagination. Pinned
    notices float to the top; within each group, newest first."""
    total = db.execute(select(func.count(NoticePost.id))).scalar_one()
    if total == 0:
        return [], 0

    stmt = (
        select(NoticePost)
        .order_by(NoticePost.pinned.desc(), NoticePost.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    posts = list(db.execute(stmt).scalars())
    return [_post_to_dict(p) for p in posts], int(total)


def get_post(db: Session, post_id: int) -> Optional[NoticePost]:
    return db.get(NoticePost, post_id)


def latest_post(db: Session) -> Optional[NoticePost]:
    """가장 최근에 작성된 공지 1건(id 최대). 팝업은 pinned 정렬과 무관하게
    '마지막에 올라온 것'만 대상으로 하므로 id 기준으로 뽑는다."""
    return db.execute(
        select(NoticePost).order_by(NoticePost.id.desc()).limit(1)
    ).scalar_one_or_none()


def create_post(
    db: Session, payload: NoticePostCreate, *, author_user_id: int
) -> NoticePost:
    post = NoticePost(
        title=payload.title.strip(),
        body=payload.body,
        pinned=payload.pinned,
        author_user_id=author_user_id,
        attachments=[a.model_dump() for a in payload.attachments],
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


def update_post(
    db: Session, post: NoticePost, payload: NoticePostUpdate
) -> NoticePost:
    fields_set = payload.model_fields_set
    data = payload.model_dump()
    for key in ("title", "body", "pinned"):
        if key in fields_set and data[key] is not None:
            setattr(post, key, data[key])
    if "attachments" in fields_set and data["attachments"] is not None:
        # Stored as plain dicts in JSONB; payload arrives as pydantic
        # models that already passed validation.
        post.attachments = [
            a if isinstance(a, dict) else a.model_dump()
            for a in data["attachments"]
        ]
    db.commit()
    db.refresh(post)
    return post


def delete_post(db: Session, post: NoticePost) -> None:
    db.delete(post)
    db.commit()


# --------------------------------------------------------------------------- #
# Serializer — model → dict so the route layer doesn't carry SQL state.
# --------------------------------------------------------------------------- #
def _post_to_dict(post: NoticePost) -> dict:
    return {
        "id": post.id,
        "title": post.title,
        "body": post.body,
        "pinned": post.pinned,
        "author": _user_mini(post.author),
        "attachments": list(post.attachments or []),
        "created_at": post.created_at,
        "updated_at": post.updated_at,
    }


def _user_mini(user) -> Optional[dict]:
    if user is None:
        return None
    return {"id": user.id, "name": user.name, "email": user.email}
