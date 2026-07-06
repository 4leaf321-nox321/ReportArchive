"""AI 연결 진단 — B300(생성 LLM) 연결 상태를 *서버 경유*로 확인한다.

dev 서버는 B300 에 못 닿고 운영서버만 닿으므로, 브라우저가 아니라 **서버가** LLM 을
호출해야 한다(B300_보조AI_설계.md §T). 이 엔드포인트가 그 서버 경유 호출이며,
같은 코드가 dev(mock/스텁) 검증 · 운영 실연결 스모크 · 상시 헬스체크를 겸한다.

**접근: 일단 시스템 관리자 전용**(require_system_admin). 추후 확대 여지는 두되 지금은 관리자만.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.llm import LLMCancelled, LLMError, chat, list_models
from app.ai.models import AiEntitlement, AiFeature, AiSubjectKind
from app.config import settings
from app.database import get_db
from app.modules.users.models import User
from app.modules.workspaces.models import Workspace
from app.shared.auth import get_current_user, require_system_admin
from app.shared.responses import error_response, success_response

router = APIRouter()


class DiagChatPayload(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=8000)
    # 미지정 시 settings.llm_reasoning_effort. "" 면 명시적으로 끔(전달 안 함).
    reasoning_effort: str | None = Field(default=None)


def _config_view() -> dict:
    """현재 LLM 설정 요약(비밀 제외). 진단 탭 상태 카드용."""
    return {
        "backend": settings.llm_backend,
        "base_url": settings.llm_base_url,
        "model": settings.llm_model,
        "has_api_key": bool(settings.llm_api_key),
        "reasoning_effort": settings.llm_reasoning_effort or None,
        "timeout_s": settings.llm_timeout_s,
        "max_tokens": settings.llm_max_tokens,
    }


@router.get("/diag/config")
def diag_config(_: User = Depends(require_system_admin)):
    """설정만 반환(호출 없음). 화면이 백엔드/모델/주소를 먼저 보여줄 때."""
    return success_response(data=_config_view())


@router.post("/diag/ping")
def diag_ping(_: User = Depends(require_system_admin)):
    """짧은 chat 1회 + (가능하면) 모델 목록으로 연결 확인. 실패 시 502+사유."""
    cfg = _config_view()
    # 모델 목록은 부가 정보 — 실패해도 ping 자체는 chat 으로 판정.
    try:
        cfg["models"] = list_models()
    except LLMError:
        cfg["models"] = None

    t0 = time.perf_counter()
    try:
        res = chat([{"role": "user", "content": "ping"}], max_tokens=8)
    except LLMError as exc:
        return error_response(f"LLM 연결 실패: {exc}", status_code=502)
    latency_ms = int((time.perf_counter() - t0) * 1000)

    return success_response(
        data={
            **cfg,
            "ok": True,
            "latency_ms": latency_ms,
            "model_returned": res.model,
            "has_reasoning": res.reasoning is not None,
            "content_preview": res.content[:200],
        }
    )


@router.post("/diag/chat")
def diag_chat(payload: DiagChatPayload, _: User = Depends(require_system_admin)):
    """임의 프롬프트 → 원응답(content + reasoning + usage + latency). 플레이그라운드."""
    t0 = time.perf_counter()
    try:
        res = chat(
            [{"role": "user", "content": payload.prompt}],
            reasoning_effort=payload.reasoning_effort,
        )
    except LLMError as exc:
        return error_response(f"LLM 호출 실패: {exc}", status_code=502)
    latency_ms = int((time.perf_counter() - t0) * 1000)

    return success_response(
        data={
            "content": res.content,
            "reasoning": res.reasoning,
            "usage": res.usage,
            "model": res.model,
            "backend": res.backend,
            "latency_ms": latency_ms,
        }
    )


# --------------------------------------------------------------------------- #
# A. 아카이브 RAG Q&A — "우리 보고서에게 묻기" (B300_보조AI_설계.md §A)
# --------------------------------------------------------------------------- #
class AskPayload(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    limit: int = Field(default=8, ge=1, le=20)
    # graph=True → GraphRAG: 온톨로지 그래프 근거를 순수 벡터와 블렌드(GraphRAG_설계.md).
    graph: bool = False


@router.post("/ask")
async def ask(
    payload: AskPayload,
    request: Request,
    actor=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """자연어 질문 → 권한 게이팅된 시맨틱 검색 → B300 가 출처 인용해 답변.

    기능 게이트(§E): 'rag_qa' 엔티틀먼트 없으면 403. 데이터 권한은 검색 scope 가
    이미 보장(권한 밖 보고서는 인용 불가). 근거 약하면 LLM 미호출(환각 방지),
    LLM 실패는 502(검색·앱 무영향).

    프론트가 요청을 abort 하면 연결이 끊겨(request.is_disconnected) 생성을 즉시
    중단한다 — 업스트림 LLM 연결도 닫혀 GPU 가 풀린다."""
    # 지연 import — entitlements(↔users) 모듈 로드 순환 회피.
    from app.ai import qa
    from app.ai.entitlements import ai_enabled_for

    if not ai_enabled_for(db, actor.user, "rag_qa"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "AI 질문하기 권한이 없습니다."
        )
    try:
        data = await qa.ask_archive_cancellable(
            db, actor, payload.query, limit=payload.limit, graph=payload.graph,
            should_cancel=request.is_disconnected,
        )
    except LLMCancelled:
        # 사용자가 중단 — 클라이언트는 이미 떠났으므로 응답 본문은 사실상 버려진다.
        return error_response("AI 응답이 취소되었습니다.", status_code=499)
    except LLMError as exc:
        return error_response(f"AI 응답 실패: {exc}", status_code=502)
    return success_response(data=data)


# --------------------------------------------------------------------------- #
# 온톨로지 에이전트 — tool-calling(팔란티어식). 온톨로지 도구로 다단계 조사.
# --------------------------------------------------------------------------- #
class AgentPayload(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    max_hops: int = Field(default=6, ge=1, le=10)


@router.post("/agent")
async def agent_ask(
    payload: AgentPayload,
    actor=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """자연어 질문 → LLM이 온톨로지 도구(list_object_types/search_objects/
    get_object/search_reports)를 스스로 호출해 조사 → 근거·추론과정과 함께 답변.

    게이트(§E): 'rag_qa' 엔티틀먼트 재사용. 데이터 권한은 도구 실행이 보장(보고서는
    가시성 게이팅). LLM이 tools 미지원이면 도구 없이 1턴으로 degrade(무해).
    sync 루프라 스레드풀에서 실행(요청 이벤트루프 비블로킹). LLM 실패는 502."""
    from starlette.concurrency import run_in_threadpool

    from app.ai import agent
    from app.ai.entitlements import ai_enabled_for

    if not ai_enabled_for(db, actor.user, "rag_qa"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "AI 질문하기 권한이 없습니다."
        )
    try:
        data = await run_in_threadpool(
            agent.run_agent, db, actor, payload.query, max_hops=payload.max_hops
        )
    except LLMError as exc:
        return error_response(f"AI 응답 실패: {exc}", status_code=502)
    return success_response(data=data)


# --------------------------------------------------------------------------- #
# E. 접근 제어(엔티틀먼트) — 선별 유저/조직만 B300 기능 사용 (B300_보조AI_설계.md §E)
# 전부 시스템 관리자 전용. "AI 접근" 탭이 읽고 쓴다.
# --------------------------------------------------------------------------- #
class AiEntitlementCreate(BaseModel):
    feature: AiFeature
    subject_kind: AiSubjectKind
    user_id: int | None = None
    workspace_slug: str | None = None
    include_descendants: bool = False
    note: str | None = Field(default=None, max_length=2000)


class AiEntitlementRead(BaseModel):
    id: int
    feature: AiFeature
    subject_kind: AiSubjectKind
    user_id: int | None
    workspace_slug: str | None
    include_descendants: bool
    enabled: bool
    note: str | None
    # 화면 표시용 — 유저 grant 면 이메일/이름, 조직 grant 면 워크스페이스 이름.
    subject_label: str


def _entitlement_read(db: Session, e: AiEntitlement) -> AiEntitlementRead:
    label = ""
    if e.subject_kind == AiSubjectKind.user and e.user_id is not None:
        u = db.get(User, e.user_id)
        label = (u.email or u.name or f"#{e.user_id}") if u else f"#{e.user_id}"
    elif e.subject_kind == AiSubjectKind.workspace and e.workspace_slug:
        w = db.get(Workspace, e.workspace_slug)
        label = (w.name if w else e.workspace_slug) or e.workspace_slug
    return AiEntitlementRead(
        id=e.id,
        feature=e.feature,
        subject_kind=e.subject_kind,
        user_id=e.user_id,
        workspace_slug=e.workspace_slug,
        include_descendants=e.include_descendants,
        enabled=e.enabled,
        note=e.note,
        subject_label=label,
    )


@router.get("/entitlements")
def list_entitlements(
    _: User = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    """모든 B300 기능 grant 목록(시스템 관리자). 최신순."""
    rows = db.execute(
        select(AiEntitlement).order_by(AiEntitlement.created_at.desc())
    ).scalars().all()
    return success_response(
        data={"items": [_entitlement_read(db, e) for e in rows]}
    )


@router.post("/entitlements", status_code=201)
def create_entitlement(
    payload: AiEntitlementCreate,
    actor: User = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    """grant 생성. subject_kind 에 맞는 대상(user_id 또는 workspace_slug) 필수."""
    if payload.subject_kind == AiSubjectKind.user:
        if payload.user_id is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "user_id 가 필요합니다.")
        if db.get(User, payload.user_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다.")
        workspace_slug = None
        user_id = payload.user_id
    else:
        if not payload.workspace_slug:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "workspace_slug 가 필요합니다."
            )
        if db.get(Workspace, payload.workspace_slug) is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "워크스페이스를 찾을 수 없습니다."
            )
        user_id = None
        workspace_slug = payload.workspace_slug

    # 중복(같은 기능·대상) 거부 — 유니크 제약과 같은 의미를 친절히 surface.
    dup = db.execute(
        select(AiEntitlement).where(
            AiEntitlement.feature == payload.feature,
            AiEntitlement.subject_kind == payload.subject_kind,
            AiEntitlement.user_id == user_id,
            AiEntitlement.workspace_slug == workspace_slug,
        )
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "이미 같은 권한이 부여되어 있습니다."
        )

    row = AiEntitlement(
        feature=payload.feature,
        subject_kind=payload.subject_kind,
        user_id=user_id,
        workspace_slug=workspace_slug,
        include_descendants=payload.include_descendants,
        note=(payload.note or "").strip() or None,
        created_by_user_id=actor.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return success_response(data=_entitlement_read(db, row))


@router.post("/resummarize")
def resummarize_all(
    force: bool = False,
    _: User = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    """자동요약 백필(B) — 삭제 안 된 모든 보고서에 summarize_report 잡 적재.
    작성자 엔티틀먼트·content_hash skip 은 핸들러가 판정(권한 없으면 그냥 skip).
    force=true 면 무변경도 재요약. 전역 스위치와 무관하게 명시 트리거."""
    from sqlalchemy.exc import IntegrityError

    from app.jobs.queue import enqueue
    from app.modules.reports.models import Report

    rids = db.execute(
        select(Report.id).where(Report.deleted_at.is_(None))
    ).scalars().all()
    n = 0
    for rid in rids:
        try:
            enqueue(
                db,
                "summarize_report",
                {"report_id": rid, "force": force},
                dedup_key=f"summarize_report:{rid}",
            )
            db.commit()
            n += 1
        except IntegrityError:
            db.rollback()
    return success_response(
        data={"enqueued": n}, message=f"{n}건 요약 잡을 적재했습니다."
    )


@router.delete("/entitlements/{entitlement_id}")
def delete_entitlement(
    entitlement_id: int,
    _: User = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    """grant 해제 = 행 삭제(설계상 '끄기'). 멱등."""
    row = db.get(AiEntitlement, entitlement_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return success_response(data=None, message="권한이 해제됐습니다.")
