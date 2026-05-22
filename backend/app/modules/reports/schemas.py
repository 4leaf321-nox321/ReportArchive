"""Pydantic schemas for reports."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Annotated, Any, Optional

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, model_validator
from sqlalchemy import inspect as sa_inspect

from app.modules.report_types.models import ReportTypeStatus
from app.modules.reports.models import ReportStatus


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
    status: ReportStatus
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
    tags: list[str]
    content: dict
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    pages: list[ReportPage] = []
    # Per-report max content width in pixels. None → frontend uses its
    # narrow default (~1024px). Set via the report's empty-area right-click
    # menu; capped client-side at 3000.
    page_width_px: Optional[int] = Field(default=None, ge=320, le=3000)
    # Optional report-type tag. `report_type_id` is the raw FK; the
    # embedded `report_type` carries name/description/status so the
    # frontend doesn't need a separate /api/report-types/<id> call.
    report_type_id: Optional[int] = None
    report_type: Optional[ReportTypeRef] = None
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
    status: ReportStatus
    report_date: date
    owner_user_id: Optional[int]
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    tags: list[str]
    # Per-page template bindings. Pydantic pulls this from the JSONB
    # `pages` column and discards the heavy fields (content, layouts)
    # via ReportPagePreview's extra="ignore".
    pages: list[ReportPagePreview] = []
    # Mirrors ReportRead — kept on the summary so the list page can
    # render the "종류" cell + filter by it without a heavier fetch.
    report_type_id: Optional[int] = None
    report_type: Optional[ReportTypeRef] = None
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
    # Work-state status. Omit to land in `draft` (작성 중).
    status: Optional[ReportStatus] = None
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
    # Optional FK to a report_types row. Created via the picker dialog;
    # may be null (no tag).
    report_type_id: Optional[int] = None


class ReportUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    status: Optional[ReportStatus] = None
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
    # Optional report-type FK. The field is consulted via model_dump's
    # `exclude_unset` so an explicit `null` clears the tag while an
    # absent key leaves the existing value alone.
    report_type_id: Optional[int] = None
    # Optimistic-concurrency token: the revision the client thinks is
    # current. The service compares against the server's value and rejects
    # the PATCH with revision_mismatch if they differ. Optional so the
    # field can roll out without breaking older clients, but the frontend
    # is expected to send it on every save.
    expected_revision: Optional[int] = Field(default=None, ge=1)
