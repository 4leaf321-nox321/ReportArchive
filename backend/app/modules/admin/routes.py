"""Admin-only system endpoints (storage, etc.)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.access_logs import services as access_log_services
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


class OrphanCleanupEnqueuePayload(BaseModel):
    grace_hours: int = Field(default=48, ge=0, le=8760)
    delete: bool = False  # False=스캔만(dry-run)
    limit: int | None = Field(default=None, ge=1, le=100000)


@router.post("/orphan-files/cleanup-job")
def enqueue_orphan_cleanup(
    payload: OrphanCleanupEnqueuePayload,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_system_admin),
):
    """고아 파일 스캔/정리를 백그라운드 워커로 적재한다(동기 대기 없음).

    스캔은 모든 보고서·종합보고·버전 본문을 훑어 무거우므로, 관리자가 응답을
    기다리지 않게 큐에 넣고 job_id 만 돌려준다. 진행/결과는 GET /api/jobs/{id}
    로 폴링. 같은 작업이 이미 대기/처리 중이면 중복 적재하지 않는다(dedup).
    """
    from sqlalchemy import select
    from sqlalchemy.exc import IntegrityError

    from app.jobs import queue
    from app.jobs.models import Job

    try:
        job_id = queue.enqueue(
            db,
            "orphan_cleanup",
            {
                "grace_hours": payload.grace_hours,
                "delete": payload.delete,
                "limit": payload.limit,
            },
            dedup_key="admin",
            created_by=actor.user.id,
        )
    except IntegrityError:
        # 이미 대기/처리 중인 정리 작업이 있음(uq_jobs_dedup). 그걸 그대로 반환.
        db.rollback()
        existing = db.scalar(
            select(Job.id)
            .where(
                Job.type == "orphan_cleanup",
                Job.dedup_key == "admin",
                Job.status.in_(("pending", "running")),
            )
            .order_by(Job.id.desc())
        )
        return success_response(
            data={"job_id": existing, "already_running": True},
            message="이미 진행 중인 고아 파일 정리 작업이 있습니다.",
        )
    return created_response(
        data={"job_id": job_id},
        message="고아 파일 정리를 백그라운드에 적재했습니다.",
    )


@router.get("/access-logs")
def list_access_logs(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user_id: int | None = Query(default=None),
    success: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """사용자 접속(로그인/가입) 이력 — 최신순 + 총건수. 시스템 관리자 전용
    (클라이언트 IP·User-Agent 등 민감 정보 포함). user_id / success(성공·실패)
    로 좁힐 수 있다."""
    return success_response(
        data=access_log_services.list_access_logs(
            db, limit=limit, offset=offset, user_id=user_id, success=success
        )
    )


@router.get("/access-logs/stats")
def access_log_stats(
    granularity: str = Query(default="day"),
    periods: int | None = Query(default=None, ge=1, le=31),
    success: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """부서별·기간별 접속 통계 — 일/주/월 막대그래프용. 시스템 관리자 전용.
    success=true(성공만, 기본)/false(실패만)/생략(전체). 부서는 사용자의 홈
    부서로 집계하고, 홈 부서가 없으면 '미지정'."""
    return success_response(
        data=access_log_services.access_log_stats(
            db, granularity=granularity, periods=periods, success=success
        )
    )


@router.get("/access-logs/stats/detail")
def access_log_stats_detail(
    granularity: str = Query(default="day"),
    bucket: str = Query(..., description="버킷 시작일 'YYYY-MM-DD'(KST)"),
    department: str | None = Query(default=None),
    success: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """막대 클릭 드릴다운 — 한 버킷(+선택한 부서) 안의 사용자별 접속 횟수.
    시스템 관리자 전용. department 생략 시 버킷 전체, '미지정'이면 홈 부서 없는
    접속만."""
    return success_response(
        data=access_log_services.access_log_user_breakdown(
            db,
            granularity=granularity,
            bucket_start=bucket,
            department=department,
            success=success,
        )
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


# ─── 메일러(SMTP) — 상태 + 테스트 발송 ──────────────────────────────────── #


class TestEmailPayload(BaseModel):
    # 비우면 요청한 관리자 본인 이메일로 보낸다.
    to: str | None = Field(default=None, max_length=255)


@router.get("/mailer")
def mailer_status(
    _: CurrentUser = Depends(require_system_admin),
):
    """메일러 설정 상태(백엔드·SMTP 호스트·TLS·인증 여부). 비밀은 노출 안 함."""
    from app.mailer import service as mail_service

    return success_response(data=mail_service.status())


@router.post("/mailer/test")
def mailer_test(
    payload: TestEmailPayload,
    db: Session = Depends(get_db),
    me: CurrentUser = Depends(require_system_admin),
):
    """테스트 메일 즉시 발송(큐 경유 아님 — 관리자가 설정을 바로 검증하도록).
    smtp 백엔드 발송 실패는 그대로 에러로 돌려준다."""
    from app.config import settings
    from app.mailer import service as mail_service
    from app.mailer import templates as mail_templates

    to = (payload.to or "").strip() or me.user.email
    if not to or "@" not in to:
        return error_response("보낼 이메일 주소가 없습니다.", status_code=400)
    subject, html, text = mail_templates.render(
        "test", {"backend": settings.email_backend}
    )
    try:
        result = mail_service.send_now(to=to, subject=subject, html=html, text=text)
    except Exception as e:  # noqa: BLE001 — 설정 검증용, 원인 그대로 노출
        return error_response(f"발송 실패: {e}", status_code=502)
    return success_response(
        data={"to": to, **result},
        message=f"{to} 로 테스트 메일을 보냈습니다({result.get('backend')}).",
    )


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
