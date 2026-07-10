"""커넥터 라우트 — /api/connectors. 전부 시스템 관리자 전용.

fetch 가 도는 엔드포인트(probe·preview·sync)는 동기 `def` 핸들러로 둬 FastAPI 가
자동으로 스레드풀에서 실행(이벤트 루프 블로킹 방지)한다.

  GET    /                → 소스 목록
  POST   /                → 등록
  GET    /{id}            → 단건
  PUT    /{id}            → 수정
  DELETE /{id}            → 삭제
  POST   /probe           → 저장 전 응답 샘플(필드명 확인, 쓰기 없음)
  POST   /{id}/preview    → dry_run 동기화(검증 미리보기, 쓰기 없음)
  POST   /{id}/sync       → 실제 동기화(온톨로지 upsert) + 이력
  GET    /{id}/runs       → 동기화 이력
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.connectors import provenance, services, suggest
from app.modules.connectors.fetch import FetchError
from app.modules.connectors.schemas import (
    DataSourceCreate,
    DataSourceListResponse,
    DataSourceUpdate,
    ProbeRequest,
    SuggestMappingRequest,
    SyncRunListResponse,
)
from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace, require_system_admin
from app.shared.responses import error_response, not_found_response, success_response

router = APIRouter()


@router.get("")
def list_sources(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    items = [services.to_read(s) for s in services.list_sources(db)]
    return success_response(data=DataSourceListResponse(items=items).model_dump())


@router.post("")
def create_source(
    payload: DataSourceCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_system_admin),
):
    try:
        source = services.create_source(db, payload, user_id=admin.id)
    except IntegrityError:
        db.rollback()
        return error_response("같은 이름의 데이터소스가 이미 있습니다.", status_code=409)
    return success_response(data=services.to_read(source).model_dump())


@router.get("/{source_id}")
def get_source(
    source_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    source = services.get_source(db, source_id)
    if source is None:
        return not_found_response("데이터소스를 찾을 수 없습니다.")
    return success_response(data=services.to_read(source).model_dump())


@router.put("/{source_id}")
def update_source(
    source_id: int,
    payload: DataSourceUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    source = services.get_source(db, source_id)
    if source is None:
        return not_found_response("데이터소스를 찾을 수 없습니다.")
    try:
        source = services.update_source(db, source, payload)
    except IntegrityError:
        db.rollback()
        return error_response("같은 이름의 데이터소스가 이미 있습니다.", status_code=409)
    return success_response(data=services.to_read(source).model_dump())


@router.delete("/{source_id}")
def delete_source(
    source_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    source = services.get_source(db, source_id)
    if source is None:
        return not_found_response("데이터소스를 찾을 수 없습니다.")
    services.delete_source(db, source)
    return success_response(data={"deleted": source_id})


@router.post("/probe")
def probe(
    payload: ProbeRequest,
    _db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    """저장 전 매핑 UI 용 — 커넥션+스트림으로 실제 응답을 받아 레코드 샘플·필드명 반환."""
    try:
        data = services.probe_stream(payload.connection, payload.stream)
    except FetchError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=data)


@router.post("/suggest-mapping")
def suggest_mapping(
    payload: SuggestMappingRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    """AI 자동 매핑 — 샘플 레코드 + 대상 축으로 value/속성/관계 매핑 초안 제안.
    LLM 시도 → 실패 시 휴리스틱 폴백. 존재하는 경로·슬러그만 반환(검증됨)."""
    try:
        data = suggest.suggest_mapping(db, payload.target_type_id, payload.sample)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=data)


@router.post("/{source_id}/preview")
def preview(
    source_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    """dry_run 동기화 — fetch + 매핑 + 검증만(쓰기 없음). 반환 {summary, rows}."""
    source = services.get_source(db, source_id)
    if source is None:
        return not_found_response("데이터소스를 찾을 수 없습니다.")
    try:
        result = services.run_sync(
            db, source, dry_run=True, triggered_by="manual",
            user_id=source.created_by_user_id or 0,
        )
    except (FetchError, ValueError) as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=result)


@router.post("/{source_id}/sync")
def sync_now(
    source_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_system_admin),
):
    """실제 동기화 — 온톨로지에 upsert + 관계 링크. 이력에 기록. 반환 {summary, rows}."""
    source = services.get_source(db, source_id)
    if source is None:
        return not_found_response("데이터소스를 찾을 수 없습니다.")
    try:
        result = services.run_sync(
            db, source, dry_run=False, triggered_by="manual", user_id=admin.id,
        )
    except (FetchError, ValueError) as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=result)


@router.get("/objects/{entity_id}/provenance")
def object_provenance(
    entity_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user_no_workspace),
):
    """이 객체를 채운 소스들(계보). 인증만 — 객체 프로필의 '출처' 표시에 쓴다."""
    return success_response(
        data={"items": provenance.list_provenance_for_entity(db, entity_id)}
    )


@router.get("/{source_id}/runs")
def list_runs(
    source_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_system_admin),
):
    source = services.get_source(db, source_id)
    if source is None:
        return not_found_response("데이터소스를 찾을 수 없습니다.")
    runs = services.list_runs(db, source_id)
    return success_response(
        data=SyncRunListResponse(
            items=[services.run_to_read(r) for r in runs]
        ).model_dump()
    )
