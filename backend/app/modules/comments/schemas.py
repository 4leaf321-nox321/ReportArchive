"""Pydantic schemas for comments."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.comments.models import AuthorRoleSnapshot, ThreadStatus
from app.shared.datetime_utils import UtcDatetime


class CommentAuthor(BaseModel):
    """Slim author info — name + email for display."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str


class CommentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    thread_id: int
    author: Optional[CommentAuthor] = None
    body: dict  # tiptap doc JSON
    created_at: UtcDatetime
    updated_at: UtcDatetime


class CommentThreadRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    report_id: int
    page_index: int
    block_id: str
    origin_workspace_slug: Optional[str]
    author: Optional[CommentAuthor] = None
    author_role_at_creation: AuthorRoleSnapshot
    status: ThreadStatus
    created_at: UtcDatetime
    resolved_at: Optional[UtcDatetime] = None
    resolved_by: Optional[CommentAuthor] = None
    comments: list[CommentRead] = []


class CommentThreadListResponse(BaseModel):
    items: list[CommentThreadRead]


class CommentThreadCreate(BaseModel):
    """POST /api/reports/{id}/threads — start a new thread anchored on a
    specific widget. Body is the initial comment (head post)."""

    page_index: int = Field(..., ge=0)
    block_id: str = Field(..., min_length=1, max_length=64)
    body: dict  # tiptap doc JSON


class CommentCreate(BaseModel):
    """POST /api/threads/{id}/comments — reply to an existing thread."""

    body: dict


class CommentUpdate(BaseModel):
    body: dict


class ThreadStatusUpdate(BaseModel):
    status: ThreadStatus


# ──────────────────────────────────────────────────────────────────
# Inbox — "내가 받은 코멘트" cross-workspace view (Phase 4D)
# ──────────────────────────────────────────────────────────────────


class InboxThread(BaseModel):
    """One row of the personal inbox — enough context to triage without
    opening the report. `last_comment_excerpt` is plain text (the
    service strips tiptap doc structure) so it renders directly."""

    thread_id: int
    report_id: int
    report_title: str
    # Where the report lives (always personal post-Phase-1) — frontend
    # uses this to build the navigate URL (/w/{slug}/reports/{id}).
    report_workspace_slug: str
    # Where the thread was first authored — surfaces "팀1에서 작성"
    # provenance chip on the inbox card so the owner can tell which
    # board the conversation is happening on.
    origin_workspace_slug: Optional[str] = None
    origin_workspace_name: Optional[str] = None
    page_index: int
    block_id: str
    status: ThreadStatus
    author_role_at_creation: AuthorRoleSnapshot
    created_at: UtcDatetime
    last_comment_at: UtcDatetime
    last_comment_author: Optional[CommentAuthor] = None
    last_comment_excerpt: str = ""
    total_comments: int = 0


class InboxListResponse(BaseModel):
    items: list[InboxThread]
    # Convenience count for sidebar badge — number of open threads on
    # the user's reports. Cheap (covered by the index) and saves the
    # frontend from making a second roundtrip.
    open_count: int = 0
