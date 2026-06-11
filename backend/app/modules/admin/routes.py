"""Admin-only system endpoints (storage, etc.)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.admin import services
from app.modules.files import orphans as orphan_services
from app.modules.files.orphans import OrphanVersionGuardError
from app.modules.reports import services as report_services
from app.modules.reports.schemas import (
    ReportLinkKindCreate,
    ReportLinkKindRead,
    ReportLinkKindUpdate,
)
from app.shared.auth import CurrentUser, require_system_admin
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)

router = APIRouter()


class RuntimeTuningUpdate(BaseModel):
    key: str = Field(..., min_length=1, max_length=64)
    value: int


class OrphanFileDeletePayload(BaseModel):
    file_ids: list[str] = Field(..., min_length=1, max_length=2000)
    grace_hours: int = Field(default=48, ge=0, le=8760)
    ignore_versions: bool = False


@router.get("/storage")
def storage_stats(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Disk partition + per-workspace file footprint. Admin-only because
    the response reveals host paths and aggregate per-workspace sizes."""
    return success_response(data=services.get_storage_stats(db))


@router.get("/orphan-files")
def list_orphan_files(
    grace_hours: int = Query(default=48, ge=0, le=8760),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """어느 보고서·종합보고에서도 참조하지 않는 업로드 파일 목록(+요약). 보고서에서
    뺀 영상/이미지가 디스크에 쌓이는 걸 관리자가 확인·정리하도록. 최근 업로드는
    유예(grace_hours) 보호."""
    return success_response(
        data=orphan_services.find_orphans(db, grace_hours=grace_hours)
    )


@router.post("/orphan-files/delete")
def delete_orphan_files(
    payload: OrphanFileDeletePayload,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """선택한 오펀 파일 삭제(디스크 + DB). 삭제 직전 다시 검증해 그 사이 참조됐거나
    유예 안인 파일은 건너뛴다."""
    try:
        result = orphan_services.delete_orphans(
            db,
            file_ids=payload.file_ids,
            grace_hours=payload.grace_hours,
            ignore_versions=payload.ignore_versions,
        )
    except OrphanVersionGuardError as exc:
        return error_response(str(exc), status_code=409)
    return success_response(
        data=result, message=f"{result['deleted']}개 파일을 삭제했습니다."
    )


@router.get("/server-info")
def server_info(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Host spec snapshot — OS / CPU / 메모리 / 프로세스 footprint / DB.
    Admin-only because the response exposes hostname, kernel version,
    PID 등 운영 정보."""
    return success_response(data=services.get_server_info(db))


@router.get("/runtime-tuning")
def runtime_tuning_get(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """워커 / DB pool 등 다음 부팅 시 적용될 튜닝 값. 각 키마다
    `stored` (= 저장된 값) 와 `effective` (= 이 워커가 부팅 시 읽은 값)
    가 같이 나오므로 UI 가 mismatch 시 "재시작 필요" 배지를 띄울 수 있다."""
    return success_response(data=services.get_runtime_tuning(db))


@router.put("/runtime-tuning")
def runtime_tuning_set(
    payload: RuntimeTuningUpdate,
    db: Session = Depends(get_db),
    me: CurrentUser = Depends(require_system_admin),
):
    """튜닝 값 upsert. 다음 부팅 시 적용 — UI 가 "재시작 필요" 알림."""
    try:
        data = services.set_runtime_tuning(
            db, key=payload.key, value=payload.value, user_id=me.user.id
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return success_response(data=data)


# ─── Report link kinds — admin CRUD ──────────────────────────────────────── #
#
# 일반 사용자용 list 는 /api/reports/link-kinds (reports router). 여기는
# 편집 권한이 필요한 entries 만.


def _link_kind_error(exc: report_services.LinkKindError):
    """Service-layer LinkKindError → 표준 envelope. duplicate/in_use 는
    409, 그 외 400."""
    status_map = {"duplicate_key": 409, "in_use": 409}
    return error_response(
        str(exc),
        errors=[{"code": exc.code, "message": str(exc)}],
        status_code=status_map.get(exc.code, 400),
    )


@router.get("/link-kinds")
def admin_list_link_kinds(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    rows = report_services.list_link_kinds(db)
    return success_response(
        data=[ReportLinkKindRead.model_validate(r) for r in rows]
    )


@router.post("/link-kinds")
def admin_create_link_kind(
    payload: ReportLinkKindCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        row = report_services.create_link_kind(
            db,
            key=payload.key,
            forward_label=payload.forward_label,
            reverse_label=payload.reverse_label,
            color=payload.color,
            sort_order=payload.sort_order,
        )
    except report_services.LinkKindError as exc:
        return _link_kind_error(exc)
    return created_response(data=ReportLinkKindRead.model_validate(row))


@router.patch("/link-kinds/{key}")
def admin_update_link_kind(
    key: str,
    payload: ReportLinkKindUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """key 와 system_locked 는 immutable. system_locked 라벨도 forward/
    reverse 텍스트와 색은 자유롭게 편집 가능 — 운영 중 표현만 바뀐다."""
    row = report_services.get_link_kind(db, key)
    if row is None:
        return not_found_response(f"Link kind not found: {key}")
    try:
        row = report_services.update_link_kind(
            db,
            row,
            forward_label=payload.forward_label,
            reverse_label=payload.reverse_label,
            color=payload.color,
            sort_order=payload.sort_order,
        )
    except report_services.LinkKindError as exc:
        return _link_kind_error(exc)
    return success_response(data=ReportLinkKindRead.model_validate(row))


@router.delete("/link-kinds/{key}")
def admin_delete_link_kind(
    key: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    row = report_services.get_link_kind(db, key)
    if row is None:
        return not_found_response(f"Link kind not found: {key}")
    try:
        report_services.delete_link_kind(db, row)
    except report_services.LinkKindError as exc:
        return _link_kind_error(exc)
    return success_response(data=None, message="Deleted")
