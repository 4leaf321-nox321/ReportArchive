"""TemplateMetric 서비스 — CRUD + 템플릿 schema 에서 숫자 필드 후보 추출."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.template_metrics.models import TemplateMetric
from app.modules.templates.models import Template

# 지표로 쓸 수 있는 key_value item 타입(숫자).
NUMERIC_TYPES = {"number", "integer"}


class MetricError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def list_metrics(
    db: Session, *, template_id: Optional[str] = None
) -> list[TemplateMetric]:
    q = select(TemplateMetric)
    if template_id:
        q = q.where(TemplateMetric.template_id == template_id)
    q = q.order_by(
        TemplateMetric.template_id,
        TemplateMetric.display_order,
        TemplateMetric.id,
    )
    return list(db.execute(q).scalars())


def create_metric(db: Session, payload) -> TemplateMetric:
    # 중복(같은 template/block/field) 방지 — 사전 체크로 친절한 메시지.
    exists = db.execute(
        select(TemplateMetric).where(
            TemplateMetric.template_id == payload.template_id,
            TemplateMetric.block_id == payload.block_id,
            TemplateMetric.field_key == payload.field_key,
        )
    ).scalar_one_or_none()
    if exists is not None:
        raise MetricError("이미 같은 필드의 지표가 있습니다.", status_code=409)
    row = TemplateMetric(
        template_id=payload.template_id,
        block_id=payload.block_id,
        field_key=payload.field_key,
        source_kind=payload.source_kind,
        agg=payload.agg,
        label=payload.label,
        unit=payload.unit,
        enabled=payload.enabled,
        display_order=payload.display_order,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_metric(db: Session, metric_id: int, payload) -> TemplateMetric:
    row = db.get(TemplateMetric, metric_id)
    if row is None:
        raise MetricError("지표를 찾을 수 없습니다.", status_code=404)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


def delete_metric(db: Session, metric_id: int) -> None:
    row = db.get(TemplateMetric, metric_id)
    if row is None:
        raise MetricError("지표를 찾을 수 없습니다.", status_code=404)
    db.delete(row)
    db.commit()


def _latest_template(db: Session, template_id: str) -> Optional[Template]:
    return db.execute(
        select(Template).where(
            Template.template_id == template_id,
            Template.is_latest.is_(True),
        )
    ).scalar_one_or_none()


def candidate_fields(db: Session, template_id: str) -> dict:
    """최신 템플릿 schema 에서 key_value 블록 + 숫자(item) 필드 후보를 추린다.
    관리 UI 드롭다운이 오타 없이 block_id/field_key 를 고르게 한다."""
    tpl = _latest_template(db, template_id)
    if tpl is None:
        raise MetricError(f"템플릿을 찾을 수 없습니다: {template_id}", status_code=404)
    blocks = []
    for b in (tpl.schema or {}).get("blocks", []):
        if b.get("type") != "key_value":
            continue
        props = b.get("props") or {}
        fields = [
            {
                "key": it.get("key"),
                "label": it.get("label") or it.get("key"),
                "type": it.get("type"),
            }
            for it in (props.get("items") or [])
            if it.get("key") and it.get("type") in NUMERIC_TYPES
        ]
        if not fields:
            continue
        blocks.append(
            {
                "block_id": b.get("id"),
                "block_label": props.get("label") or b.get("id"),
                "fields": fields,
            }
        )
    return {
        "template_id": tpl.template_id,
        "template_name": tpl.name,
        "version": tpl.version,
        "blocks": blocks,
    }
