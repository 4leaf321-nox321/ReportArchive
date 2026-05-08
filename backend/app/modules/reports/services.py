"""Business logic for reports — workspace scoping + widget-v1 validation."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.modules.reports.models import Report
from app.modules.reports.schemas import ReportCreate, ReportUpdate
from app.modules.templates import services as template_services
from app.modules.workspaces import services as ws_services
from app.widgets import (
    validate_layout_overrides as _validate_layout_overrides,
    validate_report_content as _validate_widget_v1_content,
)


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


def _validate_content(db: Session, template_id: str, version: int, content: dict) -> None:
    template = template_services.get_template(db, template_id, version)
    if not template:
        raise ValueError(f"Template not found: {template_id}@{version}")
    _validate_widget_v1_content(template.schema, content)


def _validate_overrides(db: Session, template_id: str, version: int, overrides: dict | None) -> None:
    if overrides is None:
        return
    template = template_services.get_template(db, template_id, version)
    if not template:
        raise ValueError(f"Template not found: {template_id}@{version}")
    _validate_layout_overrides(template.schema, overrides)


def _normalize_overrides(overrides: dict | None) -> dict | None:
    """Treat empty dicts as None so the DB stays clean."""
    if not overrides:
        return None
    return overrides


def create_report(
    db: Session,
    workspace_slug: str,
    payload: ReportCreate,
    owner_user_id: int,
) -> Report:
    # Drafts may legitimately be partial — only validate non-empty content.
    if payload.content:
        _validate_content(db, payload.template_id, payload.template_version, payload.content)
    _validate_overrides(db, payload.template_id, payload.template_version, payload.layout_overrides)

    report = Report(
        workspace_slug=workspace_slug,
        template_id=payload.template_id,
        template_version=payload.template_version,
        title=payload.title,
        period=payload.period,
        tags=list(payload.tags or []),
        content=payload.content or {},
        layout_overrides=_normalize_overrides(payload.layout_overrides),
        owner_user_id=owner_user_id,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def update_report(db: Session, report: Report, payload: ReportUpdate) -> Report:
    data = payload.model_dump(exclude_unset=True)
    if "content" in data and data["content"]:
        _validate_content(db, report.template_id, report.template_version, data["content"])
    if "layout_overrides" in data:
        _validate_overrides(db, report.template_id, report.template_version, data["layout_overrides"])
        data["layout_overrides"] = _normalize_overrides(data["layout_overrides"])
    for key, value in data.items():
        setattr(report, key, value)
    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, report: Report) -> None:
    db.delete(report)
    db.commit()
