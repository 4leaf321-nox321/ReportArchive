"""작업 상태 조회 라우트 (폴링용).

프론트는 작업을 적재한 라우트에서 받은 job_id 로 GET /api/jobs/{id} 를
1~2초 간격 폴링해 status 가 done 이면 result(예: file_id)로 다운로드한다.

Phase ① 은 읽기 전용 — 적재(enqueue)는 각 도메인 라우트가 직접 한다.
권한: 본인이 만든 작업 또는 시스템 관리자만. 존재 누설 방지로 그 외엔 404.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.jobs.models import Job
from app.jobs.schemas import JobRead
from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace
from app.shared.responses import success_response

router = APIRouter()


def _visible_or_404(job: Job | None, user: User) -> Job:
    if job is None or (job.created_by != user.id and not user.is_system_admin):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    return job


@router.get("/{job_id}")
def get_job(
    job_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    job = _visible_or_404(db.get(Job, job_id), user)
    return success_response(JobRead.model_validate(job))


@router.get("")
def list_my_jobs(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    rows = db.scalars(
        select(Job)
        .where(Job.created_by == user.id)
        .order_by(Job.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return success_response([JobRead.model_validate(r) for r in rows])
