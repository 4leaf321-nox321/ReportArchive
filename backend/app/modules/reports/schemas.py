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
    (edit_policy, mounted_by, note, folder_id) is fetchable via /api/mounts."""

    slug: str
    name: str


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
    # Optional FK to a report_types row. Created via the picker dialog;
    # may be null (no tag).
    report_type_id: Optional[int] = None
    # Optional list of Entity ids to tag this new report with. When
    # omitted the report starts with no tags; when supplied each id is
    # validated by the entities service (must exist; deprecated is OK).
    entity_ids: Optional[list[int]] = None


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
    # Optional report-type FK. The field is consulted via model_dump's
    # `exclude_unset` so an explicit `null` clears the tag while an
    # absent key leaves the existing value alone.
    report_type_id: Optional[int] = None
    # Full replacement set of entity tags. `None`/absent = leave existing
    # tags alone; `[]` = clear all tags. Picker UIs always send the full
    # current set (not a delta), which keeps server-side reconciliation
    # trivial and avoids "lost update" races between concurrent edits.
    entity_ids: Optional[list[int]] = None
    # Optimistic-concurrency token: the revision the client thinks is
    # current. The service compares against the server's value and rejects
    # the PATCH with revision_mismatch if they differ. Optional so the
    # field can roll out without breaking older clients, but the frontend
    # is expected to send it on every save.
    expected_revision: Optional[int] = Field(default=None, ge=1)
