"""Pydantic schemas for reports."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, model_validator
from sqlalchemy import inspect as sa_inspect

from app.modules.entities.schemas import EntityRefMini
from app.modules.report_types.models import ReportTypeStatus
from app.modules.reports.models import ReportLifecycle, ReportPhase


def _serialize_utc(dt: datetime) -> str:
    # Naive datetimes coming out of the DB are UTC (we write them with
    # datetime.utcnow()). Stamp the offset on the way out so JS clients
    # don't parse the ISO string as local wallclock.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


UtcDatetime = Annotated[datetime, PlainSerializer(_serialize_utc, return_type=str)]


def _flatten_user_refs(obj: Any) -> Any:
    """Pre-validator that copies joined user info from the ORM model into
    flat string fields so frontend consumers don't need a second lookup.
    Idempotent for dict inputs (used by JSON round-trips) — only walks the
    relationship attributes when given an ORM Report.
    """
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
    last_editor = getattr(obj, "last_editor", None)
    if last_editor is not None:
        extras["last_edited_by_name"] = last_editor.name
    # Flatten the live edit-lock (if any) into a small inline dict so the
    # GET /reports/{id} consumer can render "현재 OO 편집 중" without a
    # second roundtrip. We deliberately walk the eager-loaded relationship
    # here and let LockInfo's model_validator drop expired rows.
    # Flatten the joined report_type so list/detail consumers can render
    # the "종류" cell + settings preview without a second roundtrip. We
    # only emit the small "ref" shape (id/name/status/description) here;
    # the full row is fetchable via /api/report-types if needed.
    report_type = getattr(obj, "report_type", None)
    if report_type is not None:
        extras["report_type"] = {
            "id": report_type.id,
            "name": report_type.name,
            "description": report_type.description,
            "status": report_type.status,
        }
    lock = getattr(obj, "edit_lock", None)
    if lock is not None:
        lock_user = getattr(lock, "user", None)
        extras["edit_lock"] = {
            "user_id": lock.user_id,
            "user_name": getattr(lock_user, "name", None),
            "user_email": getattr(lock_user, "email", None),
            "acquired_at": lock.acquired_at,
            "expires_at": lock.expires_at,
        }
    # Flatten the M:N entity tags. We hand-roll the per-row dict (rather
    # than letting Pydantic walk the ORM list) because `type_slug` lives
    # on the joined EntityType — same trick the report_type block above
    # uses. Eager-loaded via `lazy="selectin"` on Report.entities, so this
    # is a relationship walk, not a per-row roundtrip.
    entities_rel = getattr(obj, "entities", None)
    if entities_rel is not None:
        extras["entities"] = [
            {
                "id": e.id,
                "type_id": e.type_id,
                "type_slug": e.entity_type.slug if e.entity_type else "",
                "value": e.value,
                "code": e.code,
                "status": e.status,
            }
            for e in entities_rel
        ]
    # Project mount placements into a slim list of (slug, name) so the
    # personal-list "게시" cell renders chips without a /api/mounts call
    # per row. Eager-loaded via Report.mounts (selectin) + mount.workspace
    # (joined), so this is a relationship walk, not a roundtrip. Empty
    # list = 미게시 (frontend renders a 회색 placeholder).
    mounts_rel = getattr(obj, "mounts", None)
    if mounts_rel is not None:
        extras["mount_workspaces"] = [
            {
                "slug": m.workspace_slug,
                "name": m.workspace.name if m.workspace else m.workspace_slug,
                "note": getattr(m, "note", "") or "",
            }
            for m in mounts_rel
        ]
    if not extras:
        return obj
    # Build a dict so Pydantic stops walking the ORM (otherwise it'd try
    # to find owner_name as an attribute on the row and fail). Column
    # keys come from SQLAlchemy's mapper so adding a new column to the
    # Report model is enough — no hand-maintained list to keep in sync.
    # Relationships are intentionally excluded (Pydantic would try to
    # walk them); the relationship-derived fields above are flattened by
    # hand into `extras`.
    base: dict[str, Any] = {
        col.key: getattr(obj, col.key)
        for col in sa_inspect(type(obj)).mapper.column_attrs
        if hasattr(obj, col.key)
    }
    base.update(extras)
    return base


class MountWorkspaceMini(BaseModel):
    """Slim mount projection — what the personal-list "게시" cell needs to
    render chip strips ("팀1·본부A에 게시됨"). The full ReportMount payload
    (edit_policy, mounted_by, folder_id) is fetchable via /api/mounts."""

    slug: str
    name: str
    # 게시 메모 — 목록 칩에 💬 아이콘+툴팁으로 노출(옵션 1).
    note: str = ""


class ReportTypeRef(BaseModel):
    """Slim, embedded form of a report type — what we flatten into report
    list/detail responses so the frontend doesn't need a second lookup.
    Status is included so the picker / list-cell can show the "비공식"
    badge inline."""

    id: int
    name: str
    description: str = ""
    status: ReportTypeStatus


class LockInfo(BaseModel):
    """Inline lock-state payload — embedded in ReportRead and returned by
    the dedicated POST/heartbeat lock endpoints. `expires_at` is the wall
    clock the client should treat as the deadline (the server's clock).
    """

    user_id: int
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    acquired_at: UtcDatetime
    expires_at: UtcDatetime


class ReportPage(BaseModel):
    """A single page within a report.

    Each page binds to its own template version so a report can mix
    different layouts (e.g. cover page + detail pages + appendix). The
    very first page's template is mirrored into the report's top-level
    `template_id` / `template_version` columns to keep the FK constraint
    + list-view fields meaningful.
    """

    template_id: str = Field(..., min_length=1, max_length=64)
    template_version: int = Field(..., ge=1)
    # Per-page display name (shown in the page strip). When unset, the
    # frontend falls back to the page's template name. The overall report
    # title is the separate `Report.title` column.
    name: Optional[str] = Field(default=None, max_length=120)
    content: dict = {}
    layout_overrides: Optional[dict] = None
    # Visual-style overrides keyed by block id, e.g.
    #   { "<block_id>": { "text_style": {...}, "depth_styles": {...} } }
    # Whitelisted by the service layer to {text_style, depth_styles} —
    # structural props (items, min_length, ...) stay locked because the
    # content schema is derived from them.
    props_overrides: Optional[dict] = None
    # Ad-hoc blocks added at report-write time. Shape mirrors a template
    # block: { id, type, props, layout? }. They sit alongside the
    # template's blocks at render time; content for each is stored in the
    # same `content` dict keyed by block.id. Validation combines template
    # blocks + extra_blocks before checking content shape, so unknown
    # content keys still get rejected.
    extra_blocks: list[dict] = []
    # Authoritative per-page block sequence — when non-empty, fully
    # replaces the implicit (template-order + extras) ordering. Each
    # entry is a block id that must exist either in the template's
    # blocks or in extra_blocks. Template block ids missing from the
    # list are hidden, so removing template-defined blocks from a
    # specific report is just "exclude that id from blocks_order".
    blocks_order: list[str] = []
    # Optional per-block "section marker" tag — keys are block ids,
    # values are item codes from the frontend's SECTION_CATEGORIES
    # taxonomy (e.g. 'rationale', 'risk', 'action_item'), or `null` to
    # mark the block as "explicitly no section" (overriding the template's
    # per-block default). When a key is absent entirely, the renderer
    # falls back to whatever the template's block defines under
    # `schema.blocks[].section`. Display-only metadata; no validation
    # against a known whitelist because the taxonomy lives on the frontend
    # side and might evolve.
    block_sections: dict[str, Optional[str]] = {}


class ReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    # Top-level template/content/layout_overrides reflect *page 0* — kept
    # for backward-compat with existing API consumers and to satisfy the
    # composite FK. Multi-page consumers should read `pages` instead.
    template_id: str
    template_version: int
    title: str
    phase: ReportPhase
    lifecycle: ReportLifecycle
    closed_at: Optional[date] = None
    author_lock_enabled: bool = False
    author_lock_reason: str = ""
    author_lock_set_at: Optional[UtcDatetime] = None
    folder_id: Optional[int] = None
    forked_from_report_id: Optional[int] = None
    forked_at_revision: Optional[int] = None
    report_date: date
    owner_user_id: Optional[int]
    # Joined display fields — flattened so the frontend doesn't need a
    # separate /api/users lookup for every report row. workspace_slug above
    # doubles as "작성자가 작성 시점에 속해 있던 부서" (no separate snapshot
    # column because reports don't currently move between workspaces).
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    # Phase 3 — denormalized "마지막 편집자" attribution. Mirrors
    # updated_by_* but kept separate so future logic can diverge.
    last_edited_by_user_id: Optional[int] = None
    last_edited_by_name: Optional[str] = None
    last_edited_at: Optional[UtcDatetime] = None
    tags: list[str]
    content: dict
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    pages: list[ReportPage] = []
    # Per-report max content width in pixels. None → frontend uses its
    # narrow default (~1024px). Set via the report's empty-area right-click
    # menu; capped client-side at 3000.
    page_width_px: Optional[int] = Field(default=None, ge=320, le=3000)
    # Per-report vertical gap (px) between top-level widget rows. None →
    # frontend default. Set via 보고서 설정 → 페이지 설정 → 위젯 간격.
    page_gap_px: Optional[int] = Field(default=None, ge=0, le=200)
    # When True, widget container chrome (border + bg + shadow) is hidden
    # so the page reads as a single continuous surface. None / False →
    # default bordered cards. Set via 보고서 설정 → 페이지 설정.
    page_blend_blocks: Optional[bool] = None
    # PPT 슬라이드 가이드. 본문 위에 한 슬라이드 분량(콘텐츠 폭 × 역비율)
    # 마다 수평 점선을 그려서 PPT export 시 한 페이지가 어디까지인지 미리
    # 가늠하게 해 준다. page_slide_guide=None/False면 가이드 OFF.
    # page_slide_ratio가 "custom"일 때만 custom_w/_h가 의미를 가진다.
    page_slide_guide: Optional[bool] = None
    page_slide_ratio: Optional[Literal["16:9", "4:3", "16:10", "custom"]] = None
    page_slide_ratio_custom_w: Optional[int] = Field(default=None, ge=1, le=10000)
    page_slide_ratio_custom_h: Optional[int] = Field(default=None, ge=1, le=10000)
    # 긴 글(rich_text) 위젯 depth 별 머리 기호 override.
    #   _d0 = 대표 문장 (depth 0)
    #   _d1 = 상세       (depth 1)
    #   _d2 = 깊은 설명  (depth 2+, 깊은 들여쓰기까지 이어서 사용)
    # 각 필드는 독립적으로 None / 빈 문자열이면 그 depth 만 프런트 기본
    # 글리프(■ / – / ·)로 폴백. 다이얼로그에서 8자로 컷.
    page_rich_text_prefix_d0: Optional[str] = Field(default=None, max_length=8)
    page_rich_text_prefix_d1: Optional[str] = Field(default=None, max_length=8)
    page_rich_text_prefix_d2: Optional[str] = Field(default=None, max_length=8)
    # 보고서별 기본 보기 모드. NULL → 프런트가 개인 전역설정→"paginated" 폴백.
    page_default_view_mode: Optional[Literal["paginated", "all"]] = None
    # Optional report-type tag. `report_type_id` is the raw FK; the
    # embedded `report_type` carries name/description/status so the
    # frontend doesn't need a separate /api/report-types/<id> call.
    report_type_id: Optional[int] = None
    report_type: Optional[ReportTypeRef] = None
    # M:N entity tags (모델/부품/BOM/단계/불량/시험/시뮬레이션). Embedded
    # in slim form so the list/detail page can render chips without a
    # second `/api/entities` lookup. Writes go through the `entity_ids`
    # field on PATCH (below) — this is read-only on the response side.
    entities: list[EntityRefMini] = []
    # "협업 부서" — 함께 일한 조직 워크스페이스 슬러그. 기준정보(엔티티)와 달리
    # 워크스페이스 트리를 직접 참조한다. 이름/색은 프런트가 /api/workspaces 로
    # 해석. 쓰기는 ReportUpdate.collab_workspace_slugs 로. 빈 리스트 = 미지정.
    collab_workspace_slugs: list[str] = []
    created_at: UtcDatetime
    updated_at: UtcDatetime
    # Optimistic-concurrency token. Clients echo this back in PATCH bodies
    # via `expected_revision`; the server bumps it on every successful save.
    revision: int = 1
    # Current edit-lock holder, when one is live. None when no lock row
    # exists OR the row has expired (the schema layer trusts the service
    # to clear stale rows; if it didn't, the timestamp here lets the
    # frontend decide cosmetically).
    edit_lock: Optional[LockInfo] = None
    # Phase 3 — per-actor edit decision. Routes that have an `actor`
    # context fill these in after `model_validate(report)` so the
    # frontend can hide/disable edit affordances without re-implementing
    # the rule. None on listings where the cost of per-row resolution
    # isn't justified (frontend falls back to optimistic show + 403 on
    # save).
    can_edit: Optional[bool] = None
    edit_role: Optional[str] = None
    # 삭제 권한(소유자/시스템관리자/게시판 매니저) — 편집보다 좁다. 프런트가
    # 삭제 버튼 노출을 이 값으로 게이팅한다. None = 비결정(목록).
    can_delete: Optional[bool] = None
    # 소프트삭제(휴지통)·복구 권한 — 소유자/시스템관리자. 평소 "삭제" 버튼은
    # 이 값으로 게이팅(휴지통行). None = 비결정(목록).
    can_trash: Optional[bool] = None
    # 소프트삭제 시각 — 휴지통이면 set, 살아있으면 None. 상세 화면에서 "휴지통에
    # 있음 / 복구" 배너 표시용.
    deleted_at: Optional[UtcDatetime] = None
    # 영구삭제(purge) 가능 — 소유자/시스템관리자 AND 게시 중 아님. 게시 중이면
    # 먼저 게시취소해야 하므로 False. is_mounted 는 그 안내용.
    can_purge: Optional[bool] = None
    is_mounted: Optional[bool] = None
    # 영구삭제 시 cascade 로 함께 사라질 종합보고 안건 수 — 삭제 경고용.
    composite_ref_count: Optional[int] = None
    # 조직 간 공개(조직간공개_설계.md §6) — 외부 공개 열람자 여부와 곁다리
    # 가능 여부. is_public_view=True 면 프런트가 "다른 조직의 공개 보고서 ·
    # 읽기 전용" 배너를 띄우고 댓글/편집/이력 UI 를 숨긴다. can_comment 는
    # 공개 열람자에게 False(멤버 열람자는 평소대로 True). None = 비결정(목록).
    is_public_view: Optional[bool] = None
    can_comment: Optional[bool] = None

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        return _flatten_user_refs(obj)


class ReportPagePreview(BaseModel):
    """Slim per-page entry shipped with list responses so the templates
    column can show every page's binding, not just page 0. content +
    overrides are deliberately omitted to keep the list payload light."""

    model_config = ConfigDict(extra="ignore")

    template_id: str
    template_version: int
    name: Optional[str] = None


class ReportSummary(BaseModel):
    """Lightweight version for list endpoints — content omitted."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    template_id: str
    template_version: int
    title: str
    phase: ReportPhase
    lifecycle: ReportLifecycle
    closed_at: Optional[date] = None
    author_lock_enabled: bool = False
    folder_id: Optional[int] = None
    report_date: date
    owner_user_id: Optional[int]
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    last_edited_by_user_id: Optional[int] = None
    last_edited_by_name: Optional[str] = None
    last_edited_at: Optional[UtcDatetime] = None
    tags: list[str]
    # Per-page template bindings. Pydantic pulls this from the JSONB
    # `pages` column and discards the heavy fields (content, layouts)
    # via ReportPagePreview's extra="ignore".
    pages: list[ReportPagePreview] = []
    # Mirrors ReportRead — kept on the summary so the list page can
    # render the "종류" cell + filter by it without a heavier fetch.
    report_type_id: Optional[int] = None
    report_type: Optional[ReportTypeRef] = None
    # Entity tags — same slim shape as ReportRead. The list page filter
    # bar reads these to render axis-keyed chips per row.
    entities: list[EntityRefMini] = []
    # Org boards this report is mounted to. Empty list = 미게시. Used by
    # the personal-list "게시" cell — flat list of (slug, name) sorted
    # by mounted_at (order driven by Report.mounts.order_by).
    mount_workspaces: list[MountWorkspaceMini] = []
    created_at: UtcDatetime
    updated_at: UtcDatetime
    # 소프트삭제 시각 — 휴지통(trashed=True) 목록에서 "삭제일" 표기용. 살아있는
    # 보고서는 None.
    deleted_at: Optional[UtcDatetime] = None
    # 조직 간 공개 탐색(조직간공개_설계.md §5·§7.2). include_public 탐색에서
    # "내 스코프 밖 + 공개라서 끼어든" 보고서 행을 라우트가 표시한다 — 목록이
    # 자기 게시판 분과 섞이지 않게 프런트가 뱃지/구분을 그린다. 기본 목록은 0.
    is_external_public: bool = False

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        return _flatten_user_refs(obj)


class ReportCreate(BaseModel):
    # Primary template — required and mirrored into pages[0] when `pages`
    # isn't supplied. When `pages` is supplied, page 0 must match these.
    template_id: str = Field(..., min_length=1, max_length=64)
    template_version: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=255)
    # Aggregation reference date. Omit to default to today on the server.
    report_date: Optional[date] = None
    # Collaboration phase. Omit to land in `drafting`. Most callers should
    # never set this directly — phase is driven by automatic triggers
    # (first external comment, mount-to-org-board) and by the publish /
    # unpublish actions, not by report-create payloads.
    phase: Optional[ReportPhase] = None
    # Work lifecycle hint. Omit to default `single_shot`.
    lifecycle: Optional[ReportLifecycle] = None
    tags: list[str] = []
    # Legacy single-page fields — applied to page 0 when `pages` is None.
    content: dict = {}
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    # New multi-page payload. When provided, takes precedence over the
    # legacy single-page fields.
    pages: Optional[list[ReportPage]] = None
    # Per-report content max-width in pixels. None → frontend default.
    page_width_px: Optional[int] = Field(default=None, ge=320, le=3000)
    # Per-report vertical gap (px) between top-level widget rows. None →
    # frontend default.
    page_gap_px: Optional[int] = Field(default=None, ge=0, le=200)
    # Per-report container blending toggle. None → default bordered cards.
    page_blend_blocks: Optional[bool] = None
    # PPT 슬라이드 가이드 (ReportRead 의 동명 필드 참고). 새 보고서는
    # 보통 가이드 OFF 로 시작하므로 모두 None 으로 둠.
    page_slide_guide: Optional[bool] = None
    page_slide_ratio: Optional[Literal["16:9", "4:3", "16:10", "custom"]] = None
    page_slide_ratio_custom_w: Optional[int] = Field(default=None, ge=1, le=10000)
    page_slide_ratio_custom_h: Optional[int] = Field(default=None, ge=1, le=10000)
    # 긴 글 depth 별 머리 기호 override (_d0/_d1/_d2 = 대표/상세/깊은).
    # 각 필드 None/빈 문자열이면 그 depth 만 프런트 기본 글리프로 폴백.
    page_rich_text_prefix_d0: Optional[str] = Field(default=None, max_length=8)
    page_rich_text_prefix_d1: Optional[str] = Field(default=None, max_length=8)
    page_rich_text_prefix_d2: Optional[str] = Field(default=None, max_length=8)
    # 보고서별 기본 보기 모드 ("paginated"/"all"). 미지정이면 NULL.
    page_default_view_mode: Optional[Literal["paginated", "all"]] = None
    # Optional FK to a report_types row. Created via the picker dialog;
    # may be null (no tag).
    report_type_id: Optional[int] = None
    # Optional list of Entity ids to tag this new report with. When
    # omitted the report starts with no tags; when supplied each id is
    # validated by the entities service (must exist; deprecated is OK).
    entity_ids: Optional[list[int]] = None
    # "협업 부서" 워크스페이스 슬러그 — 생략 시 빈 목록으로 시작.
    collab_workspace_slugs: Optional[list[str]] = None


class ReportCopy(BaseModel):
    """Duplicate an existing report into the caller's personal space.

    `mode` decides how much travels with the copy:
      * ``content`` — 본문(pages/내용/레이아웃) + 표시 설정(폭·간격·슬라이드
        가이드·머리기호)만. 부가 정보는 떼고 깔끔한 사본.
      * ``full`` — 위 + 메타데이터: 태그, 보고서 종류, 엔티티 태그,
        lifecycle, 그리고 원본이 *나가는* 방향으로 건 연결(report_links).
      * ``summary`` — ``content`` 처럼 본문만 복사하되, 새(요약) 보고서를
        원본과 'summary' kind 로 연결(요약↔원본). 두 보고서 상세에 관계가 보인다.
    어느 모드든 게시·댓글·이력 등 인스턴스 고유 데이터는 따라오지 않는다
    (사본은 새 개인 초안). 작성일은 항상 오늘.
    """

    title: str = Field(..., min_length=1, max_length=255)
    folder_id: Optional[int] = None
    mode: Literal["content", "full", "summary"] = "full"


class ReportUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    # Direct phase set is allowed but expected to be rare — most phase
    # transitions are driven by side-effects (auto-transition on first
    # external comment, mount/unmount) or by dedicated /publish endpoints.
    # Surface in the UI only via the "강제로 작성/리뷰 모드로" debug menu.
    phase: Optional[ReportPhase] = None
    lifecycle: Optional[ReportLifecycle] = None
    closed_at: Optional[date] = None
    folder_id: Optional[int] = None
    report_date: Optional[date] = None
    tags: Optional[list[str]] = None
    # Legacy single-page fields — when supplied, applied to page 0 (and the
    # rest of the pages stay untouched). Frontend multi-page clients should
    # send `pages` instead.
    content: Optional[dict] = None
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    pages: Optional[list[ReportPage]] = None
    # Per-report content max-width in pixels. None resets to the frontend
    # default; an integer (320–3000) sets the cap.
    page_width_px: Optional[int] = Field(default=None, ge=320, le=3000)
    # Per-report vertical gap (px) between top-level widget rows. None
    # resets to the frontend default; an integer (0–200) sets the gap.
    page_gap_px: Optional[int] = Field(default=None, ge=0, le=200)
    # Container blending toggle. None resets to default (False); True hides
    # widget card chrome so the page reads as one continuous surface.
    page_blend_blocks: Optional[bool] = None
    # PPT 슬라이드 가이드. 4개 필드 모두 None 이면 가이드 OFF.
    # exclude_unset 으로 PATCH 처리되므로, 가이드를 끄려면 클라이언트가
    # page_slide_guide=False (또는 None) 을 명시적으로 보내야 한다.
    page_slide_guide: Optional[bool] = None
    page_slide_ratio: Optional[Literal["16:9", "4:3", "16:10", "custom"]] = None
    page_slide_ratio_custom_w: Optional[int] = Field(default=None, ge=1, le=10000)
    page_slide_ratio_custom_h: Optional[int] = Field(default=None, ge=1, le=10000)
    # 긴 글 depth 별 머리 기호 override (_d0/_d1/_d2 = 대표/상세/깊은).
    # 각 필드 None / 빈 문자열을 보내면 그 depth 만 기본 글리프로 리셋,
    # 비어 있지 않은 문자열이면 해당 값으로 교체.
    page_rich_text_prefix_d0: Optional[str] = Field(default=None, max_length=8)
    page_rich_text_prefix_d1: Optional[str] = Field(default=None, max_length=8)
    page_rich_text_prefix_d2: Optional[str] = Field(default=None, max_length=8)
    # 보고서별 기본 보기 모드. exclude_unset 으로 처리되므로 키를 보내면
    # 갱신, 안 보내면 기존값 유지(다른 page_* 와 동일).
    page_default_view_mode: Optional[Literal["paginated", "all"]] = None
    # Optional report-type FK. The field is consulted via model_dump's
    # `exclude_unset` so an explicit `null` clears the tag while an
    # absent key leaves the existing value alone.
    report_type_id: Optional[int] = None
    # Full replacement set of entity tags. `None`/absent = leave existing
    # tags alone; `[]` = clear all tags. Picker UIs always send the full
    # current set (not a delta), which keeps server-side reconciliation
    # trivial and avoids "lost update" races between concurrent edits.
    entity_ids: Optional[list[int]] = None
    # 협업 부서 워크스페이스 슬러그의 전체 교체 집합. None/absent = 기존 유지,
    # [] = 전부 해제. 엔티티 태그와 동일하게 항상 현재 전체 집합을 보낸다.
    collab_workspace_slugs: Optional[list[str]] = None
    # Optimistic-concurrency token: the revision the client thinks is
    # current. The service compares against the server's value and rejects
    # the PATCH with revision_mismatch if they differ. Optional so the
    # field can roll out without breaking older clients, but the frontend
    # is expected to send it on every save.
    expected_revision: Optional[int] = Field(default=None, ge=1)


# ───────────────────────────────────────────────────────────────────────── #
# Report links                                                              #
# ───────────────────────────────────────────────────────────────────────── #


class ReportLinkRefMini(BaseModel):
    """링크 카드 한 줄을 그릴 때 필요한 최소 정보 — 상대 보고서 쪽.

    workspace_slug 는 프론트가 ``/w/{slug}/reports/{id}`` 라우트를 만들
    때 필요. 없으면 링크가 잘못된 주소로 가게 된다.
    """

    id: int
    workspace_slug: str
    title: str
    owner_name: Optional[str] = None
    report_date: Optional[date] = None


class ReportLinkRead(BaseModel):
    """단방향 link 한 줄. ``direction`` 이 outgoing / incoming 인지에 따라
    프론트는 forward_label / reverse_label 중 하나를 골라 표시한다."""

    id: int
    kind: str
    note: Optional[str] = None
    direction: Literal["outgoing", "incoming"]
    # 화면 카드에 그릴 상대 보고서 (outgoing 이면 to, incoming 이면 from).
    counterpart: ReportLinkRefMini
    created_at: UtcDatetime
    created_by_name: Optional[str] = None


class ReportLinkCreate(BaseModel):
    """현재 보고서 (URL path 의 보고서) 와 ``to_report_id`` 사이 link 생성.

    ``direction`` 으로 단방향 저장 방향을 결정 — 양쪽 모두 자신의 보고서
    화면에서 ``forward_label`` 로 부르며 link 를 등록할 수 있게 하려는 것:
      - outgoing (기본): from = path 의 보고서, to = ``to_report_id``
                         ("이 보고서 → 다른 보고서" — 예: "후속")
      - incoming       : from = ``to_report_id``, to = path 의 보고서
                         ("다른 보고서 → 이 보고서" — 예: "선행")

    DB 에는 같은 row 가 한 번만 들어가고, 보는 쪽에 따라 forward/reverse
    라벨이 자동으로 갈라진다. 권한 검사는 양쪽 모두 *path 의 보고서* 쪽
    can_edit 만 본다 — 사용자가 보고 있는 자기 보고서에 대한 link 정리
    권한은 자기 손에 있다는 게 자연스럽기 때문.
    """

    to_report_id: int
    kind: str
    note: Optional[str] = Field(default=None, max_length=200)
    direction: Literal["outgoing", "incoming"] = "outgoing"


# ───────────────────────────────────────────────────────────────────────── #
# Link graph — 보고서 관계도 (지식그래프 Phase 1a)                            #
# ───────────────────────────────────────────────────────────────────────── #


class LinkGraphNode(BaseModel):
    """관계도의 노드 하나. ``id`` 는 react-force-graph 가 쓰는 unique
    string ("report:123" / "entity:9") — report 와 entity 가 같은 숫자
    id 를 가져도 충돌하지 않게 ``type:numericId`` 형태를 쓴다.

    report 노드는 ``report_id``/``title``/``workspace_slug`` 를, entity 노드
    (Phase 2 관련정보 레이어)는 ``entity_id``/``label``/``axis`` 를 채운다.
    type 으로 갈라 프론트가 모양·색·클릭 동작을 다르게 준다."""

    id: str
    type: Literal["report", "entity", "composite"] = "report"
    degree: int = 0  # 연결 수 — 노드 크기 매핑

    # ── report 노드 전용 ────────────────────────────────────────────────
    report_id: Optional[int] = None  # 클릭 시 보고서 라우팅용 raw id
    title: Optional[str] = None
    owner_name: Optional[str] = None
    workspace_slug: Optional[str] = None
    report_type_id: Optional[int] = None  # 색 매핑(종류) — id 만 무비용 동봉
    report_date: Optional[date] = None
    is_center: bool = False  # 중심 보고서 강조(로컬 모달)
    # 조직 간 공개(조직간공개_설계.md §7.2). 내 스코프 밖이지만 공개로 보이는
    # "다른 조직의 공개 보고서" 노드 — 프런트가 외곽선/색으로 구분한다.
    is_external_public: bool = False
    # 부서 관계도에서 primary 스코프(이 부서/하위 게시분) 밖인데 링크로 끌려온
    # 외부 보고서(include_external). 프런트가 흐리게/점선으로 구분한다.
    is_out_of_scope: bool = False

    # ── entity 노드 전용 (관련정보 레이어) ──────────────────────────────
    entity_id: Optional[int] = None
    label: Optional[str] = None  # entity 값 (예: "모델X")
    axis: Optional[str] = None  # entity_type.slug (예: "model")
    axis_label: Optional[str] = None  # entity_type.label (예: "모델명")

    # ── composite 노드 전용 (종합보고 hub, Phase 4) ─────────────────────
    composite_id: Optional[int] = None
    composite_kind: Optional[str] = None  # recurring / theme


class LinkGraphEdge(BaseModel):
    """단방향 link 한 개. force-graph 기본 accessor 에 맞춰 source/target.
    ``kind`` 는 report_link_kinds 카탈로그의 key (프론트가 색 매핑) 또는
    관련정보 레이어의 ``"has_tag"`` (report → entity, 회색 고정)."""

    source: str
    target: str
    kind: str


class LinkGraphResponse(BaseModel):
    nodes: list[LinkGraphNode] = []
    edges: list[LinkGraphEdge] = []
    # max_nodes 에 걸려 일부만 담긴 경우 True — 프론트가 안내 배지를 띄움.
    truncated: bool = False
    # 모달을 연 중심 보고서의 노드 id ("report:123"). 글로벌 그래프(1b)에선
    # None.
    center_id: Optional[str] = None


# ───────────────────────────────────────────────────────────────────────── #
# Report link kinds (admin-managed catalog)                                 #
# ───────────────────────────────────────────────────────────────────────── #


class ReportLinkKindRead(BaseModel):
    """일반 사용자 / admin 양쪽이 같은 모양 — admin UI 도 system_locked 만
    추가로 본다 (disable 표시용)."""

    model_config = ConfigDict(from_attributes=True)

    key: str
    forward_label: str
    reverse_label: str
    color: str
    sort_order: int = 0
    system_locked: bool = False


class ReportLinkKindCreate(BaseModel):
    # 영문 snake_case 강제 — 새 kind 가 URL safe 이고 prefix 충돌이 없도록.
    key: str = Field(..., min_length=2, max_length=32, pattern=r"^[a-z][a-z0-9_]*$")
    forward_label: str = Field(..., min_length=1, max_length=40)
    reverse_label: str = Field(..., min_length=1, max_length=40)
    color: str = Field(..., min_length=1, max_length=16)
    sort_order: int = 0


class ReportLinkKindUpdate(BaseModel):
    """key 와 system_locked 는 immutable. 나머지만 PATCH 가능."""

    forward_label: Optional[str] = Field(default=None, min_length=1, max_length=40)
    reverse_label: Optional[str] = Field(default=None, min_length=1, max_length=40)
    color: Optional[str] = Field(default=None, min_length=1, max_length=16)
    sort_order: Optional[int] = None


class ReportVersionMeta(BaseModel):
    """버전(스냅샷) 메타 — 타임라인 목록·미리보기 헤더용. 본문(body)은 제외."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    seq: int
    revision: int
    author_user_id: Optional[int] = None
    author_name: Optional[str] = None  # 라우트에서 채움
    source: str
    created_at: UtcDatetime
    body_bytes: int
    label: Optional[str] = None
    is_pinned: bool


class AiDraftCreate(BaseModel):
    """AI(Claude)가 보고서를 초안으로 만들 때의 입력 — 느슨한 블록(block_id→간이
    콘텐츠)을 ai_authoring.normalize_content 가 widget-v1 로 정규화한다."""

    template_id: str = Field(..., min_length=1, max_length=64)
    template_version: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=255)
    blocks: dict = Field(default_factory=dict)
    # AI 가 **직접 정의해 추가하는** 위젯들 — 빈 템플릿이거나 템플릿에 없는 위젯이
    # 필요할 때. 각 항목: {id, type, props?, content}. (block_id→content 인 blocks 와
    # 달리 위젯 자체를 만든다.) ai_authoring.normalize_extra_blocks 가 처리.
    extra_blocks: list[dict] = Field(default_factory=list)
    # 단락 구분 — {block_id: section_code}. code 는 describe_template 의
    # section_taxonomy 에 있는 값만(없는 코드/그 페이지에 없는 블록은 무시).
    block_sections: dict[str, Optional[str]] = Field(default_factory=dict)
    # 여러 페이지로 만들 때 — 각 항목 {name?, blocks?, extra_blocks?, block_sections?}.
    # 모두 같은 template_id/version 을 쓴다. 비어 있으면 위 단일 페이지 필드로 1쪽 생성.
    pages: list[dict] = Field(default_factory=list)
    # ── 메타데이터(선택) — 일반 생성과 동일하게 적용된다. describe_metadata 로
    #    유효한 report_type_id / entity_ids 를 조회해 쓴다. ───────────────────
    report_date: Optional[date] = None  # 보고 일자. 미지정 시 서버 기본(오늘).
    tags: Optional[list[str]] = None  # 자유 태그.
    report_type_id: Optional[int] = None  # 보고서 유형 id.
    entity_ids: Optional[list[int]] = None  # 모델/단계/부품 등 축 태그 id 목록.


class AiDraftUpdate(BaseModel):
    """AI(Claude)가 **기존 초안**을 이어서 수정할 때의 입력. 본인이 만든 `drafting`
    상태의 보고서만 대상. 기본은 **병합(merge)** — 준 블록만 덮어쓰고 나머지는 둔다.

    - 병합 모드(`pages` 미지정): `blocks`/`extra_blocks`/`block_sections` 를 `page`(1-base)
      페이지에 병합. `remove_blocks` 로 블록 제거. 안 건드린 블록·수동 레이아웃은 유지
      (블록 구성이 바뀐 경우에만 자동 재배치).
    - 전체 교체 모드(`pages` 지정): 보고서를 그 페이지 목록으로 통째 다시 만든다(생성과 동일).
    """

    # None 이면 제목 유지. 빈 문자열은 거부(min_length=1).
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    blocks: dict = Field(default_factory=dict)
    extra_blocks: list[dict] = Field(default_factory=list)
    block_sections: dict[str, Optional[str]] = Field(default_factory=dict)
    # 제거할 block_id 목록(템플릿 블록·extra_blocks 둘 다). content/order/단락에서 뺀다.
    remove_blocks: list[str] = Field(default_factory=list)
    # 병합 대상 페이지(1-base). 멀티페이지 보고서에서 특정 페이지를 고칠 때.
    page: int = Field(default=1, ge=1)
    # 전체 교체 — 주면 위 병합 필드는 무시되고 보고서를 이 페이지들로 다시 만든다.
    # 각 항목 {name?, blocks?, extra_blocks?, block_sections?}.
    pages: Optional[list[dict]] = None
    # ── 메타데이터(선택) — None 이면 해당 항목 유지. 내용 병합/교체와 독립적으로
    #    적용된다(메타만 바꾸려면 blocks 없이 메타 필드만 줘도 됨). ───────────────
    report_date: Optional[date] = None
    tags: Optional[list[str]] = None
    report_type_id: Optional[int] = None
    # 빈 리스트([])면 모든 엔티티 태그 제거, None 이면 유지.
    entity_ids: Optional[list[int]] = None
