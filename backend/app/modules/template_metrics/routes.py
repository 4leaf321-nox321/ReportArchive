"""TemplateMetric 관리 라우트 — 시스템 관리자 전용(대시보드 수치 지표 정의).

  GET    /api/admin/template-metrics?template_id=      목록(전체 또는 템플릿별)
  GET    /api/admin/template-metrics/candidates?template_id=   숫자 필드 후보
  POST   /api/admin/template-metrics                   생성
  PATCH  /api/admin/template-metrics/{id}              수정
  DELETE /api/admin/template-metrics/{id}              삭제

전역·관리자 정의(Phase3_대시보드_설계.md Q1). 대시보드 표시(읽기)는 별도
HTTP 없이 dashboard 서비스가 이 테이블을 직접 질의한다(3B-2).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.template_metrics import models as _models  # noqa: F401
from app.modules.template_metrics import services
from app.modules.template_metrics.schemas import (
    MetricCandidatesResponse,
    TemplateMetricCreate,
    TemplateMetricRead,
    TemplateMetricUpdate,
)
from app.shared.auth import CurrentUser, require_system_admin
from app.shared.responses import (
    created_response,
    error_response,
    success_response,
)


router = APIRouter()


def _to_http(exc: services.MetricError):
    return error_response(exc.message, status_code=exc.status_code)


@router.get("")
def list_template_metrics(
    template_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    rows = services.list_metrics(db, template_id=template_id)
    payload = [TemplateMetricRead.model_validate(r).model_dump(mode="json") for r in rows]
    return success_response(data=payload)


@router.get("/candidates")
def list_metric_candidates(
    template_id: str = Query(...),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        data = services.candidate_fields(db, template_id)
    except services.MetricError as e:
        return _to_http(e)
    return success_response(
        data=MetricCandidatesResponse.model_validate(data).model_dump(mode="json")
    )


@router.post("")
def create_template_metric(
    body: TemplateMetricCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        row = services.create_metric(db, body)
    except services.MetricError as e:
        return _to_http(e)
    return created_response(
        data=TemplateMetricRead.model_validate(row).model_dump(mode="json")
    )


@router.patch("/{metric_id}")
def update_template_metric(
    metric_id: int,
    body: TemplateMetricUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        row = services.update_metric(db, metric_id, body)
    except services.MetricError as e:
        return _to_http(e)
    return success_response(
        data=TemplateMetricRead.model_validate(row).model_dump(mode="json")
    )


@router.delete("/{metric_id}")
def delete_template_metric(
    metric_id: int,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        services.delete_metric(db, metric_id)
    except services.MetricError as e:
        return _to_http(e)
    return success_response(data={"deleted": True})
