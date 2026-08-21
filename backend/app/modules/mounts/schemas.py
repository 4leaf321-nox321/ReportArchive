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
    # Org folder placement on this board. 빈 리스트 = 미분류. 한 게시판
    # 안에서도 여러 폴더에 동시에 걸 수 있다(p89). 같은 보고서가 게시판마다
    # 다른 폴더에 있을 수 있는 것도 그대로(폴더는 mount 속성).
    folder_ids: list[int] = Field(default_factory=list)
    # 대표 폴더 — 단일 폴더만 다루는 옛 호출부(목록 드래그 이동 등)용 호환 뷰.
    # 폴더가 여러 개면 첫 번째, 미분류면 None.
    folder_id: Optional[int] = None
    # 표시용 이름 — 라우트가 Workspace/Folder 에서 채운다. folder_name 은 미분류면
    # None. "게시 위치" 보기에서 "게시판명 · 폴더명"으로 렌더.
    workspace_name: Optional[str] = None
    folder_name: Optional[str] = None
    folder_names: list[str] = Field(default_factory=list)


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

    `edit_policy`, `note`, and the folder set are uniform across all
    targets here. Per-board variation (different folders per board) is
    separate POST calls, or a follow-up PUT .../folders. Folder ids are
    interpreted in the context of each target workspace — caller is
    responsible for picking folders that live in that workspace.

    `folder_id` 는 단일 폴더만 보내던 옛 호출부 호환용 — `folder_ids` 와
    합집합으로 처리된다.
    """

    report_id: int
    workspace_slugs: list[str] = Field(..., min_length=1)
    edit_policy: MountEditPolicy = MountEditPolicy.default
    note: str = ""
    folder_id: Optional[int] = None
    folder_ids: list[int] = Field(default_factory=list)


class MountFolderUpdate(BaseModel):
    """PUT /api/mounts/{report_id}/{workspace_slug}/folder payload —
    metadata-only **move** of an existing mount to a single org folder
    (기존 배치를 전부 대체). None = 미분류.
    """

    folder_id: Optional[int] = None


class MountFoldersUpdate(BaseModel):
    """PUT /api/mounts/{report_id}/{workspace_slug}/folders payload —
    이 게시판에서의 폴더 배치 **집합**을 통째로 치환. 빈 리스트 = 미분류.
    한 게시판의 여러 폴더에 동시에 걸 때 쓴다(p89).
    """

    folder_ids: list[int] = Field(default_factory=list)


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
