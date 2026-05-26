"""Business logic for composite reports."""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.modules.composites.models import (
    CompositeKind,
    CompositeReport,
    CompositeReportItem,
)
from app.modules.composites.schemas import (
    CompositeItemPayload,
    CompositeReportCreate,
    CompositeReportUpdate,
)
from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.reports.models import Report
from app.modules.workspaces import services as ws_services


class CompositeError(Exception):
    code = "composite_error"
    status_code = 400


class CompositeForbiddenError(CompositeError):
    code = "composite_forbidden"
    status_code = 403


def list_in_workspace_tree(
    db: Session, workspace_slug: str, *, is_global_view: bool = False
) -> list[CompositeReport]:
    """Composites for the current workspace + all descendants. Mirrors how
    the reports list endpoint scopes its result so a parent-tier user
    sees their sub-teams' composites too."""
    q = select(CompositeReport).order_by(desc(CompositeReport.updated_at))
    if not is_global_view:
        scope = ws_services.get_descendants_inclusive(db, workspace_slug)
        q = q.where(CompositeReport.workspace_slug.in_(scope))
    return list(db.execute(q).scalars())


def list_containing_report(
    db: Session, report_id: int
) -> list[CompositeReport]:
    """Every composite that references the given report as an item.
    Powers the report-detail "포함된 종합 N개" chip (Phase 5C).

    Sort: published_at DESC NULLS LAST (most recent publish first), then
    updated_at DESC as tiebreaker. recurring drafts come last because
    they're still being worked on; published ones first because that's
    what a viewer mostly cares about ("어디 인용됐지?").
    """
    q = (
        select(CompositeReport)
        .join(
            CompositeReportItem,
            CompositeReportItem.composite_id == CompositeReport.id,
        )
        .where(CompositeReportItem.ref_report_id == report_id)
        .order_by(
            desc(CompositeReport.published_at).nullslast(),
            desc(CompositeReport.updated_at),
        )
        .distinct()
    )
    return list(db.execute(q).scalars())


def get(db: Session, composite_id: int) -> Optional[CompositeReport]:
    return db.get(CompositeReport, composite_id)


def is_visible_to(db: Session, composite: CompositeReport, workspace_slug: str) -> bool:
    scope = ws_services.get_descendants_inclusive(db, workspace_slug)
    return composite.workspace_slug in scope


def _validate_refs(
    db: Session,
    items: Iterable[CompositeItemPayload],
    *,
    self_id: Optional[int] = None,
) -> None:
    """Ensure every item references something that actually exists, and
    block self-references so a composite can't contain itself."""
    for item in items:
        if item.ref_report_id is not None:
            if db.get(Report, item.ref_report_id) is None:
                raise ValueError(f"Report not found: {item.ref_report_id}")
        else:
            if item.ref_composite_id is None:
                # Schema validator already enforces this, but keep defensive.
                raise ValueError("item must reference a report or composite")
            if self_id is not None and item.ref_composite_id == self_id:
                raise ValueError("composite cannot include itself as an item")
            if db.get(CompositeReport, item.ref_composite_id) is None:
                raise ValueError(f"Composite not found: {item.ref_composite_id}")


def _fire_added_item_notifications(
    db: Session,
    composite: CompositeReport,
    *,
    added_refs: list[tuple[Optional[int], Optional[int]]],
    actor_user_id: int,
) -> None:
    """Fire `composite.included` / `composite.cited_upward` (Phase 5E)
    for each newly-added item. Self-notify is filtered out — adding
    your own report to your own composite doesn't need an alert.

    composite.included: ref is a Report → notify that report's owner.
    composite.cited_upward: ref is a sub-Composite → notify the sub-
    composite's owner AND each report owner inside it (their report is
    being cited one tier higher in the rollup chain)."""
    for ref_report_id, ref_composite_id in added_refs:
        if ref_report_id is not None:
            report = db.get(Report, ref_report_id)
            if (
                report is not None
                and report.owner_user_id is not None
                and report.owner_user_id != actor_user_id
            ):
                create_notification(
                    db,
                    recipient_user_id=report.owner_user_id,
                    actor_user_id=actor_user_id,
                    type=NotificationType.composite_included,
                    ref_table="composite_reports",
                    ref_id=composite.id,
                    workspace_slug=composite.workspace_slug,
                    payload={
                        "report_id": ref_report_id,
                        "report_title": report.title,
                        "composite_title": composite.title,
                    },
                )
        elif ref_composite_id is not None:
            sub = db.get(CompositeReport, ref_composite_id)
            if sub is None:
                continue
            recipients: set[int] = set()
            if (
                sub.owner_user_id is not None
                and sub.owner_user_id != actor_user_id
            ):
                recipients.add(sub.owner_user_id)
            # Walk one level — each report inside the sub-composite gets
            # cited upward too. Deep recursion (composite-of-composites-
            # of-composites) is intentionally not unrolled here; if/when
            # multi-tier rollups become a common pattern, callers can
            # opt into deeper traversal.
            for sub_item in sub.items:
                if sub_item.ref_report_id is None:
                    continue
                sub_report = db.get(Report, sub_item.ref_report_id)
                if (
                    sub_report is not None
                    and sub_report.owner_user_id is not None
                    and sub_report.owner_user_id != actor_user_id
                ):
                    recipients.add(sub_report.owner_user_id)
            for uid in recipients:
                create_notification(
                    db,
                    recipient_user_id=uid,
                    actor_user_id=actor_user_id,
                    type=NotificationType.composite_cited_upward,
                    ref_table="composite_reports",
                    ref_id=composite.id,
                    workspace_slug=composite.workspace_slug,
                    payload={
                        "composite_title": composite.title,
                        "sub_composite_id": ref_composite_id,
                        "sub_composite_title": sub.title,
                    },
                )


def _replace_items(
    db: Session, composite: CompositeReport, items: list[CompositeItemPayload]
) -> None:
    # Delete the existing rows so SQLAlchemy doesn't try to merge by id;
    # composites are small enough that a full swap is the simpler model
    # and matches what "items=[…]" in the PATCH payload implies.
    for existing in list(composite.items):
        db.delete(existing)
    db.flush()
    for idx, payload in enumerate(items):
        composite.items.append(
            CompositeReportItem(
                position=idx,
                note=payload.note or "",
                ref_report_id=payload.ref_report_id,
                ref_composite_id=payload.ref_composite_id,
                display_column=payload.display_column or 1,
            )
        )


def create(
    db: Session,
    payload: CompositeReportCreate,
    owner_user_id: int,
) -> CompositeReport:
    _validate_refs(db, payload.items)
    composite = CompositeReport(
        workspace_slug=payload.workspace_slug,
        title=payload.title,
        kind=payload.kind,
        period_date=payload.period_date,
        description=payload.description or "",
        owner_user_id=owner_user_id,
        updated_by_user_id=owner_user_id,
    )
    db.add(composite)
    db.flush()  # need an id for self-reference checks + child rows
    _replace_items(db, composite, payload.items)
    # Phase 5E — every initial item is "new", fire composite.included
    # (and composite.cited_upward for sub-composites). Self-notify is
    # filtered inside the helper.
    if payload.items:
        _fire_added_item_notifications(
            db,
            composite,
            added_refs=[
                (it.ref_report_id, it.ref_composite_id) for it in payload.items
            ],
            actor_user_id=owner_user_id,
        )
    db.commit()
    db.refresh(composite)
    return composite


def update(
    db: Session,
    composite: CompositeReport,
    payload: CompositeReportUpdate,
    *,
    updated_by_user_id: Optional[int] = None,
) -> CompositeReport:
    data = payload.model_dump(exclude_unset=True)
    added_refs: list[tuple[Optional[int], Optional[int]]] = []
    if "items" in data and payload.items is not None:
        _validate_refs(db, payload.items, self_id=composite.id)
        # Capture which refs existed BEFORE the swap so we only notify
        # on truly new ones. `_replace_items` rebuilds the rows from
        # scratch so without this snapshot we'd re-notify every item on
        # every save (a note edit on item #3 would alert everyone).
        old_refs = {
            (it.ref_report_id, it.ref_composite_id) for it in composite.items
        }
        _replace_items(db, composite, payload.items)
        new_refs = {
            (it.ref_report_id, it.ref_composite_id) for it in payload.items
        }
        added_refs = list(new_refs - old_refs)
    for key in ("title", "kind", "period_date", "description"):
        if key in data:
            setattr(composite, key, data[key])
    if updated_by_user_id is not None:
        composite.updated_by_user_id = updated_by_user_id
    if added_refs:
        _fire_added_item_notifications(
            db,
            composite,
            added_refs=added_refs,
            actor_user_id=updated_by_user_id or composite.owner_user_id or 0,
        )
    db.commit()
    db.refresh(composite)
    return composite


def delete(db: Session, composite: CompositeReport) -> None:
    db.delete(composite)
    db.commit()


# --------------------------------------------------------------------------- #
# Publish / unpublish — Phase 5A                                              #
# --------------------------------------------------------------------------- #


def _freeze_item_snapshots(
    db: Session, composite: CompositeReport, *, now: datetime
) -> None:
    """Walk every item that references a report and copy that report's
    full content payload into `snapshot_content`. Composite-of-composite
    items (ref_composite_id) get no snapshot for now — recursion would
    be ambiguous (do you snapshot the child composite live or its own
    snapshot?). Phase 9A may revisit.
    """
    for item in composite.items:
        if item.ref_report_id is None:
            continue
        report = db.get(Report, item.ref_report_id)
        if report is None:
            # Source deleted — skip; the item is orphan-flagged on read.
            continue
        # Mirror what the report's GET endpoint sends — pages + the
        # legacy top-level template/content shape. Keep it shallow JSON
        # so future readers don't need a separate report fetch.
        item.snapshot_content = {
            "title": report.title,
            "template_id": report.template_id,
            "template_version": report.template_version,
            "content": report.content or {},
            "layout_overrides": report.layout_overrides,
            "props_overrides": report.props_overrides,
            "pages": list(report.pages or []),
            "page_width_px": report.page_width_px,
            "page_gap_px": report.page_gap_px,
            "page_blend_blocks": report.page_blend_blocks,
            "report_date": (
                report.report_date.isoformat() if report.report_date else None
            ),
        }
        item.snapshot_taken_at = now


def _clear_item_snapshots(composite: CompositeReport) -> None:
    for item in composite.items:
        item.snapshot_content = None
        item.snapshot_taken_at = None


def publish(
    db: Session,
    composite: CompositeReport,
    *,
    actor_user_id: int,
) -> CompositeReport:
    """Mark a composite as published. For kind=recurring, freezes the
    current content of each item's referenced report into
    `snapshot_content`. theme composites also accept the publish call
    but treat it as a no-op snapshot-wise (they're always live by
    design); `published_at` still gets stamped so the UI can show "발행
    됨" if the team wants that signal.

    Idempotent: already-published returns the same composite untouched.
    Owner-only — caller must enforce upstream (route layer).

    Phase 5E — fires `composite.published` to the owner when someone
    other than the owner published (e.g. system admin force-publish).
    Self-publish is silent (the actor already knows they published).
    """
    if composite.published_at is not None:
        return composite
    now = datetime.utcnow()
    if composite.kind == CompositeKind.recurring:
        _freeze_item_snapshots(db, composite, now=now)
    composite.published_at = now
    composite.published_by_user_id = actor_user_id
    if (
        composite.owner_user_id is not None
        and composite.owner_user_id != actor_user_id
    ):
        create_notification(
            db,
            recipient_user_id=composite.owner_user_id,
            actor_user_id=actor_user_id,
            type=NotificationType.composite_published,
            ref_table="composite_reports",
            ref_id=composite.id,
            workspace_slug=composite.workspace_slug,
            payload={"composite_title": composite.title},
        )
    db.commit()
    db.refresh(composite)
    return composite


def unpublish(
    db: Session,
    composite: CompositeReport,
    *,
    actor_user_id: int,
) -> CompositeReport:
    """Reverse `publish`. Clears `published_at` + per-item snapshots so
    the composite goes back to live-fetch mode and is editable as a
    draft again. Idempotent for already-unpublished composites.
    """
    if composite.published_at is None:
        return composite
    if composite.kind == CompositeKind.recurring:
        _clear_item_snapshots(composite)
    composite.published_at = None
    composite.published_by_user_id = None
    db.commit()
    db.refresh(composite)
    return composite
