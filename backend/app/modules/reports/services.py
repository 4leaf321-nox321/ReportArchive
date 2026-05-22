"""Business logic for reports — workspace scoping + widget-v1 validation."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable, Optional

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.modules.reports.models import Report, ReportEditLock
from app.modules.reports.schemas import ReportCreate, ReportPage, ReportUpdate
from app.modules.templates import services as template_services
from app.modules.workspaces import services as ws_services
from app.widgets import (
    validate_layout_overrides as _validate_layout_overrides,
    validate_report_content as _validate_widget_v1_content,
)

# How long a lock survives without a heartbeat. Pairs with the frontend's
# 30s heartbeat (4x margin so a single dropped beat doesn't lose the lock).
LOCK_TTL = timedelta(seconds=120)


# --------------------------------------------------------------------------- #
# Edit-lock errors                                                            #
# --------------------------------------------------------------------------- #


class LockError(Exception):
    """Base class so the route layer can map any lock failure to 409.
    Subclasses carry a stable `code` string for the JSON error body — the
    frontend dispatches on this to choose the right UX (takeover dialog,
    refresh prompt, etc.)."""

    code: str = "lock_error"

    def __init__(self, message: str, *, holder: Optional[ReportEditLock] = None):
        super().__init__(message)
        self.holder = holder


class LockHeldByOtherError(LockError):
    """acquire_lock found a live lock owned by a different user. Caller can
    retry with `force=True` to take over."""

    code = "lock_held_by_other"


class LockNotHeldError(LockError):
    """The caller doesn't currently hold a live lock — either it expired,
    it was never acquired, or someone else took it over. Surfaces on
    heartbeat / release / save attempts."""

    code = "lock_not_held"


class RevisionMismatchError(LockError):
    """Caller's `expected_revision` doesn't match the row. Used as the
    optimistic safety net for the narrow window between forced takeover
    and the prior holder's stale save."""

    code = "revision_mismatch"


def list_reports_in_workspace(
    db: Session,
    workspace_slug: str,
    *,
    is_global_view: bool = False,
) -> list[Report]:
    """Returns reports scoped to the workspace tree.

    For non-leaf workspaces, this includes all descendants. The virtual
    `_global` workspace bypasses scoping (admin/横断 view).
    """
    query = select(Report).order_by(desc(Report.updated_at))
    if not is_global_view:
        scope = ws_services.get_descendants_inclusive(db, workspace_slug)
        query = query.where(Report.workspace_slug.in_(scope))
    return list(db.execute(query).scalars())


def get_report(db: Session, report_id: int) -> Optional[Report]:
    return db.get(Report, report_id)


def is_visible_to(db: Session, report: Report, workspace_slug: str) -> bool:
    """Workspace tree visibility check — actor's workspace must be an ancestor
    of the report's workspace (or the same)."""
    scope = ws_services.get_descendants_inclusive(db, workspace_slug)
    return report.workspace_slug in scope


def _validate_page(db: Session, page: ReportPage) -> None:
    """Validate a single page's content + layout against its own template
    plus any per-page extra blocks the report added."""
    template = template_services.get_template(db, page.template_id, page.template_version)
    if not template:
        raise ValueError(
            f"Template not found: {page.template_id}@{page.template_version}"
        )
    if page.content:
        _validate_widget_v1_content(
            template.schema,
            page.content,
            extra_blocks=page.extra_blocks,
            props_overrides=page.props_overrides,
        )
    if page.layout_overrides:
        # Layout overrides may reference extra-block ids too; pass them
        # through as a synthetic schema so the validator accepts them.
        combined = _schema_with_extras(template.schema, page.extra_blocks)
        # When the page hides some template blocks via blocks_order, those
        # blocks aren't actually rendered — so their layouts should NOT
        # constrain the col_span row sums. Filter them out before passing
        # to the layout validator. (Validation already enforces that
        # blocks_order entries are known ids; we trust it here.)
        if page.blocks_order:
            order_set = set(page.blocks_order)
            combined = {
                **combined,
                "blocks": [
                    b for b in combined.get("blocks", []) if b["id"] in order_set
                ],
            }
        _validate_layout_overrides(combined, page.layout_overrides)
    if page.blocks_order:
        template_ids = {b["id"] for b in template.schema.get("blocks", [])}
        extra_ids = {b["id"] for b in page.extra_blocks or []}
        known = template_ids | extra_ids
        seen: set[str] = set()
        for bid in page.blocks_order:
            if not isinstance(bid, str):
                raise ValueError("blocks_order entries must be strings.")
            if bid not in known:
                raise ValueError(
                    f"blocks_order references unknown block id: {bid!r}"
                )
            if bid in seen:
                raise ValueError(f"blocks_order has duplicate id: {bid!r}")
            seen.add(bid)


def _schema_with_extras(template_schema: dict, extra_blocks: list[dict]) -> dict:
    """Returns a synthetic widget-v1 schema with the template's blocks +
    the page's extra_blocks. Used by validators that only know how to look
    up blocks by id on a single schema document."""
    if not extra_blocks:
        return template_schema
    return {
        **template_schema,
        "blocks": [*template_schema.get("blocks", []), *extra_blocks],
    }


def _validate_pages(db: Session, pages: Iterable[ReportPage]) -> None:
    pages = list(pages)
    if not pages:
        raise ValueError("Report must have at least one page")
    for page in pages:
        _validate_page(db, page)


def _normalize_overrides(overrides: dict | None) -> dict | None:
    """Treat empty dicts as None so the DB stays clean."""
    if not overrides:
        return None
    return overrides


def _sanitize_props_overrides(overrides: dict | None) -> dict | None:
    """Per-report prop overrides applied on top of the template's blocks.
    Previously locked to visual-style keys (text_style / depth_styles)
    only; now accepts any prop dict so the report writer can configure
    structural settings (table columns, KV items, etc.) on a per-report
    basis. The content validator below uses the effective (template ∪
    override) props when checking shape, so a structural override that
    invalidates existing content surfaces as a 400 at save time.

    Shape in/out: { "<block_id>": { any prop keys }, ... }
    Empty per-block dicts are pruned; an entirely empty result collapses
    to None to keep DB rows lean.
    """
    if not overrides or not isinstance(overrides, dict):
        return None
    out: dict[str, dict] = {}
    for block_id, raw in overrides.items():
        if not isinstance(block_id, str) or not isinstance(raw, dict):
            continue
        if raw:
            out[block_id] = raw
    return out or None


def _pages_to_jsonb(pages: list[ReportPage]) -> list[dict]:
    """Serialize ReportPage list into the JSONB shape stored on `Report.pages`.
    Empty `layout_overrides` is normalized to None to match the single-page
    column's convention."""
    return [
        {
            "template_id": p.template_id,
            "template_version": p.template_version,
            "name": (p.name or None),
            "content": p.content or {},
            "layout_overrides": _normalize_overrides(p.layout_overrides),
            "props_overrides": _sanitize_props_overrides(p.props_overrides),
            "extra_blocks": list(p.extra_blocks or []),
            "blocks_order": list(p.blocks_order or []),
            "block_sections": dict(p.block_sections or {}),
        }
        for p in pages
    ]


def _resolve_pages_for_create(payload: ReportCreate) -> list[ReportPage]:
    """Build the canonical page list for a create payload.

    If the client sent `pages`, use it verbatim (but enforce page 0 matches
    the top-level template — they're meant to be in sync). Otherwise
    synthesize a single page from the legacy single-template fields.
    """
    if payload.pages is not None:
        if not payload.pages:
            raise ValueError("`pages` cannot be empty")
        first = payload.pages[0]
        if (
            first.template_id != payload.template_id
            or first.template_version != payload.template_version
        ):
            raise ValueError(
                "pages[0] template must match the report's top-level template"
            )
        return list(payload.pages)
    return [
        ReportPage(
            template_id=payload.template_id,
            template_version=payload.template_version,
            content=payload.content or {},
            layout_overrides=payload.layout_overrides,
            props_overrides=payload.props_overrides,
        )
    ]


def create_report(
    db: Session,
    workspace_slug: str,
    payload: ReportCreate,
    owner_user_id: int,
) -> Report:
    pages = _resolve_pages_for_create(payload)
    _validate_pages(db, pages)

    page0 = pages[0]
    init_kwargs: dict = dict(
        workspace_slug=workspace_slug,
        template_id=page0.template_id,
        template_version=page0.template_version,
        title=payload.title,
        tags=list(payload.tags or []),
    )
    # Only pass report_date when the client explicitly supplied one;
    # leaving it out lets the column's CURRENT_DATE default fill in.
    if payload.report_date is not None:
        init_kwargs["report_date"] = payload.report_date
    if payload.status is not None:
        init_kwargs["status"] = payload.status
    if payload.page_width_px is not None:
        init_kwargs["page_width_px"] = payload.page_width_px
    if payload.page_gap_px is not None:
        init_kwargs["page_gap_px"] = payload.page_gap_px
    if payload.report_type_id is not None:
        init_kwargs["report_type_id"] = payload.report_type_id
    report = Report(
        **init_kwargs,
        content=page0.content or {},
        layout_overrides=_normalize_overrides(page0.layout_overrides),
        props_overrides=_sanitize_props_overrides(page0.props_overrides),
        pages=_pages_to_jsonb(pages),
        owner_user_id=owner_user_id,
        # On a fresh report the creator is also the last editor — keeps
        # the column non-null so the UI never has to render "수정인: —"
        # for never-edited rows.
        updated_by_user_id=owner_user_id,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


# --------------------------------------------------------------------------- #
# Edit lock — pessimistic, per-report, with TTL                               #
# --------------------------------------------------------------------------- #


def get_active_lock(
    db: Session, report: Report, *, now: Optional[datetime] = None
) -> Optional[ReportEditLock]:
    """Returns the lock row only if it's still live (not past expires_at).
    Returns None when there's no row, or the row exists but has expired —
    callers should treat both cases identically (no current holder).
    """
    now = now or datetime.utcnow()
    lock = report.edit_lock
    if lock is None:
        return None
    if lock.expires_at <= now:
        return None
    return lock


def acquire_lock(
    db: Session,
    report: Report,
    user_id: int,
    *,
    force: bool = False,
) -> ReportEditLock:
    """Claim the edit lock for `user_id`. Idempotent for the current holder
    (just refreshes the TTL), takes over expired locks automatically, and
    rejects live locks held by a different user unless `force=True`.

    Returns the (live) lock row. Caller is responsible for committing the
    session — this function flushes so the lock row is visible inside the
    same transaction as any follow-up reads.
    """
    now = datetime.utcnow()
    expires = now + LOCK_TTL
    existing = report.edit_lock
    if existing is not None and existing.expires_at > now and existing.user_id != user_id and not force:
        raise LockHeldByOtherError(
            "Report is currently being edited by another user.",
            holder=existing,
        )
    if existing is None:
        lock = ReportEditLock(
            report_id=report.id,
            user_id=user_id,
            acquired_at=now,
            expires_at=expires,
        )
        db.add(lock)
        report.edit_lock = lock
    else:
        # Same user refreshing, or force-takeover, or expired-and-reclaimed
        # — all three converge on "rewrite the row in place".
        existing.user_id = user_id
        existing.acquired_at = now
        existing.expires_at = expires
        lock = existing
    db.flush()
    return lock


def heartbeat_lock(
    db: Session, report: Report, user_id: int
) -> ReportEditLock:
    """Extend the TTL of an already-held lock. Fails if the caller doesn't
    own a live lock — that's the signal to the frontend that someone took
    over or the session expired, and the user should bail out of edit mode."""
    now = datetime.utcnow()
    lock = report.edit_lock
    if lock is None or lock.expires_at <= now or lock.user_id != user_id:
        raise LockNotHeldError(
            "Edit lock is no longer held by this user.",
            holder=lock if (lock is not None and lock.expires_at > now) else None,
        )
    lock.expires_at = now + LOCK_TTL
    db.flush()
    return lock


def release_lock(db: Session, report: Report, user_id: int) -> None:
    """Drop the lock if (and only if) `user_id` currently holds it. No-op
    when the lock is absent, expired, or held by someone else — releases
    must not be able to clobber another editor's session."""
    lock = report.edit_lock
    if lock is None:
        return
    now = datetime.utcnow()
    if lock.user_id != user_id or lock.expires_at <= now:
        return
    db.delete(lock)
    report.edit_lock = None
    db.flush()


def _require_lock_for_update(
    report: Report, user_id: int
) -> None:
    """Pre-check for update_report: caller must currently hold the lock.
    Raised before any DB mutation so a forced takeover (or expired lock)
    bails out without a partial write."""
    now = datetime.utcnow()
    lock = report.edit_lock
    if lock is None or lock.expires_at <= now or lock.user_id != user_id:
        raise LockNotHeldError(
            "You no longer hold the edit lock for this report. "
            "Reload to see the current state.",
            holder=lock if (lock is not None and lock.expires_at > now) else None,
        )


def update_report(
    db: Session,
    report: Report,
    payload: ReportUpdate,
    *,
    updated_by_user_id: Optional[int] = None,
    expected_revision: Optional[int] = None,
    require_lock: bool = True,
) -> Report:
    # Concurrency gates — both must pass before we touch anything. Lock
    # check first because a takeover invalidates revision assumptions too.
    if require_lock and updated_by_user_id is not None:
        _require_lock_for_update(report, updated_by_user_id)
    if expected_revision is not None and report.revision != expected_revision:
        raise RevisionMismatchError(
            f"Report has been modified by someone else "
            f"(client revision {expected_revision}, server revision {report.revision}).",
        )

    data = payload.model_dump(exclude_unset=True)

    # Resolve the new page list. Either the client sent the full `pages`
    # array (multi-page-aware), or they sent the legacy single-page
    # content / layout_overrides which we apply to page 0 in place.
    new_pages: Optional[list[ReportPage]] = None
    if "pages" in data:
        if not payload.pages:
            raise ValueError("`pages` cannot be empty")
        new_pages = list(payload.pages)
    elif "content" in data or "layout_overrides" in data or "props_overrides" in data:
        existing = list(report.pages or [])
        if not existing:
            # Defensive: should never happen post-migration, but keep
            # legacy updates working even on rows that pre-date it.
            existing = [
                {
                    "template_id": report.template_id,
                    "template_version": report.template_version,
                    "content": report.content or {},
                    "layout_overrides": report.layout_overrides,
                    "props_overrides": report.props_overrides,
                }
            ]
        # Mutate page 0 from legacy fields.
        page0 = dict(existing[0])
        if "content" in data:
            page0["content"] = data["content"] or {}
        if "layout_overrides" in data:
            page0["layout_overrides"] = _normalize_overrides(data["layout_overrides"])
        if "props_overrides" in data:
            page0["props_overrides"] = _sanitize_props_overrides(data["props_overrides"])
        existing[0] = page0
        new_pages = [ReportPage(**p) for p in existing]

    if new_pages is not None:
        _validate_pages(db, new_pages)
        page0 = new_pages[0]
        report.template_id = page0.template_id
        report.template_version = page0.template_version
        report.content = page0.content or {}
        report.layout_overrides = _normalize_overrides(page0.layout_overrides)
        report.props_overrides = _sanitize_props_overrides(page0.props_overrides)
        report.pages = _pages_to_jsonb(new_pages)

    # Apply non-page scalar fields. `report_type_id` is included so the
    # picker can both set and clear (explicit None) the tag in one PATCH.
    for key in ("title", "status", "report_date", "tags", "page_width_px", "page_gap_px", "report_type_id"):
        if key in data:
            setattr(report, key, data[key])

    # Stamp the last-editor. Done on every successful update path; routes
    # always pass the actor id so this never silently goes None.
    if updated_by_user_id is not None:
        report.updated_by_user_id = updated_by_user_id

    # Bump optimistic-concurrency counter. Every successful save advances
    # this, so any in-flight PATCH from a stale tab will hit
    # RevisionMismatchError on its next attempt.
    report.revision = (report.revision or 1) + 1

    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, report: Report) -> None:
    db.delete(report)
    db.commit()
