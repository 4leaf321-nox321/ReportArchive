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
from sqlalchemy import func, select
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
    # rerank/hyde/verify: 요청별 override(None=서버 설정 기본값). 질문마다 켜고 끔.
    rerank: bool | None = None
    hyde: bool | None = None
    verify: bool | None = None


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
            rerank=payload.rerank, hyde=payload.hyde, verify=payload.verify,
            should_cancel=request.is_disconnected,
        )
    except LLMCancelled:
        # 사용자가 중단 — 클라이언트는 이미 떠났으므로 응답 본문은 사실상 버려진다.
        return error_response("AI 응답이 취소되었습니다.", status_code=499)
    except LLMError as exc:
        return error_response(f"AI 응답 실패: {exc}", status_code=502)
    return success_response(data=data)


@router.get("/ask/options")
def ask_options(actor=Depends(get_current_user)):
    """Q&A 검색 옵션의 **현재 기본값** — 프론트 토글 초기화용. 사용자는 이 위에서
    질문마다 rerank/hyde 를 켜고 끌 수 있다(요청 override). 기본값은 런타임 설정
    (관리자가 재시작 없이 변경)을 따른다. llm_backend 가 mock 이면 두 옵션은 무효."""
    from app.modules.app_settings import store

    llm_ready = (settings.llm_backend or "mock").lower() != "mock"
    return success_response(data={
        "graph": False,  # graph 는 순수 요청별(서버 기본 off)
        "rerank": bool(store.get("rag_rerank_enabled")),
        "hyde": bool(store.get("rag_hyde_enabled")),
        "verify": bool(store.get("rag_verify_enabled")),
        "rerank_available": llm_ready,
        "hyde_available": llm_ready,
        "verify_available": llm_ready,
    })


# --------------------------------------------------------------------------- #
# 런타임 관리자 설정 — .env 를 기본값으로, 재시작 없이 override(app_settings).
# --------------------------------------------------------------------------- #
class SettingsUpdatePayload(BaseModel):
    changes: dict[str, bool | int | float] = Field(default_factory=dict)


@router.get("/settings")
def get_settings(
    _: User = Depends(require_system_admin), db: Session = Depends(get_db)
):
    """튜닝 설정 목록 — 키별 유효값·기본값·override 여부 + 메타(타입·범위·재색인 필요)."""
    from app.modules.app_settings import store

    return success_response(data={"settings": store.all_effective(db)})


@router.put("/settings")
def update_settings(
    payload: SettingsUpdatePayload,
    actor: User = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    """override 적용(재시작 불필요). 알 수 없는 키·범위 밖은 400. 색인 시점 설정은
    변경돼도 기존 보고서엔 재색인해야 반영(응답에 requires_reindex 로 알림)."""
    from app.modules.app_settings import store

    try:
        applied = store.set_many(db, payload.changes, actor.id)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    reindex = sorted(
        k for k in applied
        if store.REGISTRY.get(k, {}).get("requires_reindex")
    )
    return success_response(
        data={"applied": applied, "requires_reindex": reindex},
        message="설정을 적용했습니다." + (
            " 재색인 후 반영되는 항목이 있습니다." if reindex else ""
        ),
    )


@router.delete("/settings/{key}")
def reset_setting(
    key: str,
    _: User = Depends(require_system_admin),
    db: Session = Depends(get_db),
):
    """override 삭제 → .env 기본값으로 복귀."""
    from app.modules.app_settings import store

    if key not in store.REGISTRY:
        return error_response(f"알 수 없는 설정: {key}", status_code=404)
    store.reset(db, key)
    return success_response(message="기본값으로 되돌렸습니다.")


# --------------------------------------------------------------------------- #
# RAG 검색 평가 — 골든셋(eval_cases) 관리 + 실행(app/ai/eval.py). 관리자 전용.
# --------------------------------------------------------------------------- #
class EvalCasePayload(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    expect_report_ids: list[int] = Field(default_factory=list)
    expect_entities: list[str] = Field(default_factory=list)
    graph: bool = False


class EvalRunPayload(BaseModel):
    k: int = Field(default=5, ge=1, le=20)
    graph: bool = False
    rerank: bool = False
    hyde: bool = False


def _case_view(c) -> dict:
    return {
        "id": c.id, "query": c.query,
        "expect_report_ids": list(c.expect_report_ids or []),
        "expect_entities": list(c.expect_entities or []),
        "graph": bool(c.graph),
    }


@router.get("/eval/cases")
def eval_list_cases(
    _: User = Depends(require_system_admin), db: Session = Depends(get_db)
):
    from app.modules.eval.models import EvalCase

    rows = db.execute(select(EvalCase).order_by(EvalCase.id)).scalars().all()
    return success_response(data={"cases": [_case_view(c) for c in rows]})


@router.post("/eval/cases", status_code=201)
def eval_create_case(
    payload: EvalCasePayload,
    _: User = Depends(require_system_admin), db: Session = Depends(get_db),
):
    from app.modules.eval.models import EvalCase

    c = EvalCase(
        query=payload.query.strip(),
        expect_report_ids=payload.expect_report_ids,
        expect_entities=[e.strip() for e in payload.expect_entities if e.strip()],
        graph=payload.graph,
    )
    db.add(c)
    db.commit()
    return success_response(data=_case_view(c))


@router.put("/eval/cases/{case_id}")
def eval_update_case(
    case_id: int, payload: EvalCasePayload,
    _: User = Depends(require_system_admin), db: Session = Depends(get_db),
):
    from app.modules.eval.models import EvalCase

    c = db.get(EvalCase, case_id)
    if c is None:
        return error_response("케이스를 찾을 수 없습니다.", status_code=404)
    c.query = payload.query.strip()
    c.expect_report_ids = payload.expect_report_ids
    c.expect_entities = [e.strip() for e in payload.expect_entities if e.strip()]
    c.graph = payload.graph
    db.commit()
    return success_response(data=_case_view(c))


@router.delete("/eval/cases/{case_id}")
def eval_delete_case(
    case_id: int,
    _: User = Depends(require_system_admin), db: Session = Depends(get_db),
):
    from app.modules.eval.models import EvalCase

    c = db.get(EvalCase, case_id)
    if c is not None:
        db.delete(c)
        db.commit()
    return success_response(message="삭제했습니다.")


@router.post("/eval/run")
def eval_run(
    payload: EvalRunPayload,
    actor: User = Depends(require_system_admin), db: Session = Depends(get_db),
):
    """골든셋 전체 평가 실행 → 케이스별·평균 지표. 실행자의 가시성 스코프 기준.
    임베딩/LLM 이 mock 이면 검색이 비결정적이라 숫자는 참고용."""
    from types import SimpleNamespace

    from app.ai import eval as rag_eval
    from app.modules.eval.models import EvalCase

    rows = db.execute(select(EvalCase).order_by(EvalCase.id)).scalars().all()
    if not rows:
        return error_response("평가할 케이스가 없습니다. 먼저 골든셋을 추가하세요.",
                              status_code=400)
    cases = [_case_view(c) for c in rows]
    eval_actor = SimpleNamespace(
        user=SimpleNamespace(id=actor.id),
        workspace=SimpleNamespace(virtual=False, slug="dx"),
        public_viewer=False,
    )
    result = rag_eval.run_eval(
        db, eval_actor, cases, k=payload.k, graph=payload.graph,
        rerank=payload.rerank or None, hyde=payload.hyde or None,
    )
    return success_response(data=result)


# --------------------------------------------------------------------------- #
# QA 피드백 — 답변 👍/👎 수집 + 👍 를 평가 골든셋으로 승격(로드맵 6 피드백).
# --------------------------------------------------------------------------- #
class FeedbackPayload(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    rating: int  # 1=👍, -1=👎
    report_ids: list[int] = Field(default_factory=list)


@router.post("/feedback", status_code=201)
def submit_feedback(
    payload: FeedbackPayload,
    actor=Depends(get_current_user), db: Session = Depends(get_db),
):
    """답변 품질 피드백 저장. 질문하기 쓰는 누구나(수집만 — 검색을 바꾸지 않음)."""
    from app.modules.eval.models import QaFeedback

    db.add(QaFeedback(
        user_id=actor.user.id,
        query=payload.query.strip(),
        rating=1 if payload.rating >= 0 else -1,
        report_ids=payload.report_ids or [],
    ))
    db.commit()
    return success_response(message="피드백 감사합니다.")


@router.get("/feedback/summary")
def feedback_summary(
    _: User = Depends(require_system_admin), db: Session = Depends(get_db)
):
    """관리자 요약 — 👍/👎 수 + 골든셋 승격 가능 건(👍·인용 있고 아직 케이스 없는 질문)."""
    from app.modules.eval.models import EvalCase, QaFeedback

    up = db.scalar(select(func.count()).select_from(QaFeedback).where(QaFeedback.rating > 0)) or 0
    down = db.scalar(select(func.count()).select_from(QaFeedback).where(QaFeedback.rating < 0)) or 0
    existing = {
        (c.query or "").strip()
        for c in db.execute(select(EvalCase)).scalars().all()
    }
    promotable = {
        (f.query or "").strip()
        for f in db.execute(
            select(QaFeedback).where(QaFeedback.rating > 0)
        ).scalars().all()
        if (f.report_ids and (f.query or "").strip()
            and (f.query or "").strip() not in existing)
    }
    return success_response(data={"up": up, "down": down, "promotable": len(promotable)})


@router.post("/eval/from-feedback")
def eval_from_feedback(
    _: User = Depends(require_system_admin), db: Session = Depends(get_db)
):
    """👍 피드백(질문+인용 보고서)을 평가 골든셋으로 승격. 이미 있는 질문은 건너뜀."""
    from app.modules.eval.models import EvalCase, QaFeedback

    existing = {
        (c.query or "").strip()
        for c in db.execute(select(EvalCase)).scalars().all()
    }
    by_query: dict[str, set[int]] = {}
    for f in db.execute(select(QaFeedback).where(QaFeedback.rating > 0)).scalars().all():
        q = (f.query or "").strip()
        if not q or q in existing or not f.report_ids:
            continue
        by_query.setdefault(q, set()).update(f.report_ids)
    created = 0
    for q, rids in by_query.items():
        db.add(EvalCase(query=q, expect_report_ids=sorted(rids),
                        expect_entities=[], graph=False))
        created += 1
    db.commit()
    return success_response(data={"created": created},
                            message=f"{created}건을 골든셋에 추가했습니다.")


# --------------------------------------------------------------------------- #
# 온톨로지 에이전트 — tool-calling(팔란티어식). 온톨로지 도구로 다단계 조사.
# --------------------------------------------------------------------------- #
class AgentPayload(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    max_hops: int = Field(default=6, ge=1, le=10)
    # 대화형 검색 — 이전 턴 [{role:'user'|'assistant', content}]. 프론트가 보관·전송,
    # 서버는 stateless(세션 없음). 맥락 재작성에만 쓰고 최근 N턴으로 상한.
    history: list[dict] = Field(default_factory=list)


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
            agent.run_agent, db, actor, payload.query,
            history=payload.history[-12:], max_hops=payload.max_hops,
        )
    except LLMError as exc:
        return error_response(f"AI 응답 실패: {exc}", status_code=502)
    return success_response(data=data)


# --------------------------------------------------------------------------- #
# 온톨로지 조사 도구 — 외부(MCP) 에이전트에 프리미티브를 노출. 내부 run_agent 가 쓰는
# 것과 동일한 읽기 도구(agent_tools)를 그대로 실행해, 외부 AI가 스스로 다단계로
# 온톨로지/객체/관계를 조사하게 한다. LLM 미호출·읽기 전용이라 인증-only.
# --------------------------------------------------------------------------- #
# 외부에 노출할 읽기 도구 화이트리스트(create/update 계열은 절대 노출 안 함).
_ONTOLOGY_TOOLS = {"list_object_types", "search_objects", "get_object"}


class OntologyToolPayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    args: dict = Field(default_factory=dict)


@router.post("/ontology/tool")
def ontology_tool(
    payload: OntologyToolPayload,
    actor=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """온톨로지 조사 도구 1개 실행 — 외부 AI(MCP)가 스스로 조사하는 프리미티브.

    게이트: 인증-only(엔티틀먼트 불필요) — LLM을 호출하지 않고, 보고서 근거는 도구
    내부 hybrid_search 가 가시성 게이팅한다(권한 밖 유출 X). 화이트리스트(_ONTOLOGY_TOOLS)
    밖 이름은 404. sync 도구라 FastAPI 가 스레드풀에서 실행."""
    from app.ai import agent_tools

    if payload.name not in _ONTOLOGY_TOOLS:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"알 수 없는 도구: {payload.name}"
        )
    result = agent_tools.run_tool(db, actor, payload.name, payload.args)
    return success_response(data=result.get("content", {}))


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


# --------------------------------------------------------------------------- #
# 대화형 에이전트 검색 — 저장된 대화 CRUD (사용자별 private, rag_qa 게이트)
# --------------------------------------------------------------------------- #
class ConversationSavePayload(BaseModel):
    title: str = Field(default="", max_length=200)
    messages: list = Field(default_factory=list)


class ConversationUpdatePayload(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    messages: list | None = None


def _conv_summary(c) -> dict:
    return {
        "id": c.id, "title": c.title,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        "turns": len(c.messages or []),
    }


def _require_rag_qa(db: Session, actor):
    from app.ai.entitlements import ai_enabled_for
    if not ai_enabled_for(db, actor.user, "rag_qa"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "AI 질문하기 권한이 없습니다.")


@router.get("/conversations")
def list_conversations(actor=Depends(get_current_user), db: Session = Depends(get_db)):
    from app.modules.ai import conversations as conv_svc
    _require_rag_qa(db, actor)
    items = [_conv_summary(c) for c in conv_svc.list_for_user(db, actor.user.id)]
    return success_response(data={"items": items})


@router.post("/conversations")
def create_conversation(
    payload: ConversationSavePayload,
    actor=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from app.modules.ai import conversations as conv_svc
    _require_rag_qa(db, actor)
    conv = conv_svc.create(db, actor.user.id, title=payload.title, messages=payload.messages)
    return success_response(data={"id": conv.id, **_conv_summary(conv)})


@router.get("/conversations/{conv_id}")
def get_conversation(
    conv_id: int, actor=Depends(get_current_user), db: Session = Depends(get_db),
):
    from app.modules.ai import conversations as conv_svc
    _require_rag_qa(db, actor)
    conv = conv_svc.get_owned(db, conv_id, actor.user.id)
    if conv is None:
        return error_response("대화를 찾을 수 없습니다.", status_code=404)
    return success_response(data={
        "id": conv.id, "title": conv.title, "messages": conv.messages or [],
        "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
    })


@router.put("/conversations/{conv_id}")
def update_conversation(
    conv_id: int,
    payload: ConversationUpdatePayload,
    actor=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from app.modules.ai import conversations as conv_svc
    _require_rag_qa(db, actor)
    conv = conv_svc.get_owned(db, conv_id, actor.user.id)
    if conv is None:
        return error_response("대화를 찾을 수 없습니다.", status_code=404)
    conv = conv_svc.update(db, conv, title=payload.title, messages=payload.messages)
    return success_response(data=_conv_summary(conv))


@router.delete("/conversations/{conv_id}")
def delete_conversation(
    conv_id: int, actor=Depends(get_current_user), db: Session = Depends(get_db),
):
    from app.modules.ai import conversations as conv_svc
    _require_rag_qa(db, actor)
    conv = conv_svc.get_owned(db, conv_id, actor.user.id)
    if conv is not None:
        conv_svc.delete(db, conv)
    return success_response(data=None, message="대화를 삭제했습니다.")


@router.post("/agent/stream")
async def agent_stream(
    payload: AgentPayload,
    request: Request,
    actor=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """에이전트 답변을 SSE 로 스트리밍 — 진행 상황(progress)·답변 토큰(token)·최종(done).
    rag_qa 게이트. 프론트 abort → 연결끊김 → 생성 중단(should_cancel). 이벤트는
    `data: {json}\\n\\n` 한 줄씩."""
    import json as _sse_json

    from fastapi.responses import StreamingResponse

    from app.ai import agent
    from app.ai.entitlements import ai_enabled_for

    if not ai_enabled_for(db, actor.user, "rag_qa"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "AI 질문하기 권한이 없습니다.")

    async def gen():
        try:
            async for evt in agent.run_agent_stream(
                db, actor, payload.query, history=payload.history[-12:],
                max_hops=payload.max_hops, should_cancel=request.is_disconnected,
            ):
                yield f"data: {_sse_json.dumps(evt, ensure_ascii=False)}\n\n"
        except LLMCancelled:
            return  # 연결 끊김 — 클라이언트는 이미 떠남
        except Exception as exc:  # noqa: BLE001 — 스트림 안에서 오류를 이벤트로 전달
            payload_err = {"type": "error", "message": f"AI 응답 실패: {exc}"}
            yield f"data: {_sse_json.dumps(payload_err, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
