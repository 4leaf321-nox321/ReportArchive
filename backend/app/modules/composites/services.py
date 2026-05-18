"""Business logic for composite reports."""
from __future__ import annotations

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
from app.modules.reports.models import Report
from app.modules.workspaces import services as ws_services


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
    if "items" in data and payload.items is not None:
        _validate_refs(db, payload.items, self_id=composite.id)
        _replace_items(db, composite, payload.items)
    for key in ("title", "kind", "period_date", "description"):
        if key in data:
            setattr(composite, key, data[key])
    if updated_by_user_id is not None:
        composite.updated_by_user_id = updated_by_user_id
    db.commit()
    db.refresh(composite)
    return composite


def delete(db: Session, composite: CompositeReport) -> None:
    db.delete(composite)
    db.commit()
