"""Pydantic schemas for composite reports."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.composites.models import CompositeKind


def _flatten_user_refs(obj: Any) -> Any:
    """Pull joined user info into flat name/email fields so the frontend
    doesn't need a separate /api/users lookup per row. Mirrors the helper
    used by the reports schemas."""
    if obj is None or isinstance(obj, dict):
        return obj
    extras: dict[str, Any] = {}
    owner = getattr(obj, "owner", None)
    if owner is not None:
        extras["owner_name"] = owner.name
        extras["owner_email"] = owner.email
    updated_by = getattr(obj, "updated_by", None)
    if updated_by is not None:
        extras["updated_by_name"] = updated_by.name
        extras["updated_by_email"] = updated_by.email
    # Phase 5A — publish attribution. NULL when unpublished; readers
    # treat absence as "draft / live mode".
    published_by = getattr(obj, "published_by", None)
    if published_by is not None:
        extras["published_by_name"] = published_by.name
        extras["published_by_email"] = published_by.email
    if not extras:
        return obj
    base: dict[str, Any] = {
        key: getattr(obj, key)
        for key in (
            "id", "workspace_slug", "title", "kind", "period_date",
            "description", "two_col_view", "view_mode", "summary_widgets",
            "groups", "revision", "owner_user_id", "external_view",
            "updated_by_user_id", "published_at", "published_by_user_id",
            "items", "created_at", "updated_at",
        )
        if hasattr(obj, key)
    }
    base.update(extras)
    return base


class ItemRefReport(BaseModel):
    """Read-side projection of a referenced source report. Keeps fields
    light so the picker dialog and the detail view both stay snappy."""

    model_config = ConfigDict(extra="ignore", from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    template_id: str
    template_version: int
    report_date: Optional[date] = None
    status: Optional[str] = None
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    # 작성자의 소속(home) 부서 slug — "소속" 의 1순위 신호. 여러 게시판에 올린
    # 보고서도 작성자 부서는 하나라 깔끔하다. 이름은 프런트가 워크스페이스
    # 목록(전체 org)으로 해석한다(작성자가 다른 트리여도 /api/workspaces 가
    # 전체 org 를 주므로 안전).
    owner_dept_slug: Optional[str] = None
    updated_at: Optional[datetime] = None
    # 보고서가 게시된 조직 게시판(부서) 이름들 — 게시 위치 보조 정보. 프런트는
    # 너무 길지 않게 첫 1개 + "외 N" 으로 축약해 보여준다. 미게시면 빈 리스트.
    mounted_org_names: list[str] = []

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        out: dict[str, Any] = {
            k: getattr(obj, k)
            for k in (
                "id", "workspace_slug", "title", "template_id",
                "template_version", "report_date", "status",
                "owner_user_id", "updated_at",
            )
            if hasattr(obj, k)
        }
        owner = getattr(obj, "owner", None)
        if owner is not None:
            out["owner_name"] = owner.name
            out["owner_dept_slug"] = getattr(owner, "home_workspace_slug", None)
        # 게시된 조직 게시판 이름 (mounts 는 Report 모델에서 selectin eager,
        # ReportMount.workspace 는 joined — 추가 쿼리 없음).
        out["mounted_org_names"] = [
            m.workspace.name
            for m in (getattr(obj, "mounts", None) or [])
            if getattr(m, "workspace", None) is not None
            and not str(getattr(m, "workspace_slug", "")).startswith("personal-")
        ]
        return out


class ItemRefComposite(BaseModel):
    """Read-side projection of a referenced sub-composite (recursive)."""

    model_config = ConfigDict(extra="ignore", from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    kind: CompositeKind
    period_date: Optional[date] = None
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    updated_at: Optional[datetime] = None

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        out: dict[str, Any] = {
            k: getattr(obj, k)
            for k in (
                "id", "workspace_slug", "title", "kind", "period_date",
                "owner_user_id", "updated_at",
            )
            if hasattr(obj, k)
        }
        owner = getattr(obj, "owner", None)
        if owner is not None:
            out["owner_name"] = owner.name
        return out


class CompositeItemRead(BaseModel):
    """One entry in a composite report. Either ref_report or ref_composite
    is populated; the frontend uses item_type to decide which to render.

    Phase 5A — `snapshot_content` / `snapshot_taken_at` carry the frozen
    report content for items inside a published recurring composite.
    NULL = use live (theme composites, or unpublished recurring).
    Frontend `InlineReportView` prefers snapshot over live fetch when
    present, so a published recurring composite renders the as-of-publish
    state even if the source report has since been edited."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    position: int
    note: str
    item_type: str   # 'report' | 'composite' — convenience for the FE
    ref_report: Optional[ItemRefReport] = None
    ref_composite: Optional[ItemRefComposite] = None
    snapshot_content: Optional[dict] = None
    snapshot_taken_at: Optional[datetime] = None
    # 원본 보고서가 영구삭제돼 분리된 발행 안건(스냅샷만 남음). 프런트가
    # 스냅샷으로 렌더하되 "원본 삭제됨" 표시를 띄우게 한다.
    source_deleted: bool = False
    # Phase 5B — per-item placement for the landscape-2col DOCX export.
    # 1=left, 2=right. Portrait/1-col mode ignores this.
    display_column: int = 1
    # Optional grouping name — consecutive items sharing a value are
    # rendered under one `[group_name]` header in DOCX. NULL = ungrouped.
    group_name: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _decorate(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        ref_report_id = getattr(obj, "ref_report_id", None)
        ref_composite_id = getattr(obj, "ref_composite_id", None)
        snapshot = getattr(obj, "snapshot_content", None)
        # 원본 영구삭제로 분리된 발행 안건: 두 ref 다 NULL 인데 snapshot 이 있음.
        # 이 경우도 'report' 항목으로 렌더(스냅샷 기반)하고 source_deleted 표시.
        is_report = ref_report_id is not None or (
            ref_composite_id is None and snapshot is not None
        )
        out = {
            "id": getattr(obj, "id"),
            "position": getattr(obj, "position"),
            "note": getattr(obj, "note", ""),
            "item_type": "report" if is_report else "composite",
            "ref_report": getattr(obj, "ref_report", None) if is_report else None,
            "ref_composite": getattr(obj, "ref_composite", None) if not is_report else None,
            "snapshot_content": snapshot,
            "snapshot_taken_at": getattr(obj, "snapshot_taken_at", None),
            "source_deleted": is_report and ref_report_id is None,
            "display_column": getattr(obj, "display_column", 1) or 1,
            "group_name": getattr(obj, "group_name", None),
        }
        return out


class CompositeReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    kind: CompositeKind
    period_date: Optional[date] = None
    description: str
    # 화면 보기 모드(레거시 boolean — view_mode 가 진실의 원천).
    two_col_view: bool = False
    # 화면 보기 모드 — 'single' | 'two_col' | 'list'.
    view_mode: str = "single"
    # 낙관적 동시성 토큰 — 구조 편집 시 expected_revision 으로 echo.
    revision: int = 1
    # 요약 페이지 위젯 — [{ id, type, props, content, layout }, ...].
    summary_widgets: list[dict] = []
    # 그룹 골격(빈 그룹 포함) — 이름의 순서 있는 리스트. 안건 없는 빈 그룹도
    # 여기에 담겨 저장·복원된다. 비어 있으면 프론트가 item group_name 으로 폴백.
    groups: list[str] = []
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    published_at: Optional[datetime] = None
    published_by_user_id: Optional[int] = None
    published_by_name: Optional[str] = None
    published_by_email: Optional[str] = None
    # (레거시 컬럼 — 가시성 판정엔 안 쓰임; is_public 을 보라.)
    external_view: bool = False
    # 전체 공개(all_org grant 또는 게시판 all_org)인가 — 지구본 표시용. 라우트가 채움.
    is_public: bool = False
    # 외부 공개 열람자로 진입했는지(읽기전용 배너·곁다리 차단용). 라우트가
    # actor 컨텍스트로 채운다(모델 컬럼 아님). can_edit 은 편집 가능 여부.
    is_public_view: bool = False
    can_edit: bool = True
    items: list[CompositeItemRead] = []
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        return _flatten_user_refs(obj)


class CompositeRef(BaseModel):
    """Slim composite reference — what the report-detail header shows in
    the "포함된 종합 N개" chip popover. No items, no description, just
    enough to identify and navigate (Phase 5C)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    kind: CompositeKind
    period_date: Optional[date] = None
    published_at: Optional[datetime] = None
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        out: dict[str, Any] = {
            k: getattr(obj, k)
            for k in (
                "id", "workspace_slug", "title", "kind", "period_date",
                "published_at", "owner_user_id", "updated_at",
            )
            if hasattr(obj, k)
        }
        owner = getattr(obj, "owner", None)
        if owner is not None:
            out["owner_name"] = owner.name
        return out


class CompositeReportSummary(BaseModel):
    """List-view projection. Drops items + description for bulk responses."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    kind: CompositeKind
    period_date: Optional[date] = None
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    # Phase 5A — publish state. published_at != null = 발행됨 (recurring
    # 일 때만 의미; theme 은 항상 NULL). List view 에서 "발행됨" 칩
    # 노출용.
    published_at: Optional[datetime] = None
    # (레거시 컬럼.) is_public 이 실제 전체공개 여부 — 라우트가 채움(지구본 표시).
    external_view: bool = False
    is_public: bool = False
    # 공유 대상 요약(목록 뱃지/호버용) — 라우트가 채움. [{principal_type, label, level}]
    shares: list[dict] = []
    item_count: int = 0
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        flat = _flatten_user_refs(obj)
        if isinstance(flat, dict):
            items = flat.get("items") or []
            flat["item_count"] = len(items)
            flat.pop("items", None)
        elif hasattr(obj, "items"):
            return {
                **(flat if isinstance(flat, dict) else {}),
                "item_count": len(obj.items or []),
            }
        return flat


# ── Mutations ───────────────────────────────────────────────────────────
class CompositeItemPayload(BaseModel):
    """Request side of an item — caller supplies one of the two refs."""

    note: str = ""
    ref_report_id: Optional[int] = None
    ref_composite_id: Optional[int] = None
    # 1=left, 2=right. Defaults to left when caller omits it.
    display_column: int = Field(default=1, ge=1, le=2)
    # Optional group name (max 128 chars). Empty string normalized to None
    # so "no group" round-trips as NULL in the DB, not "".
    group_name: Optional[str] = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def _exactly_one(self) -> "CompositeItemPayload":
        ref_count = (self.ref_report_id is not None) + (self.ref_composite_id is not None)
        if ref_count != 1:
            raise ValueError("item must reference exactly one of ref_report_id / ref_composite_id")
        if self.group_name is not None:
            trimmed = self.group_name.strip()
            self.group_name = trimmed if trimmed else None
        return self


class CompositeReportCreate(BaseModel):
    workspace_slug: str = Field(..., min_length=1, max_length=64)
    title: str = Field(..., min_length=1, max_length=255)
    kind: CompositeKind
    period_date: Optional[date] = None
    description: str = ""
    two_col_view: bool = False
    view_mode: str = "single"
    summary_widgets: list[dict] = []
    # 그룹 골격(빈 그룹 포함). 양식에서 시작할 때 빈 그룹을 바로 영속하기 위함.
    groups: list[str] = []
    # Optional initial items — equivalent to creating then PATCHing.
    items: list[CompositeItemPayload] = []


class CompositeReportUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    kind: Optional[CompositeKind] = None
    period_date: Optional[date] = None
    description: Optional[str] = None
    two_col_view: Optional[bool] = None
    view_mode: Optional[str] = None
    summary_widgets: Optional[list[dict]] = None
    # 그룹 골격(빈 그룹 포함). 보내면 통째로 교체. 빈 그룹도 여기 담아 보내야
    # 저장·복원된다. None(omit)이면 그룹 목록은 손대지 않음.
    groups: Optional[list[str]] = None
    # When set, replaces the entire items list (matching position order).
    # Omit to leave items untouched.
    items: Optional[list[CompositeItemPayload]] = None
    # 낙관적 동시성 — 클라이언트가 알고 있던 revision. items 를 함께 보낼 때
    # (구조 전량 교체) 서버 값과 다르면 409 로 거절(다른 사람이 먼저 저장).
    # None 이면 검사 생략(보기 설정만 바꾸는 가벼운 PATCH 등).
    expected_revision: Optional[int] = Field(default=None, ge=1)


class CompositeExternalViewUpdate(BaseModel):
    """조직 간 공개 토글 — 소유자/매니저/시스템관리자 전용 별도 엔드포인트
    (워크스페이스의 /external-view 와 동형). 일반 PATCH 와 분리해 권한을 좁힌다."""

    external_view: bool


# ── 안건 제출(신청) 큐 ────────────────────────────────────────────────────
class CompositeItemRequestCreate(BaseModel):
    """보고서를 종합보고에 안건으로 제출. ref_report_id 만 받는다(재귀 방지)."""

    ref_report_id: int
    note: str = Field(default="", max_length=1000)


class CompositeItemRequestRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    composite_id: int
    ref_report_id: int
    status: str
    note: str = ""
    requested_by_user_id: Optional[int] = None
    requested_by_name: Optional[str] = None
    decided_by_user_id: Optional[int] = None
    decided_at: Optional[datetime] = None
    created_at: datetime
    # 제출된 보고서의 슬림 정보 — 제목·작성자·소속·기준일을 대기 패널에서
    # 바로 보여주기 위함(ItemRefReport 와 동일 프로젝션).
    report: Optional[ItemRefReport] = None

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        out: dict[str, Any] = {
            k: getattr(obj, k)
            for k in (
                "id", "composite_id", "ref_report_id", "status", "note",
                "requested_by_user_id", "decided_by_user_id", "decided_at",
                "created_at",
            )
            if hasattr(obj, k)
        }
        # Enum → 문자열 값.
        st = out.get("status")
        out["status"] = getattr(st, "value", st)
        requester = getattr(obj, "requested_by", None)
        if requester is not None:
            out["requested_by_name"] = requester.name
        out["report"] = getattr(obj, "ref_report", None)
        return out
