"""작업 큐 운영 라우트 — 시스템 관리자 전용 (AI 설정 → "작업 큐" 탭).

큐 상태를 한눈에 보고(통계·헬스), 실패한 잡을 재시도/취소/정리한다. 오늘처럼
LLM 이 꺼져 요약 잡이 조용히 쌓여 실패해도 관리자가 즉시 알아채고 복구할 수
있게 하는 게 목적. 처리 핫패스(worker/queue.claim)와 분리된 조회·조치 레이어.

경로: /api/jobs/admin/*  (modules/__init__ 에서 jobs_router 보다 먼저 등록 —
"/api/jobs/admin" 이 jobs_router 의 GET /{job_id} 로 새지 않도록 순서 보장).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.jobs import queue
from app.jobs.models import (
    STATUS_CANCELED,
    STATUS_DONE,
    STATUS_FAILED,
    Job,
)
from app.jobs.schemas import JobAdminRead
from app.shared.auth import require_system_admin
from app.shared.responses import error_response, not_found_response, success_response

router = APIRouter()

# 워커가 살아있다고 볼 최대 무신호 시간(초). 하트비트 주기(10s)의 3배 여유.
_WORKER_ALIVE_WINDOW_S = 30


@router.get("/stats")
def admin_job_stats(
    db: Session = Depends(get_db),
    _=Depends(require_system_admin),
):
    """큐 요약 — 상태별·종류별 카운트, 가장 오래된 대기, 최근 실패 수."""
    return success_response(queue.stats(db))


@router.get("/health")
def admin_job_health(
    db: Session = Depends(get_db),
    _=Depends(require_system_admin),
):
    """워커·LLM 생존 신호 — 상단 헬스 배지용. 워커는 하트비트로, LLM 은 가벼운
    모델 목록 조회로 판정(진단 탭의 풀 ping 과 달리 빠르게)."""
    from app.ai.llm import LLMError, list_models
    from app.config import settings

    workers = queue.recent_workers(db, within_seconds=_WORKER_ALIVE_WINDOW_S)

    llm: dict = {"backend": settings.llm_backend, "reachable": False}
    if (settings.llm_backend or "mock").lower() == "mock":
        llm["reachable"] = True
        llm["note"] = "mock — 네트워크 없이 동작"
    else:
        try:
            models = list_models(timeout=5.0)
            llm["reachable"] = True
            llm["models"] = models
        except LLMError as exc:
            llm["error"] = str(exc)

    return success_response(
        {
            "worker": {
                "alive": len(workers) > 0,
                "count": len(workers),
                "workers": workers,
                "window_s": _WORKER_ALIVE_WINDOW_S,
            },
            "llm": llm,
        }
    )


@router.get("")
def admin_list_jobs(
    db: Session = Depends(get_db),
    _=Depends(require_system_admin),
    status: str | None = Query(default=None),
    type: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """필터(상태·종류)된 전체 잡 목록 + 총건수. 최신순."""
    rows, total = queue.list_jobs(
        db, status=status, type=type, limit=limit, offset=offset
    )
    return success_response(
        {
            "items": [JobAdminRead.model_validate(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


class BulkRetryBody(BaseModel):
    status: str = Field(default=STATUS_FAILED)
    type: str | None = None


@router.post("/retry")
def admin_bulk_retry(
    body: BulkRetryBody,
    db: Session = Depends(get_db),
    _=Depends(require_system_admin),
):
    """필터에 맞는 잡 일괄 재시도(기본 failed 전체). LLM 복구 후 죽은 요약을
    한 번에 살릴 때. { requeued } 반환."""
    try:
        n = queue.requeue_filtered(db, status=body.status, type=body.type)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response({"requeued": n})


@router.post("/{job_id}/retry")
def admin_retry_job(
    job_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_system_admin),
):
    """단건 재시도 — failed/canceled → pending(attempts 리셋)."""
    job = db.get(Job, job_id)
    if job is None:
        return not_found_response(f"job not found: {job_id}")
    if not queue.requeue(db, job):
        return error_response(
            f"재시도할 수 없는 상태입니다(status={job.status}).", status_code=409
        )
    db.commit()
    return success_response(JobAdminRead.model_validate(job))


@router.post("/{job_id}/cancel")
def admin_cancel_job(
    job_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_system_admin),
):
    """대기(pending) 잡 취소 — 워커가 더는 집지 않는다."""
    job = db.get(Job, job_id)
    if job is None:
        return not_found_response(f"job not found: {job_id}")
    if not queue.cancel(db, job):
        return error_response(
            f"취소할 수 없는 상태입니다(status={job.status}). 대기 중인 잡만 취소됩니다.",
            status_code=409,
        )
    db.commit()
    return success_response(JobAdminRead.model_validate(job))


@router.delete("")
def admin_purge_jobs(
    db: Session = Depends(get_db),
    _=Depends(require_system_admin),
    status: str = Query(default=STATUS_DONE),
    older_than_days: int = Query(default=7, ge=0, le=365),
):
    """오래된 종결 잡(done/canceled/failed) 청소. { purged } 반환."""
    if status not in (STATUS_DONE, STATUS_CANCELED, STATUS_FAILED):
        return error_response(
            "정리는 done/canceled/failed 상태만 가능합니다.", status_code=400
        )
    n = queue.purge(db, status=status, older_than_days=older_than_days)
    return success_response({"purged": n})
