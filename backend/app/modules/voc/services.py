"""VOC services — post CRUD, comment CRUD, admin triage actions."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.voc.models import (
    VocCategory,
    VocComment,
    VocPost,
    VocPriority,
    VocStatus,
)
from app.modules.voc.schemas import (
    VocCommentCreate,
    VocCommentUpdate,
    VocPostCreate,
    VocPostUpdate,
)


def list_posts(
    db: Session,
    *,
    status: Optional[VocStatus] = None,
    category: Optional[VocCategory] = None,
    author_user_id: Optional[int] = None,
    workspace_slug: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Returns (page_items, total). Server-side pagination — the
    frontend uses limit=200 chunks + virtualizes within so 10K+ posts
    stay smooth without dumping the whole table over the wire.

    Two queries instead of one GROUP BY join because VocPost eager-
    loads `author` — mixing `selectin author` with
    `GROUP BY voc_posts.id` makes Postgres complain about ungrouped
    user columns. Two cheap queries beats a fragile single-shot SQL."""

    def _apply_filters(stmt):
        if status is not None:
            stmt = stmt.where(VocPost.status == status)
        if category is not None:
            stmt = stmt.where(VocPost.category == category)
        if author_user_id is not None:
            stmt = stmt.where(VocPost.author_user_id == author_user_id)
        if workspace_slug is not None:
            stmt = stmt.where(VocPost.workspace_slug == workspace_slug)
        return stmt

    total = db.execute(
        _apply_filters(select(func.count(VocPost.id)))
    ).scalar_one()
    if total == 0:
        return [], 0

    stmt = _apply_filters(select(VocPost))
    stmt = stmt.order_by(VocPost.updated_at.desc()).limit(limit).offset(offset)
    posts = list(db.execute(stmt).scalars())
    if not posts:
        return [], int(total)

    counts = dict(
        db.execute(
            select(VocComment.post_id, func.count(VocComment.id))
            .where(VocComment.post_id.in_([p.id for p in posts]))
            .group_by(VocComment.post_id)
        ).all()
    )
    out = []
    for post in posts:
        d = _post_to_dict(post)
        d["comment_count"] = int(counts.get(post.id, 0))
        out.append(d)
    return out, int(total)


def get_post(db: Session, post_id: int) -> Optional[VocPost]:
    return db.get(VocPost, post_id)


def post_detail_dict(post: VocPost) -> dict:
    data = _post_to_dict(post)
    data["comments"] = [_comment_to_dict(c) for c in post.comments]
    data["comment_count"] = len(post.comments)
    return data


def create_post(
    db: Session, payload: VocPostCreate, *, author_user_id: int
) -> VocPost:
    post = VocPost(
        title=payload.title.strip(),
        body=payload.body,
        category=payload.category,
        author_user_id=author_user_id,
        workspace_slug=payload.workspace_slug,
        attachments=[a.model_dump() for a in payload.attachments],
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


def update_post(db: Session, post: VocPost, payload: VocPostUpdate) -> VocPost:
    fields_set = payload.model_fields_set
    data = payload.model_dump()
    for key in ("title", "body", "category"):
        if key in fields_set and data[key] is not None:
            setattr(post, key, data[key])
    if "attachments" in fields_set and data["attachments"] is not None:
        # Stored as plain dicts in JSONB; payload arrives as pydantic
        # models that already passed validation.
        post.attachments = [a if isinstance(a, dict) else a.model_dump()
                             for a in data["attachments"]]
    db.commit()
    db.refresh(post)
    return post


def delete_post(db: Session, post: VocPost) -> None:
    db.delete(post)
    db.commit()


def set_status(db: Session, post: VocPost, status: VocStatus) -> VocPost:
    post.status = status
    # Track resolved time so the list can sort or display "resolved in
    # 3 days" later — set on entering resolved/wontfix, cleared when
    # the post is reopened.
    if status in (VocStatus.resolved, VocStatus.wontfix):
        if post.resolved_at is None:
            post.resolved_at = datetime.utcnow()
    else:
        post.resolved_at = None
    db.commit()
    db.refresh(post)
    return post


def set_priority(db: Session, post: VocPost, priority: VocPriority) -> VocPost:
    post.priority = priority
    db.commit()
    db.refresh(post)
    return post


# --------------------------------------------------------------------------- #
# Comments
# --------------------------------------------------------------------------- #
def get_comment(db: Session, comment_id: int) -> Optional[VocComment]:
    return db.get(VocComment, comment_id)


def create_comment(
    db: Session,
    post: VocPost,
    payload: VocCommentCreate,
    *,
    author_user_id: int,
) -> VocComment:
    comment = VocComment(
        post_id=post.id,
        author_user_id=author_user_id,
        body=payload.body,
    )
    db.add(comment)
    # Bumping the post's updated_at on comment activity makes "recent
    # discussion" sort match user expectations.
    post.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(comment)
    return comment


def update_comment(
    db: Session, comment: VocComment, payload: VocCommentUpdate
) -> VocComment:
    comment.body = payload.body
    db.commit()
    db.refresh(comment)
    return comment


def delete_comment(db: Session, comment: VocComment) -> None:
    db.delete(comment)
    db.commit()


# --------------------------------------------------------------------------- #
# Serializers — model → dict so the route layer doesn't carry SQL state.
# --------------------------------------------------------------------------- #
def _post_to_dict(post: VocPost) -> dict:
    return {
        "id": post.id,
        "title": post.title,
        "body": post.body,
        "category": post.category,
        "status": post.status,
        "priority": post.priority,
        "author": _user_mini(post.author),
        "workspace_slug": post.workspace_slug,
        "attachments": list(post.attachments or []),
        "created_at": post.created_at,
        "updated_at": post.updated_at,
        "resolved_at": post.resolved_at,
        "comment_count": 0,
    }


def _comment_to_dict(comment: VocComment) -> dict:
    return {
        "id": comment.id,
        "post_id": comment.post_id,
        "body": comment.body,
        "author": _user_mini(comment.author),
        "created_at": comment.created_at,
        "updated_at": comment.updated_at,
    }


def _user_mini(user) -> Optional[dict]:
    if user is None:
        return None
    return {"id": user.id, "name": user.name, "email": user.email}
