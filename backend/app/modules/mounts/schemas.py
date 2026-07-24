"""Pydantic schemas for the mounts module."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.mounts.models import MountEditPolicy


class MountRead(BaseModel):
    """One mount link — a report visible on one org workspace."""

    model_config = ConfigDict(from_attributes=True)

    report_id: int
    workspace_slug: str
    edit_policy: MountEditPolicy
    mounted_by_user_id: Optional[int] = None
    mounted_at: datetime
    note: str
    # 이 게시판에서 *현재 사용자가 직접* 게시취소할 수 있는지(그 board 매니저/
    # 시스템관리자). 작성자라도 관리 안 하는 board 는 False — 프런트가 "해제"
    # 버튼을 이 값으로 게이팅하고, 나머지는 "게시판에서 내리기 요청"으로 보낸다.
    can_unmount: Optional[bool] = None
    # 이 게시판에 대해 현재 pending 인 게시취소 요청이 있는지. 작성자가 개별
    # 게시판에 "내리기 요청"을 보내면 그 board 매니저 승인 전까지 True — 프런트가
    # "승인 대기" 뱃지로 표시해, 중복 요청/재클릭을 막는다.
    takedown_pending: Optional[bool] = None
    # Org folder placement on this board. NULL = 미분류 in that board's
    # listing. Same Report can be in different folders on different
    # boards (folder is mount-level, not report-level).
    folder_id: Optional[int] = None
    # 표시용 이름 — 라우트가 Workspace/Folder 에서 채운다. folder_name 은 미분류면
    # None. "게시 위치" 보기에서 "게시판명 · 폴더명"으로 렌더.
    workspace_name: Optional[str] = None
    folder_name: Optional[str] = None


class MountListResponse(BaseModel):
    items: list[MountRead]


class TakedownRequestRead(BaseModel):
    """게시취소 요청 한 건 — 매니저 큐 표시용. 평면화된 표시 필드는 라우트가
    ORM 관계에서 채운다."""

    id: int
    report_id: int
    report_title: Optional[str] = None
    workspace_slug: str
    workspace_name: Optional[str] = None
    requested_by_name: Optional[str] = None
    status: str
    created_at: datetime


class TakedownRequestResult(BaseModel):
    """POST /api/reports/{id}/takedown-requests 결과 요약."""

    requested: int  # 매니저 승인 대기로 새로 만든 요청 수
    auto_removed: int  # 요청자가 관리해 즉시 게시취소된 게시판 수


class MountCreate(BaseModel):
    """POST /api/mounts payload — promote a report to one or more org
    boards in a single request.

    `edit_policy`, `note`, and `folder_id` are uniform across all targets
    here. Per-board variation (different folder per board) is two
    separate POST calls. `folder_id` is interpreted in the context of
    each target workspace — caller is responsible for picking a folder
    that lives in that workspace.
    """

    report_id: int
    workspace_slugs: list[str] = Field(..., min_length=1)
    edit_policy: MountEditPolicy = MountEditPolicy.default
    note: str = ""
    folder_id: Optional[int] = None


class MountFolderUpdate(BaseModel):
    """PUT /api/mounts/{report_id}/{workspace_slug}/folder payload —
    metadata-only move of an existing mount between org folders.
    """

    folder_id: Optional[int] = None


class MountEditPolicyUpdate(BaseModel):
    """PUT /api/mounts/{report_id}/{workspace_slug}/edit-policy payload —
    change the per-board edit policy (Phase 3). Owner-only.
    """

    edit_policy: MountEditPolicy


class MountNoteUpdate(BaseModel):
    """PUT /api/mounts/{report_id}/{workspace_slug}/note payload — 게시 메모
    수정. 권한: 작성자 / 게시자 / 게시판 매니저."""

    note: str = Field(default="", max_length=1000)


class UnmountResponse(BaseModel):
    """Acknowledgement for DELETE /api/mounts/{report_id}/{workspace_slug}."""

    report_id: int
    workspace_slug: str
