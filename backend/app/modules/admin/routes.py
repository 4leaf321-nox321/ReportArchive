"""Admin-only system endpoints (storage, etc.)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.admin import services
from app.shared.auth import CurrentUser, require_system_admin
from app.shared.responses import success_response

router = APIRouter()


class RuntimeTuningUpdate(BaseModel):
    key: str = Field(..., min_length=1, max_length=64)
    value: int


@router.get("/storage")
def storage_stats(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Disk partition + per-workspace file footprint. Admin-only because
    the response reveals host paths and aggregate per-workspace sizes."""
    return success_response(data=services.get_storage_stats(db))


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
