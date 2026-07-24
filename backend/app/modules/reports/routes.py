"""Report routes — CRUD scoped to the actor's workspace tree."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from sqlalchemy import select

from app.database import get_db
from app.modules.reports import ai_authoring, services, versioning
from app.modules.reports.schemas import (
    AiDraftCreate,
    AiDraftUpdate,
    LinkGraphResponse,
    LockInfo,
    ReportCopy,
    ReportCreate,
    ReportEntitiesAdd,
    ReportLinkCreate,
    ReportLinkKindRead,
    ReportLinkRead,
    ReportLinkRefMini,
    ReportPage,
    ReportRead,
    ReportRename,
    ReportSummary,
    ReportUpdate,
    ReportVersionMeta,
)
from app.modules.section_taxonomy import services as section_taxonomy_services
from app.modules.templates import services as template_services
from app.modules.users.models import User
from app.widgets import authoring_rules
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def _parse_iso_date(d: str | None):
    """'YYYY-MM-DD' → date, 빈 값이면 None, 잘못된 형식이면 400. 검색/관계도 공용."""
    from datetime import date as _date

    if not d:
        return None
    try:
        return _date.fromisoformat(d)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid date: {d}")


def _read_with_perms(db: Session, actor: CurrentUser, report) -> ReportRead:
    """Build a ReportRead and stamp the per-actor edit decision.

    Used by detail/update/publish/unpublish/lock returns so the frontend
    can disable edit affordances without re-implementing the rule.
    List endpoints skip this — per-row resolution is too expensive and
    the list page falls back to optimistic show + 403 on save."""
    from app.shared.permissions import can_edit

    obj = ReportRead.model_validate(report)
    decision = can_edit(db, actor.user, report)
    obj.can_edit = decision.allowed
    obj.edit_role = decision.role
    # 삭제는 편집보다 좁은 권한(소유자/시스템관리자/게시판 매니저) — 프런트가
    # 삭제 버튼을 이 플래그로 게이팅하도록 함께 내려준다.
    obj.can_delete = services.can_delete_report(db, actor, report)
    # 소프트삭제(휴지통)·복구 권한 — 소유자/시스템관리자. 프런트 "삭제"(휴지통)
    # 버튼과 휴지통 복구 버튼을 이 값으로 게이팅.
    obj.can_trash = services.can_trash_report(db, actor, report)
    # 영구삭제(purge) 가능 여부 — 소유자/시스템관리자 AND 게시 중이 아닐 때만.
    # 게시 중이면 먼저 게시취소해야 해서 False(프런트가 "완전 삭제" 버튼을
    # 비활성/숨김 처리하고 안내).
    _mounted = services.report_mount_count(db, report.id) > 0
    obj.is_mounted = _mounted
    obj.can_purge = services.can_purge_report(db, actor, report) and not _mounted
    # 영구삭제 시 함께 사라질 종합보고 안건 수 — 삭제 경고용.
    obj.composite_ref_count = services.composite_ref_count(db, report.id)
    # 조직 간 공개(§6) — 외부 공개 열람자면 읽기전용 플래그를 세워 프런트가
    # 배너·곁다리 숨김을 그린다. virtual(글로벌/관리자)은 공개 열람자가 아님.
    is_public_view = not actor.workspace.virtual and (
        actor.public_viewer
        or services.is_public_only_viewer(db, actor, report)
    )
    obj.is_public_view = is_public_view
    obj.can_comment = not is_public_view
    return obj


def _ai_summary_map(db: Session, reports: list) -> dict[int, str]:
    """주어진 보고서들의 B300 자동 요약(§B)을 한 번에 조회 → {report_id: 요약문}.

    목록 "상태" 칸의 ✨ 칩용. 행마다 따로 부르지 않고 (report_id IN ...) 한 쿼리로
    묶는다. 빈 요약(summary='')은 '없음'으로 간주해 제외 — 프런트 칩 표시 기준과
    일치(요약 텍스트가 있을 때만 칩)."""
    from app.ai.models import ReportAiSummary

    ids = [r.id for r in reports]
    if not ids:
        return {}
    rows = db.execute(
        select(ReportAiSummary.report_id, ReportAiSummary.summary)
        .where(ReportAiSummary.report_id.in_(ids))
        .where(ReportAiSummary.summary != "")
    ).all()
    return {rid: text for rid, text in rows}


def _apply_ai_summary(summary: ReportSummary, report_id: int, ai_map: dict) -> None:
    """_ai_summary_map 결과를 ReportSummary 행에 반영(있으면 플래그+요약문)."""
    text = ai_map.get(report_id)
    if text:
        summary.has_ai_summary = True
        summary.ai_summary = text


def _lock_conflict_response(exc: services.LockError):
    """Translate a service-layer LockError into a 409 in the standard
    {success, message, errors} envelope. `errors[0]` carries a stable
    `code` string the frontend dispatches on; `holder` (when known) lets
    the takeover dialog render '현재 OO 편집 중' without a re-fetch.
    """
    detail: dict = {"code": exc.code, "message": str(exc)}
    if exc.holder is not None:
        detail["holder"] = LockInfo.model_validate({
            "user_id": exc.holder.user_id,
            "user_name": getattr(exc.holder.user, "name", None),
            "user_email": getattr(exc.holder.user, "email", None),
            "acquired_at": exc.holder.acquired_at,
            "expires_at": exc.holder.expires_at,
        }).model_dump(mode="json")
    return error_response(str(exc), errors=[detail], status_code=409)


@router.get("")
def list_reports(
    entity_ids: list[int] | None = Query(default=None, alias="entity_ids"),
    entity_rollup: bool = Query(
        default=False,
        description=(
            "관계(part_of) 롤업. True 면 entity_ids 의 각 축 필터를 그 자손까지 "
            "넓힌다 — 예: 모델로 필터하면 그 모델의 부품 태그 보고서까지 포함. "
            "기본 False(직접 태그만). 관계가 없으면 효과 없음(엔티티관리개선 B-2)."
        ),
    ),
    folder_id: str | None = Query(
        default=None,
        description=(
            "Personal-space folder filter. Pass an integer id to show "
            "only that folder's reports, or 'uncategorized' for "
            "folder_id IS NULL. Ignored on org workspaces."
        ),
    ),
    include_public: bool = Query(
        default=False,
        description=(
            "조직 간 공개 탐색(opt-in). True 면 org 컨텍스트에서 다른 조직의 "
            "공개 보고서까지 '내 스코프 ∪ 공개분' 으로 합쳐 보여준다. 기본 "
            "목록은 False — 자기 게시판 분만(조직간공개_설계.md §5)."
        ),
    ),
    include_descendants: bool = Query(
        default=False,
        description=(
            "org 컨텍스트에서 하위 부서(자손) 게시판에 게시된 보고서까지 "
            "포함. 기본 게시판 목록은 자기 것만(False) 이지만, 종합보고 "
            "안건 picker 처럼 상위 조직이 하위팀 보고서를 묶어야 할 때 True."
        ),
    ),
    trashed: bool = Query(
        default=False,
        description=(
            "휴지통 보기 — 개인 공간 컨텍스트에서 소프트삭제된(deleted_at) "
            "보고서만 반환. 기본 False(살아있는 것만). org 게시판 목록은 "
            "게시분 보존이라 이 플래그와 무관하게 게시된 것을 그대로 보여준다."
        ),
    ),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """List reports in the actor's workspace tree.

    Optional `entity_ids` (repeated) applies the N-axis tag filter:
    OR within an axis, AND across axes. Sent by the list-page filter
    bar; absent for the default unfiltered view.

    `folder_id` is meaningful only in personal-workspace context; the
    backend currently ignores it on org workspaces because folders are
    a per-user concept (Phase 4 may extend cross-workspace folders).
    """
    # Translate the folder filter — string-typed at the API edge so we
    # can carry the special "uncategorized" sentinel without overloading
    # integer semantics. Defensive: silently drop garbage.
    folder_filter: int | str | None = None
    if folder_id == "uncategorized":
        folder_filter = "uncategorized"
    elif folder_id is not None:
        try:
            folder_filter = int(folder_id)
        except ValueError:
            folder_filter = None
    # 외부 공개 열람자(비멤버, 읽기전용 진입) — 이 게시판의 공개분만 본다.
    # 멤버용 스코프 목록을 타면 비공개까지 새므로 별도 경로(조직간공개 §7.3).
    if actor.public_viewer:
        # 비멤버 읽기전용 진입(전체공개 컨텐츠가 있거나, 이 게시판/폴더가 내
        # 부서에 공유됨). grant 로 볼 수 있는 게시분만 보여준다 — 전체공개분은
        # 외부공개 뱃지, 부서/폴더 공유분은 일반 표시.
        reports = services.list_visible_reports_on_board(
            db,
            actor,
            entity_ids=entity_ids,
            entity_rollup=entity_rollup,
            folder_filter=folder_filter,
        )
        pub = services.public_report_ids(db)
        ai_map = _ai_summary_map(db, reports)
        payload = []
        for r in reports:
            summary = ReportSummary.model_validate(r)
            summary.is_external_public = r.id in pub
            _apply_ai_summary(summary, r.id, ai_map)
            payload.append(summary)
        return success_response(data=payload)

    reports = services.list_reports_in_workspace(
        db,
        actor.workspace.slug,
        is_global_view=actor.workspace.virtual,
        entity_ids=entity_ids,
        entity_rollup=entity_rollup,
        folder_filter=folder_filter,
        include_public=include_public,
        include_descendants=include_descendants,
        trashed=trashed,
    )
    # 공개 탐색 시 "내 스코프 밖 + 공개" 인 행을 표시 — 프런트가 뱃지로 구분.
    external_ids: set[int] = set()
    if include_public and not actor.workspace.virtual:
        scoped = services.visible_report_ids(db, actor) or set()
        external_ids = services.public_report_ids(db) - scoped
    ai_map = _ai_summary_map(db, reports)
    # 목록에서 바로 제목을 고칠 수 있는 행 — 편집 권한(can_edit)을 배치로 판정.
    editable = services.editable_report_ids(db, actor, reports)
    payload = []
    for r in reports:
        summary = ReportSummary.model_validate(r)
        if r.id in external_ids:
            summary.is_external_public = True
        summary.can_edit = r.id in editable
        _apply_ai_summary(summary, r.id, ai_map)
        payload.append(summary)
    return success_response(data=payload)


@router.get("/search")
def search_reports(
    q: str = Query(default="", max_length=200, description="검색어(빈 값이면 전체 탐색)"),
    location: str = Query(default="all", description="위치 필터: all|personal|boards"),
    board: str = Query(default="", max_length=200, description="특정 게시판(부서) slug"),
    entity_ids: list[int] | None = Query(default=None, alias="entity_ids"),
    entity_rollup: bool = Query(
        default=False,
        description="관계(part_of) 롤업 — entity_ids 필터를 자손까지 확장",
    ),
    year: int | None = Query(
        default=None,
        ge=1900,
        le=2200,
        description="자료 연도 — 보고서 작성연도(report_date) 필터. 미지정=전체",
    ),
    date_from: str | None = Query(
        default=None, description="날짜범위 시작(YYYY-MM-DD, 포함). date_field 기준"
    ),
    date_to: str | None = Query(
        default=None, description="날짜범위 끝(YYYY-MM-DD, 포함)"
    ),
    date_field: str = Query(
        default="report_date",
        description="날짜 기준 필드: report_date(작성일자·기본)|created_at(등록시각)",
    ),
    last_days: int | None = Query(
        default=None, ge=1, le=3650,
        description="상대 날짜 — 최근 N일([오늘-(N-1), 오늘]). date_from/to 미지정 시만.",
    ),
    period: str | None = Query(
        default=None,
        description="상대 기간 — today|yesterday|this_week|this_month|this_year",
    ),
    report_type_ids: list[int] | None = Query(default=None),
    author_ids: list[int] | None = Query(
        default=None, description="작성자(owner) user id 필터(OR)"
    ),
    editor_ids: list[int] | None = Query(
        default=None, description="최근 편집자(last_edited_by) user id 필터(OR)"
    ),
    phases: list[str] | None = Query(
        default=None, description="협업 단계 drafting|reviewing|finalized (OR)"
    ),
    lifecycles: list[str] | None = Query(
        default=None, description="진행 상태 single_shot|ongoing (OR)"
    ),
    tags: list[str] | None = Query(default=None, description="자유 태그(OR·배열 교집합)"),
    sort: str = Query(
        default="relevance",
        description="정렬: relevance(기본)|recent(작성일 최신)|oldest(작성일 오래된)",
    ),
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """보고서 전문검색/탐색 — 제목 + 모든 위젯 텍스트(search_text, pg_trgm 부분일치).
    q 가 비면 가시 범위 전체를 최신순으로(브라우즈). location 으로 내공간/부서게시판,
    board(slug)로 특정 부서 게시판 필터(board 가 location 보다 우선). `entity_ids`(반복)
    로 엔티티 태그 필터를 결합 — "본문 'X' AND 모델=A1234"(D-2). 가시 범위(소유·공유·
    게시) 안에서만 — 다른 부서도 권한 범위에서. 휴지통 제외, 검색 시 스니펫.

    (B) 날짜범위(date_from/to 또는 last_days/period)·종류(report_type_ids)·작성자
    (author_ids)·편집자(editor_ids)·단계(phases)·진행상태(lifecycles)·태그(tags) 필터."""
    if location not in ("all", "personal", "boards"):
        location = "all"
    if date_field not in services.DATE_FIELDS:
        date_field = "report_date"
    d_from, d_to = services.resolve_date_range(
        date_from=_parse_iso_date(date_from), date_to=_parse_iso_date(date_to),
        last_days=last_days, period=period,
    )
    if sort not in ("relevance", "recent", "oldest"):
        sort = "relevance"
    rows, total = services.search_reports(
        db, actor, q, limit=limit, offset=offset, location=location, board=board,
        entity_ids=entity_ids, entity_rollup=entity_rollup, year=year,
        date_from=d_from, date_to=d_to, date_field=date_field,
        report_type_ids=report_type_ids, author_ids=author_ids, editor_ids=editor_ids,
        phases=phases, lifecycles=lifecycles, tags=tags, sort=sort,
    )
    needle = q.strip()
    results = [
        {
            "report": ReportSummary.model_validate(r),
            "snippet": services.search_snippet(r.search_text, needle) if needle else None,
        }
        for r in rows
    ]
    return success_response(
        data={"results": results, "total": total, "limit": limit, "offset": offset}
    )


@router.get("/search/semantic")
def semantic_search_reports(
    q: str = Query(..., min_length=1, max_length=400, description="의미 검색어"),
    mode: str = Query(default="hybrid", description="hybrid|semantic"),
    entity_ids: list[int] | None = Query(default=None, alias="entity_ids"),
    entity_rollup: bool = Query(
        default=False, description="관계(part_of) 롤업 — entity_ids 를 자손까지 확장"
    ),
    year: int | None = Query(
        default=None, ge=1900, le=2200,
        description="자료 연도 — 보고서 작성연도(report_date) 필터. 미지정=전체",
    ),
    date_from: str | None = Query(default=None, description="날짜범위 시작(YYYY-MM-DD)"),
    date_to: str | None = Query(default=None, description="날짜범위 끝(YYYY-MM-DD)"),
    date_field: str = Query(
        default="report_date", description="report_date|created_at"
    ),
    last_days: int | None = Query(default=None, ge=1, le=3650),
    period: str | None = Query(default=None),
    report_type_ids: list[int] | None = Query(default=None),
    author_ids: list[int] | None = Query(default=None),
    editor_ids: list[int] | None = Query(default=None),
    phases: list[str] | None = Query(default=None),
    lifecycles: list[str] | None = Query(default=None),
    tags: list[str] | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """시맨틱/하이브리드 검색 — 임베딩(report_chunks) 기반 의미 검색.

    mode=semantic: 벡터 유사도만. mode=hybrid(기본): 벡터+키워드(pg_trgm)를 RRF 융합.
    `entity_ids`(반복)로 엔티티 태그 필터를 결합(D-2) — 의미 검색에도 "태그=모델 X"를
    얹는다. (B) 날짜범위·종류·작성자·편집자·단계·진행상태·태그 필터도 벡터 scope 에
    교집합으로 얹는다. 가시성은 키워드 검색과 동일 규칙(권한 밖 보고서 미노출). 결과
    항목: {report_id, title, snippet, score|rrf_score, block_id, page_idx, ...}.
    """
    # 지연 import — ai 패키지(pgvector)를 reports 라우터 import 시점에 끌지 않게.
    from app.ai import search as ai_search

    if date_field not in services.DATE_FIELDS:
        date_field = "report_date"
    d_from, d_to = services.resolve_date_range(
        date_from=_parse_iso_date(date_from), date_to=_parse_iso_date(date_to),
        last_days=last_days, period=period,
    )
    column_filters = {
        "date_from": d_from, "date_to": d_to, "date_field": date_field,
        "report_type_ids": report_type_ids, "author_ids": author_ids,
        "editor_ids": editor_ids, "phases": phases, "lifecycles": lifecycles,
        "tags": tags,
    }
    if mode == "semantic":
        results = ai_search.semantic_search(
            db, q, actor, limit=limit,
            entity_ids=entity_ids, entity_rollup=entity_rollup, year=year,
            column_filters=column_filters,
        )
    else:
        mode = "hybrid"
        results = ai_search.hybrid_search(
            db, q, actor, limit=limit,
            entity_ids=entity_ids, entity_rollup=entity_rollup, year=year,
            column_filters=column_filters,
        )
    return success_response(data={"results": results, "mode": mode, "limit": limit})


# /{report_id} 동적 path 보다 *위* 에 등록해야 한다 — 그래야 FastAPI 가
# `link-kinds` 문자열을 reportId 로 잡으려고 시도(422)하지 않고 이 정적
# path 와 먼저 매칭한다.
@router.get("/link-kinds")
def list_link_kinds_public(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(get_current_user),
):
    """모든 인증 사용자가 picker / chip 렌더에 쓰는 카탈로그. admin 만
    편집 가능하지만 조회는 공개."""
    rows = services.list_link_kinds(db)
    return success_response(
        data=[ReportLinkKindRead.model_validate(r) for r in rows]
    )


@router.get("/linkable-facets")
def get_linkable_facets(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Link 대상 picker 의 작성자 / 게시조직 필터 옵션. 한 번에 두 facet
    을 반환해 picker 의 popover open 비용을 가볍게 만든다.

    응답:
        {
          "authors": [{"name": "김XX", "count": 12}, ...],
          "mounts":  [{"slug": "team1", "name": "팀1", "count": 5}, ...]
        }
    """
    return success_response(data=services.list_linkable_facets(db, actor))


@router.get("/linkable")
def list_linkable_reports_route(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(get_current_user),
):
    """Link 대상 picker 의 후보 보고서 풀 — 전 시스템 linkable.
    actor 워크스페이스 밖 보고서도 검색할 수 있어야 하므로 list_reports
    와 별도 endpoint. ReportSummary 와 동일한 shape."""
    reports = services.list_linkable_reports(db)
    payload = [ReportSummary.model_validate(r) for r in reports]
    return success_response(data=payload)


@router.get("/link-graph")
def get_global_link_graph(
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    types: list[int] | None = Query(default=None),
    kinds: list[str] | None = Query(default=None),
    entities: list[int] | None = Query(default=None),
    include_tags: bool = Query(default=False),
    tag_axes: list[str] | None = Query(default=None),
    tag_min_degree: int = Query(default=1, ge=1, le=20),
    include_composites: bool = Query(default=False),
    include_isolated: bool = Query(default=False),
    scope: str = Query(
        default="subtree",
        description=(
            "관계도 스코프 — 'board'=이 게시판에 게시된 보고서만, "
            "'subtree'=이 게시판 + 하위 부서 게시판까지 롤업."
        ),
    ),
    include_external: bool = Query(
        default=False,
        description=(
            "스코프 밖이지만 스코프 내 보고서와 연결된 보고서도 노드로 추가"
            "(권한상 볼 수 있는 것만)."
        ),
    ),
    limit: int = Query(default=services.LINK_GRAPH_GLOBAL_LIMIT, ge=1, le=2000),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """워크스페이스 범위의 글로벌 관계도 (지식그래프 Phase 1b).

    `/{report_id}` 동적 path 보다 위에 등록 — `link-graph` 문자열이 reportId
    로 잡히지 않도록. 스코핑은 actor.workspace (virtual 이면 전체). 연결된
    보고서만 그린다 (고립 노드 제외)."""
    from datetime import date as _date

    def _parse(d: str | None) -> _date | None:
        if not d:
            return None
        try:
            return _date.fromisoformat(d)
        except ValueError:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Invalid date: {d}"
            )

    graph = services.build_global_link_graph(
        db,
        actor=actor,
        workspace_slug=actor.workspace.slug,
        is_global_view=actor.workspace.virtual,
        date_from=_parse(date_from),
        date_to=_parse(date_to),
        type_ids=types,
        kinds=kinds,
        entity_ids=entities,
        include_tags=include_tags,
        tag_axes=tag_axes,
        tag_min_degree=tag_min_degree,
        include_composites=include_composites,
        include_isolated=include_isolated,
        scope_mode="board" if scope == "board" else "subtree",
        include_external=include_external,
        limit=limit,
    )
    return success_response(data=LinkGraphResponse.model_validate(graph))


# ─── AI 작성(MCP) — 작성 안내 + 초안 생성 ───────────────────────────────
# /{report_id} 보다 위에 등록(정적 path 가 동적 path 에 안 가려지게).
@router.get("/authoring-guide")
def report_authoring_guide(
    template_id: str = Query(..., min_length=1, max_length=64),
    template_version: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(get_current_user),
):
    """이 템플릿으로 보고서를 쓸 때 각 블록을 무엇으로 채우는지 안내(AI/MCP describe_template 용)."""
    template = template_services.get_template(db, template_id, template_version)
    if not template:
        return not_found_response(f"Template not found: {template_id}@{template_version}")
    # 이 템플릿에 쓰인 위젯들의 **상세 작성 룰**(content 형식·주의·혼동 위젯 등) —
    # 프런트 '복사용 프롬프트'와 같은 단일 소스(authoring_rules.json).
    block_types = {
        b.get("type")
        for b in (template.schema.get("blocks") or [])
        if isinstance(b, dict) and b.get("type")
    }
    return success_response(
        data={
            "template_id": template_id,
            "template_version": template_version,
            "blocks": ai_authoring.build_authoring_guide(template.schema),
            # few-shot — 이 템플릿을 채운 ai-draft 입력 예시({title, blocks}).
            "example_input": ai_authoring.build_example_input(template.schema),
            # 위젯별 상세 룰(있는 블록만). extra_blocks 로 다른 위젯을 만들 땐
            # describe_widgets(types) 로 그 위젯들의 룰을 받아 따른다.
            "widget_rules": authoring_rules.rules_for_types(block_types),
            # 단락 구분(block_sections) 코드 목록 — 카테고리별. block_sections 값은
            # 반드시 여기 있는 `code` 만 쓴다(라벨/한글 금지). 적절한 게 없으면 생략.
            "section_taxonomy": section_taxonomy_services.taxonomy_for_ai(db),
        }
    )


def _build_ai_page(
    template,
    valid_codes: set,
    page_in: dict,
    template_id: str,
    template_version: int,
) -> tuple[ReportPage, list[str]]:
    """한 페이지 입력({blocks?, extra_blocks?, block_sections?, name?}) → ReportPage.
    채운 위젯만 표시(blocks_order)·자동 배치·단락 코드 검증을 한 곳에서.
    create(전체 생성)·update 의 전체 교체 경로가 공유한다."""
    w: list[str] = []
    content, cw = ai_authoring.normalize_content(
        template.schema, page_in.get("blocks") or {}
    )
    w += cw
    # AI 가 직접 정의한 위젯(extra_blocks) — 빈 템플릿이어도 위젯을 만들며 짓게.
    extra_defs, extra_content, ew = ai_authoring.normalize_extra_blocks(
        page_in.get("extra_blocks") or []
    )
    w += ew
    content = {**content, **extra_content}
    # 채운 위젯만 보이게(빈 템플릿 블록 숨김): 채운 템플릿 블록(템플릿 순서) → 추가 블록.
    filled_tpl_ids = [
        b["id"]
        for b in (template.schema.get("blocks") or [])
        if isinstance(b, dict) and b.get("id") in content
    ]
    blocks_order = filled_tpl_ids + [d["id"] for d in extra_defs]
    rendered = set(blocks_order)
    layout_overrides = (
        ai_authoring.auto_layout(
            template.schema, include_ids=filled_tpl_ids, extra_blocks=extra_defs
        )
        or None
    )
    sections, sw = _resolve_block_sections(
        page_in.get("block_sections") or {}, rendered, valid_codes
    )
    w += sw
    name = page_in.get("name")
    return (
        ReportPage(
            template_id=template_id,
            template_version=template_version,
            name=(str(name)[:120] if name else None),
            content=content,
            extra_blocks=extra_defs,
            blocks_order=blocks_order,
            layout_overrides=layout_overrides,
            block_sections=sections,
        ),
        w,
    )


def _resolve_block_sections(
    raw: dict, rendered: set, valid_codes: set
) -> tuple[dict, list[str]]:
    """{block_id: section_code} → 그 페이지에 실제로 있는 블록 + 등록된 코드만 남김.
    빈/None 코드는 '단락 없음'으로 보고 무시한다(병합 경로에서 제거에 쓰임)."""
    out: dict = {}
    w: list[str] = []
    for bid, code in (raw or {}).items():
        if not code:
            continue
        if bid not in rendered:
            w.append(f"block_sections '{bid}': 이 페이지에 없는 블록 — 무시")
        elif code not in valid_codes:
            w.append(f"block_sections '{code}': 등록된 단락 코드 아님 — 무시")
        else:
            out[bid] = code
    return out, w


def _merge_ai_page(
    template,
    valid_codes: set,
    page_dict: dict,
    payload: AiDraftUpdate,
) -> tuple[ReportPage, list[str]]:
    """기존 페이지(dict) 위에 AI 입력을 **병합**해 새 ReportPage 를 만든다.
    준 블록만 덮어쓰고, 안 건드린 블록·수동 레이아웃은 유지한다(블록 구성이
    바뀐 경우에만 auto_layout 으로 재배치)."""
    w: list[str] = []
    content = dict(page_dict.get("content") or {})
    extra_defs = [d for d in (page_dict.get("extra_blocks") or []) if isinstance(d, dict)]
    sections = dict(page_dict.get("block_sections") or {})
    orig_order = list(page_dict.get("blocks_order") or [])

    # 1) 템플릿 블록 병합(덮어쓰기).
    new_content, cw = ai_authoring.normalize_content(template.schema, payload.blocks or {})
    w += cw
    content.update(new_content)
    # 2) extra_blocks 병합 — 같은 id 는 교체, 새 id 는 추가.
    new_defs, new_extra_content, ew = ai_authoring.normalize_extra_blocks(
        payload.extra_blocks or []
    )
    w += ew
    by_id = {d["id"]: d for d in extra_defs}
    for d in new_defs:
        by_id[d["id"]] = d
    extra_defs = list(by_id.values())
    content.update(new_extra_content)
    # 3) 제거.
    for bid in payload.remove_blocks or []:
        content.pop(bid, None)
        sections.pop(bid, None)
    extra_defs = [d for d in extra_defs if d["id"] in content]

    # 4) 순서·레이아웃 재계산. 블록 구성(집합)이 그대로면 수동 순서·레이아웃을
    #    보존하고, 추가/제거가 있을 때만 auto_layout 으로 다시 배치한다.
    filled_tpl_ids = [
        b["id"]
        for b in (template.schema.get("blocks") or [])
        if isinstance(b, dict) and b.get("id") in content
    ]
    extra_ids = [d["id"] for d in extra_defs]
    new_order = filled_tpl_ids + extra_ids
    if set(new_order) == set(orig_order):
        blocks_order = orig_order
        layout_overrides = page_dict.get("layout_overrides")
    else:
        blocks_order = new_order
        layout_overrides = (
            ai_authoring.auto_layout(
                template.schema, include_ids=filled_tpl_ids, extra_blocks=extra_defs
            )
            or None
        )
    rendered = set(blocks_order)

    # 5) 단락 — 준 값으로 갱신(빈/None 은 해제), 없는 블록 태그는 정리.
    for bid, code in (payload.block_sections or {}).items():
        if not code:
            sections.pop(bid, None)
        elif bid not in rendered:
            w.append(f"block_sections '{bid}': 이 페이지에 없는 블록 — 무시")
        elif code not in valid_codes:
            w.append(f"block_sections '{code}': 등록된 단락 코드 아님 — 무시")
        else:
            sections[bid] = code
    sections = {k: v for k, v in sections.items() if k in rendered}

    return (
        ReportPage(
            template_id=page_dict.get("template_id") or template.template_id,
            template_version=page_dict.get("template_version") or template.version,
            name=page_dict.get("name"),
            content=content,
            extra_blocks=extra_defs,
            blocks_order=blocks_order,
            layout_overrides=layout_overrides,
            props_overrides=page_dict.get("props_overrides"),
            block_sections=sections,
        ),
        w,
    )


@router.post("/ai-draft")
def create_ai_draft(
    payload: AiDraftCreate,
    db: Session = Depends(get_db),
    # 초안은 작성자 **개인 공간**에 생성되므로 활성 보드 쓰기 권한과 무관 —
    # 공유/공개로 읽기만 가능한 보드를 보고 있어도 AI 작성이 가능해야 한다.
    # (require_writer 는 활성 보드를 게이트해 public_viewer 를 막아 버렸음.)
    # 가상 워크스페이스(_global)는 아래 본문에서 별도로 거절한다.
    actor: CurrentUser = Depends(get_current_user),
):
    """AI(Claude)가 만든 느슨한 블록을 받아 정규화·검증 후 **초안**으로 생성. 검증
    실패 시 블록별 에러를 400 으로 돌려 AI 가 고쳐 재호출하게 한다."""
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 워크스페이스에선 보고서를 만들 수 없습니다."
        )
    template = template_services.get_template(
        db, payload.template_id, payload.template_version
    )
    # 존재 + **이 계정이 볼 수 있는지** 확인. 초안은 작성자 개인 공간에 생성되고
    # 렌더도 계정 접근권 기준이라, '현재(활성) 워크스페이스'가 아니라 '이 계정이
    # 그 템플릿을 볼 수 있나'(is_visible_to_user)로 판정한다 — 읽기전용 공유 보드를
    # 보고 있어도, 자신이 멤버인 부서 전용 템플릿으로 AI 작성이 가능해야 한다.
    if not template or not template_services.is_visible_to_user(
        db, template, actor.user.id
    ):
        return not_found_response(
            f"Template not found or not visible to this account: "
            f"{payload.template_id}@{payload.template_version}"
        )
    valid_codes = section_taxonomy_services.valid_codes(db)

    # 멀티페이지: payload.pages 가 있으면 그걸로, 없으면 상단 단일 페이지 필드로 1쪽.
    page_inputs = payload.pages or [
        {
            "blocks": payload.blocks,
            "extra_blocks": payload.extra_blocks,
            "block_sections": payload.block_sections,
        }
    ]
    pages: list[ReportPage] = []
    warnings: list[str] = []
    multi = len(page_inputs) > 1
    for idx, pin in enumerate(page_inputs, 1):
        if not isinstance(pin, dict):
            warnings.append(f"pages[{idx}] 형식 오류 — 건너뜀")
            continue
        rp, w = _build_ai_page(
            template, valid_codes, pin, payload.template_id, payload.template_version
        )
        pages.append(rp)
        warnings += [f"p{idx}: {x}" for x in w] if multi else w
    if not pages:
        return error_response("생성할 페이지가 없습니다.", status_code=400)
    report_create = ReportCreate(
        template_id=payload.template_id,
        template_version=payload.template_version,
        title=payload.title,
        pages=pages,
        # 메타데이터(선택) — 일반 생성과 동일 경로로 적용. None 은 기본/미설정.
        report_date=payload.report_date,
        tags=payload.tags if payload.tags is not None else [],
        report_type_id=payload.report_type_id,
        entity_ids=payload.entity_ids,
    )
    # 일반 create_report 와 동일 — 작성자 **개인 공간**에 초안(drafting)으로.
    # (부서 전용 템플릿을 써도, 보고서 렌더는 계정 접근권 기준으로 템플릿을
    #  불러오므로 개인공간에서도 정상 표시된다 — templates.get_specific_version 참고.)
    target_workspace = f"personal-{actor.user.id}"
    try:
        report = services.create_report(
            db, target_workspace, report_create, owner_user_id=actor.user.id
        )
    except ValueError as exc:
        # 정규화로도 못 맞춘 부분 — 블록별 검증 에러를 그대로 전달(AI 재시도용).
        return error_response(str(exc), status_code=400)
    return created_response(
        data={
            "report": _read_with_perms(db, actor, report),
            "warnings": warnings,
            "url": f"/w/{report.workspace_slug}/reports/{report.id}",
        }
    )


# 정적 path — 동적 `/{report_id}` 보다 *위*에 등록(그래야 "my-drafts" 를 reportId 로
# 잡으려다 422 가 나지 않는다).
@router.get("/my-drafts")
def list_my_drafts(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """내가 만든 **작성 중(drafting)** 보고서 목록(최근 수정 순). AI 가 이어서
    수정(update_report_draft)할 초안을 찾을 때. 휴지통(소프트삭제)은 제외."""
    from app.modules.reports.models import Report, ReportPhase

    rows = (
        db.execute(
            select(Report)
            .where(
                Report.owner_user_id == actor.user.id,
                Report.phase == ReportPhase.drafting,
                Report.deleted_at.is_(None),
            )
            .order_by(Report.updated_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    drafts = [
        {
            "report_id": r.id,
            "title": r.title,
            "template_id": r.template_id,
            "template_version": r.template_version,
            "page_count": len(r.pages or []) or 1,
            "updated_at": r.updated_at,
            "url": f"/w/{r.workspace_slug}/reports/{r.id}",
        }
        for r in rows
    ]
    return success_response(data={"drafts": drafts, "count": len(drafts)})


@router.patch("/{report_id}/ai-draft")
def update_ai_draft(
    report_id: int,
    payload: AiDraftUpdate,
    db: Session = Depends(get_db),
    # 본인 소유 + drafting 검사는 아래 본문에 있어 활성 보드 쓰기 권한은 불필요 —
    # 읽기전용 보드를 보고 있어도 본인 초안은 이어서 수정할 수 있어야 한다.
    actor: CurrentUser = Depends(get_current_user),
):
    """AI(Claude/MCP)가 **기존 초안**을 이어서 수정. 비대화형이라 편집 락이 잡혀
    있으면(본인 다른 탭 포함) 막는다 — 진행 중 사람 편집을 보호. 사내 'Local LLM
    작성'은 사용자가 직접 편집 중 호출하고 고지를 받으므로 본인 락을 허용한다
    (`_apply_ai_draft(allow_self_lock=True)`)."""
    return _apply_ai_draft(report_id, payload, db, actor, allow_self_lock=False)


def _apply_ai_draft(
    report_id: int,
    payload: AiDraftUpdate,
    db: Session,
    actor: CurrentUser,
    *,
    allow_self_lock: bool = False,
):
    """AI 초안 적용 본체. `allow_self_lock=True` 면 **본인이 잡은** 편집 락은
    충돌로 보지 않는다(다른 사용자의 락은 그대로 막음). 기본은 병합 — 준 블록만
    덮어쓰고 나머지는 둔다. 검증 실패 시 블록별 에러를 400 으로 돌린다."""
    from app.modules.reports.models import ReportPhase

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    # 안전장치 — 본인이 만든 보고서만, 그리고 작성 중(drafting)일 때만 AI 수정.
    # (리뷰/발행 단계는 사람이 화면에서. 발행본은 발행취소 후 수정.)
    if report.owner_user_id != actor.user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "본인이 만든 보고서만 AI로 수정할 수 있습니다."
        )
    if report.phase != ReportPhase.drafting:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"작성 중(drafting) 보고서만 AI로 수정할 수 있습니다 (현재: {report.phase.value}).",
        )
    # 동시성 — 누군가(본인 다른 탭 포함) 편집 화면을 열어 **편집 락을 잡고 있으면**
    # AI 수정을 막는다. AI 는 비대화형이라 락 없이 저장하므로(require_lock=False),
    # 이 사전 점검이 진행 중인 사람 편집을 덮어쓰는 걸 막는 1차 방어선이다.
    # (락 해제/만료 후 재시도하면 됨. revision 증가·버전 이력이 2차 안전망.)
    held = services.get_active_lock(db, report)
    # allow_self_lock: 사내 'Local LLM 작성'은 사용자가 편집 중(=본인 락) 호출하고
    # "저장 안 된 편집분이 사라질 수 있음" 고지를 받으므로 본인 락은 통과시킨다.
    # 다른 사용자가 잡은 락은 어느 경우든 막는다(남의 편집 보호).
    if held is not None and not (allow_self_lock and held.user_id == actor.user.id):
        msg = (
            "다른 사용자가 이 보고서를 편집 중이라 AI 작성을 적용할 수 없습니다. "
            "상대가 편집을 마친 뒤 다시 시도하세요."
            if allow_self_lock
            else "이 보고서를 편집 중인 세션이 있어 AI 수정을 적용할 수 없습니다. "
            "편집 화면을 닫거나 잠금 해제 후 다시 시도하세요."
        )
        return _lock_conflict_response(
            services.LockHeldByOtherError(msg, holder=held)
        )

    template = template_services.get_template(
        db, report.template_id, report.template_version
    )
    if not template:
        return not_found_response(
            f"Template not found: {report.template_id}@{report.template_version}"
        )
    valid_codes = section_taxonomy_services.valid_codes(db)
    warnings: list[str] = []

    if payload.pages is not None:
        # 전체 교체 — 보고서를 이 페이지 목록으로 다시 만든다(생성과 동일 규칙).
        if not payload.pages:
            return error_response("`pages` 가 비어 있습니다.", status_code=400)
        new_pages: list[ReportPage] = []
        multi = len(payload.pages) > 1
        for idx, pin in enumerate(payload.pages, 1):
            if not isinstance(pin, dict):
                warnings.append(f"pages[{idx}] 형식 오류 — 건너뜀")
                continue
            rp, w = _build_ai_page(
                template, valid_codes, pin, report.template_id, report.template_version
            )
            new_pages.append(rp)
            warnings += [f"p{idx}: {x}" for x in w] if multi else w
        if not new_pages:
            return error_response("생성할 페이지가 없습니다.", status_code=400)
    else:
        # 병합 — 대상 페이지(1-base) 위에 준 블록만 덮어쓴다.
        existing = [p for p in (report.pages or []) if isinstance(p, dict)]
        if not existing:
            existing = [
                {
                    "template_id": report.template_id,
                    "template_version": report.template_version,
                    "content": report.content or {},
                    "layout_overrides": report.layout_overrides,
                    "props_overrides": report.props_overrides,
                }
            ]
        idx0 = payload.page - 1
        if idx0 > len(existing):
            return error_response(
                f"page {payload.page}: 이 보고서엔 {len(existing)}쪽뿐입니다 "
                f"(이어서 추가하려면 page={len(existing) + 1}).",
                status_code=400,
            )
        # 기존 페이지는 저장된 그대로 보존(레이아웃 포함) — dict→ReportPage 변환만.
        kept = [
            ReportPage(**{k: v for k, v in p.items() if k in ReportPage.model_fields})
            for p in existing
        ]
        if idx0 == len(existing):
            # 끝 다음 페이지 = **새 페이지 추가**(기존 페이지 그대로 두고 뒤에 붙임).
            if not (payload.blocks or payload.extra_blocks):
                return error_response(
                    "추가할 페이지 내용이 없습니다(blocks/extra_blocks 중 하나 필요).",
                    status_code=400,
                )
            page_in = {
                "blocks": payload.blocks or {},
                "extra_blocks": payload.extra_blocks or [],
                "block_sections": payload.block_sections or {},
            }
            appended, w = _build_ai_page(
                template, valid_codes, page_in, report.template_id, report.template_version
            )
            warnings += w
            new_pages = kept + [appended]
        else:
            merged, w = _merge_ai_page(template, valid_codes, existing[idx0], payload)
            warnings += w
            kept[idx0] = merged
            new_pages = kept

    upd_kwargs: dict = {"pages": new_pages}
    if payload.title:
        upd_kwargs["title"] = payload.title
    # 메타데이터(선택) — 준 것만 적용(None 은 유지). entity_ids=[] 는 전체 해제.
    if payload.report_date is not None:
        upd_kwargs["report_date"] = payload.report_date
    if payload.tags is not None:
        upd_kwargs["tags"] = payload.tags
    if payload.report_type_id is not None:
        upd_kwargs["report_type_id"] = payload.report_type_id
    if payload.entity_ids is not None:
        upd_kwargs["entity_ids"] = payload.entity_ids
    try:
        report = services.update_report(
            db,
            report,
            ReportUpdate(**upd_kwargs),
            updated_by_user_id=actor.user.id,
            require_lock=False,
        )
    except ValueError as exc:
        # 정규화로도 못 맞춘 부분 — 블록별 검증 에러를 그대로 전달(AI 재시도용).
        return error_response(str(exc), status_code=400)
    return success_response(
        data={
            "report": _read_with_perms(db, actor, report),
            "warnings": warnings,
            "url": f"/w/{report.workspace_slug}/reports/{report.id}",
        }
    )


@router.get("/{report_id}")
def get_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return success_response(data=_read_with_perms(db, actor, report))


# 이 보고서와 벡터 유사도가 높은 다른 보고서(권한 내) — 임베딩 발판 재사용.
_RELATED_QUERY_CHARS = 2000   # 대표 텍스트 상한(제목+본문 앞부분을 임베딩)
_RELATED_MIN_SCORE = 0.3      # 약한 매치 제외(무관한 추천 방지)


@router.get("/{report_id}/related")
def related_reports(
    report_id: int,
    limit: int = Query(default=5, ge=1, le=20),
    text: str | None = Query(
        default=None, max_length=_RELATED_QUERY_CHARS,
        description="주면 이 텍스트로 유사검색(예: FMEA 행의 고장모드+영향). "
                    "없으면 보고서 대표 텍스트.",
    ),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 보고서와(또는 주어진 text 와) 내용이 비슷한 다른 보고서(가시성 내). 대표
    텍스트를 벡터 검색해 자기 자신을 뺀 상위 limit 개. semantic_search 재사용(권한
    게이팅). FMEA 작성 중 행 텍스트로 과거 유사사례를 추천할 때 text 를 쓴다.
    반환: {items: [{report_id, title, score, snippet, workspace_slug}]}."""
    from app.ai import search as ai_search

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")

    query = (text or "").strip() or (
        f"{report.title or ''} {report.search_text or ''}".strip()
    )
    query = query[:_RELATED_QUERY_CHARS]
    if not query:
        return success_response(data={"items": []})

    # 자기 자신은 동일 텍스트라 최상위로 잡히므로 limit+1 뽑아 제외.
    hits = ai_search.semantic_search(
        db, query, actor, limit=limit + 1, min_score=_RELATED_MIN_SCORE,
    )
    items = [h for h in hits if h.get("report_id") != report_id][:limit]
    return success_response(data={"items": items})


@router.get("/{report_id}/ai-summary")
def get_report_ai_summary(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """보고서의 B300 자동 요약 + 추천 태그/분류(B). 보고서 열람 권한 그대로 —
    못 보는 보고서면 403. 요약이 아직 없으면 data=null(자동요약 OFF·미적재·미권한)."""
    from app.ai.models import ReportAiSummary

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    row = db.get(ReportAiSummary, report_id)
    if row is None:
        return success_response(data=None)
    return success_response(
        data={
            "summary": row.summary,
            "tags": row.tags or [],
            "suggested_category": row.suggested_category,
            "model": row.model,
            "updated_at": row.updated_at,
        }
    )


class ApplyAiSummaryRequest(BaseModel):
    # 편집한 요약(있으면 ReportAiSummary.summary 갱신). None=미변경.
    summary: str | None = None
    # 사용자가 검토·수정한 태그들 — report.tags(free-form)에 합산(중복 제외). None=미적용.
    tags: list[str] | None = None
    # 보고서 종류(분류) 적용 — set_report_type=True 일 때만 반영(None 이면 해제).
    report_type_id: int | None = None
    set_report_type: bool = False


@router.post("/{report_id}/ai-summary/apply")
def apply_ai_summary(
    report_id: int,
    payload: ApplyAiSummaryRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """AI 추천(요약·태그·분류)을 **검토·수정 후 적용**(B 후속). 자동 반영이 아니라
    사람이 확정 — 편집 가능자(can_edit)만. 잠금 불필요(메타데이터 갱신, 폴더이동
    패턴). 태그는 report.tags 에 합산, 분류는 report_type 으로."""
    from app.ai.models import ReportAiSummary
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not can_edit(db, actor.user, report).allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 보고서를 편집할 권한이 없습니다."
        )

    if payload.summary is not None:
        row = db.get(ReportAiSummary, report_id)
        if row is not None:
            row.summary = payload.summary.strip()

    if payload.tags is not None:
        merged = list(report.tags or [])
        for t in payload.tags:
            t = (t or "").strip()
            if t and t not in merged:
                merged.append(t)
        report.tags = merged

    if payload.set_report_type:
        report.report_type_id = payload.report_type_id

    db.commit()
    return success_response(
        data={
            "tags": list(report.tags or []),
            "report_type_id": report.report_type_id,
        },
        message="적용되었습니다.",
    )


class BulkAiSummaryRequest(BaseModel):
    report_ids: list[int]


@router.post("/ai-summary/bulk")
def bulk_ai_summary(
    payload: BulkAiSummaryRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """선택한 보고서들의 AI 요약을 일괄 생성/갱신(force) — 목록 다중선택 + 단건
    '다시 생성'이 공유. 게이트: 요청자가 'auto_summary' 권한자(§E) **그리고** 그
    보고서를 편집할 수 있어야(편집 권한 있는 문서만). 인가가 여기서 끝나므로 잡은
    authorized=True 로 적재(핸들러는 작성자 게이트 건너뜀). 워커가 처리."""
    from app.ai.entitlements import ai_enabled_for
    from app.jobs.queue import enqueue
    from app.shared.permissions import can_edit
    from sqlalchemy.exc import IntegrityError

    if not ai_enabled_for(db, actor.user, "auto_summary"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "AI 요약 권한이 없습니다."
        )

    enqueued, skipped, already = 0, 0, 0
    for rid in set(payload.report_ids):
        report = services.get_report(db, rid)
        if not report or report.deleted_at is not None:
            skipped += 1
            continue
        if not can_edit(db, actor.user, report).allowed:
            skipped += 1  # 편집 권한 없는 문서는 제외
            continue
        try:
            # force 잡은 별도 dedup_key — 대기 중인 자동(force=False) 잡에 막혀
            # 재생성이 누락되지 않도록.
            enqueue(
                db,
                "summarize_report",
                {"report_id": rid, "force": True, "authorized": True},
                dedup_key=f"summarize_report:force:{rid}",
            )
            db.commit()
            enqueued += 1
        except IntegrityError:
            db.rollback()  # 이미 같은 재생성 잡이 대기/처리 중
            already += 1
    return success_response(
        data={"enqueued": enqueued, "skipped": skipped, "already": already},
        message=f"{enqueued}건 요약 생성 요청 (대기중 {already}, 제외 {skipped}).",
    )


class LlmAuthorRequest(BaseModel):
    instructions: str = Field(..., min_length=1, max_length=4000)
    page: int = Field(default=1, ge=1)


@router.post("/{report_id}/llm-author")
async def llm_author_report(
    report_id: int,
    payload: LlmAuthorRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """연결된 local LLM(B300)으로 보고서 내용 생성 — MCP 외부 AI 작성의 사내판.
    사용자 지시 + 템플릿 작성 가이드를 LLM 에 주고, 나온 blocks 를 기존 AI 초안
    적용 파이프라인(update_ai_draft)으로 흘려보낸다(정규화·검증 재사용).

    게이트: report_authoring 엔티틀먼트(§E). 본인 소유·drafting 제약은
    update_ai_draft 가 재확인(=본인 작성 중 보고서만). LLM 실패는 502.

    프론트가 요청을 abort 하면 연결이 끊겨(request.is_disconnected) 생성을 즉시
    중단한다(스트리밍 중 매 청크·재시도 사이 확인) — 업스트림 LLM 연결도 닫혀
    GPU 가 풀린다. 재시도 루프도 끊김 즉시 빠져나온다."""
    import json
    from app.ai.entitlements import ai_enabled_for
    from app.ai.jsonio import extract_json
    from app.ai.llm import LLMCancelled, LLMContextError, LLMError, chat_cancellable
    from app.config import settings

    # 토큰(컨텍스트) 초과로 더 못 만드는 상황을 사용자에게 그대로 알리는 안내문.
    # 일반 사용자는 .env 를 못 바꾸므로 "더 짧게/관리자 요청" 쪽으로 안내한다.
    token_limit_msg = (
        "AI가 만들 내용이 모델의 토큰(컨텍스트) 한도를 초과했습니다. "
        "보고서를 더 짧게 나눠 작성하거나, 관리자에게 모델 토큰 한도 확대를 "
        "요청하세요."
    )

    if not ai_enabled_for(db, actor.user, "report_authoring"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "보고서 작성(AI) 권한이 없습니다."
        )

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    template = template_services.get_template(
        db, report.template_id, report.template_version
    )
    if not template:
        return not_found_response(
            f"Template not found: {report.template_id}@{report.template_version}"
        )

    block_types = {
        b.get("type")
        for b in (template.schema.get("blocks") or [])
        if isinstance(b, dict) and b.get("type")
    }
    template_block_ids = {
        b.get("id")
        for b in (template.schema.get("blocks") or [])
        if isinstance(b, dict) and b.get("id")
    }
    guide = ai_authoring.build_authoring_guide(template.schema)
    # 빈/자유형 템플릿(고정 블록 0개)이어도 위젯을 지을 수 있도록 — 위젯 룰을
    # 템플릿 타입 + 기본 팔레트로 항상 채워 형식 정보를 준다(block_types 가 빈 set
    # 이면 룰도 비어, 작은 모델이 위젯 형식을 몰라 빈 결과를 내던 문제 보강).
    palette_types = block_types | {
        "heading",
        "rich_text",
        "bulleted_list",
        "key_value",
        "table",
        "chart",
    }
    rules = authoring_rules.rules_for_types(palette_types)
    if guide:
        example = ai_authoring.build_example_input(template.schema)
    else:
        # 빈 템플릿 — extra_blocks 로 위젯을 짓는 예시를 보여준다. (기본 예시는
        # blocks={} 라, 작은 모델이 그대로 따라 해 위젯 0개가 되던 원인.)
        example = {
            "title": "<보고서 제목>",
            "extra_blocks": [
                {"id": "sec1", "type": "heading", "content": {"text": "개요"}},
                {
                    "id": "body1",
                    "type": "rich_text",
                    "content": "여기에 본문 내용을 문단으로 작성한다.",
                },
            ],
        }

    system = (
        "당신은 사내 보고서 작성 어시스턴트다. 사용자 지시에 따라 보고서 내용을 "
        "만들어 **JSON 으로만**(코드블록 없이) 답하라.\n"
        '형식: {"title": "제목", "blocks": {"<block_id>": {위젯 content}}, '
        '"extra_blocks": [{"id": "고유키", "type": "위젯타입", "props"?: {...}, '
        '"content": ...}]}\n\n'
        "규칙:\n"
        "- [작성 가이드]에 block_id 가 있으면 그 칸을 채운다(blocks).\n"
        "- 가이드가 비었거나(=빈 템플릿) 새 위젯이 필요하면 **반드시 extra_blocks "
        "로 위젯을 직접 만들어** 내용을 넣는다. 절대 빈 blocks 만 내지 마라.\n"
        "- extra_blocks 항목: id(임의 고유 문자열)·type(아래 위젯 타입)·content(위젯 "
        "룰 형식). 표/차트는 props.columns 로 열을 정의한다.\n"
        "- 위젯 content 형식은 [위젯 룰]을 따른다. 지시한 내용은 반드시 채운다.\n\n"
        'extra_blocks 예: [{"id":"h1","type":"heading","content":{"text":"개요"}}, '
        '{"id":"body","type":"rich_text","content":"본문 문단을 길게 작성."}]\n\n'
        f"[작성 가이드]\n{json.dumps(guide, ensure_ascii=False)}\n\n"
        f"[예시 입력]\n{json.dumps(example, ensure_ascii=False)}\n\n"
        f"[위젯 룰]\n{rules[:6000]}"
    )
    # 자동 재시도 루프 — 형식(JSON)/검증(위젯) 실패면 그 에러를 LLM 에 돌려주고
    # 고쳐서 다시(설정 횟수). 권한·소유·잠금(403/404/409) 같은 비-형식 실패는
    # 재시도 무의미 → 즉시 반환.
    max_attempts = max(1, settings.llm_author_max_attempts)
    last_error = "알 수 없는 오류"
    for attempt in range(1, max_attempts + 1):
        # 재시도 사이에서도 중단을 즉시 반영(끊겼으면 다음 LLM 호출 안 함).
        if await request.is_disconnected():
            return error_response("AI 작성이 취소되었습니다.", status_code=499)
        user_msg = payload.instructions
        if attempt > 1:
            user_msg += (
                f"\n\n[직전 시도가 다음 이유로 실패했습니다 — 고쳐서 JSON 만 다시 "
                f"출력하세요]\n{last_error}\n가이드의 block_id 와 위젯 content 형식을 "
                "정확히 지키고, 코드블록 없이 JSON 객체만 출력하세요."
            )
        try:
            res = await chat_cancellable(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_msg},
                ],
                # 보고서 JSON 은 길다 — 일반 한도(1024)면 잘려서 미완 JSON → 파싱
                # 실패가 매번 반복. 작성 전용 한도로 크게 잡는다.
                max_tokens=settings.llm_author_max_tokens,
                # 유효 JSON 출력 강제(서버가 지원하면 형식 일탈을 원천 차단).
                json_mode=settings.llm_author_json_mode,
                # 프론트 abort → 연결 끊김 → 생성 즉시 중단(GPU 해제).
                should_cancel=request.is_disconnected,
            )
        except LLMCancelled:
            return error_response("AI 작성이 취소되었습니다.", status_code=499)
        except LLMContextError as exc:
            # 요청이 컨텍스트를 넘어 서버가 거부 — 같은 입력 재시도해도 동일하므로
            # 즉시 멈추고 '토큰 초과'를 사용자에게 알린다(상세는 로그로).
            logger.warning(
                "llm-author 토큰(컨텍스트) 초과 (report=%s): %s", report_id, exc
            )
            return error_response(token_limit_msg, status_code=502)
        except LLMError as exc:
            return error_response(f"AI 작성 실패(LLM 호출): {exc}", status_code=502)

        finish_reason = getattr(res, "finish_reason", None)
        truncated = (finish_reason or "").lower() == "length"
        parsed = extract_json(res.content)

        # 출력이 토큰 한도에서 잘리면(finish_reason=length) JSON 이 미완성이라
        # 형식 피드백 재시도는 무의미 — 즉시 멈추고 '토큰 초과'를 사용자에게 알린다.
        # (단, 잘렸어도 파서가 살려냈으면 그대로 진행한다 — 부분이라도 적용.)
        if truncated and parsed is None:
            preview = (res.content or "")[:500].replace("\n", " ")
            logger.warning(
                "llm-author 출력 잘림 (report=%s, attempt=%s): %s",
                report_id, attempt, preview,
            )
            return error_response(token_limit_msg, status_code=502)

        if parsed is None:
            preview = (res.content or "")[:500].replace("\n", " ")
            logger.warning(
                "llm-author JSON 파싱 실패 (report=%s, attempt=%s, finish=%s): %s",
                report_id, attempt, finish_reason, preview,
            )
            last_error = "응답에서 유효한 JSON 객체를 찾지 못함."
            continue

        # 위젯을 하나도 안 만든 degenerate 응답(제목만) — blocks·extra_blocks 가
        # 둘 다 비면 재시도. (작은 모델이 빈 결과를 내던 주 실패 모드.)
        if not (parsed.get("blocks") or parsed.get("extra_blocks")):
            last_error = (
                "위젯을 하나도 만들지 않았습니다(blocks·extra_blocks 둘 다 비었음). "
                "extra_blocks 로 최소 한 개 위젯을 만들어 지시한 내용을 채우세요."
            )
            continue

        # 작은 모델 보정 — extra_blocks 로 만들 위젯을 blocks(dict)에 잘못 넣는 일이
        # 잦다(빈 템플릿에서 특히). 템플릿에 없는 block_id 인데 {type, content} 형태면
        # extra_block 으로 재해석해 살린다(없는 block_id 라 그냥 두면 드롭됨).
        raw_blocks = parsed.get("blocks")
        raw_extra = list(parsed.get("extra_blocks") or [])
        fixed_blocks: dict = {}
        if isinstance(raw_blocks, dict):
            for bid, val in raw_blocks.items():
                if bid in template_block_ids:
                    fixed_blocks[bid] = val
                elif isinstance(val, dict) and val.get("type"):
                    raw_extra.append(
                        {
                            "id": str(bid),
                            "type": val.get("type"),
                            "props": val.get("props") or {},
                            "content": val.get("content", val),
                        }
                    )
                else:
                    fixed_blocks[bid] = val

        try:
            upd = AiDraftUpdate(
                title=(parsed.get("title") or None),
                blocks=fixed_blocks,
                extra_blocks=raw_extra,
                block_sections=parsed.get("block_sections") or {},
                page=payload.page,
            )
            # 정규화·검증·저장은 기존 AI 초안 경로 재사용(본인·drafting 재확인).
            # 본인이 편집 중(=본인 락)이어도 적용 — 사용자가 직접 호출하고 프론트가
            # "저장 안 된 편집분이 사라질 수 있음"을 고지한다(allow_self_lock).
            result = _apply_ai_draft(
                report_id, upd, db, actor, allow_self_lock=True
            )
        except Exception as exc:  # noqa: BLE001 — 스키마/적용 예외도 재시도 대상
            db.rollback()
            last_error = f"적용 오류: {exc}"
            continue

        code = getattr(result, "status_code", 200)
        if code < 400:
            return result  # 성공
        # 비-형식 실패(권한·소유·drafting·잠금)는 재시도해도 동일 → 그대로 반환.
        if code in (403, 404, 409):
            return result
        # 검증/형식(400) — 에러를 다음 시도 피드백으로.
        db.rollback()
        try:
            body = json.loads(bytes(result.body))
            last_error = body.get("message") or "검증 실패"
            errs = body.get("errors") or []
            if errs:
                last_error += " / " + "; ".join(str(e) for e in errs[:5])
        except Exception:  # noqa: BLE001
            last_error = "검증 실패"

    return error_response(
        f"AI 작성이 {max_attempts}회 시도 후에도 형식을 맞추지 못했습니다: {last_error}",
        status_code=502,
    )


class AnswerToReportRequest(BaseModel):
    """검색 '질문하기'·'에이전트' 답변을 보고서 초안으로 저장할 때의 입력."""

    question: str = Field(default="", max_length=2000)
    answer: str = Field(..., min_length=1)
    # 근거 인용/객체 — 프롬프트 컨텍스트 + (옵션) 출처 섹션에 쓴다. 느슨한 dict.
    citations: list[dict] = Field(default_factory=list)
    objects: list[dict] = Field(default_factory=list)
    include_sources: bool = True


# 검색 답변을 담는 전용 빈 호스트 템플릿(blocks:[]). 모든 위젯은 extra_blocks 로.
_AI_ANSWER_TEMPLATE_ID = "__ai_answer__"


def _ensure_ai_answer_template(db: Session):
    """답변→보고서용 빈 템플릿(멱등 get-or-create). 전사 공개·게시·최신."""
    from app.modules.templates.models import Template

    tpl = template_services.get_template(db, _AI_ANSWER_TEMPLATE_ID, 1)
    if tpl:
        return tpl
    tpl = Template(
        template_id=_AI_ANSWER_TEMPLATE_ID,
        version=1,
        name="AI 답변",
        description="검색 답변을 보고서로 저장할 때 쓰는 빈 템플릿(모든 위젯은 추가 블록).",
        category="misc",
        schema={"version": "widget-v1", "blocks": []},
        owner_workspace_slugs=None,
        is_published=True,
        is_latest=True,
        created_by_user_id=None,
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return tpl


@router.post("/from-answer")
async def create_report_from_answer(
    payload: AnswerToReportRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """검색 '질문하기'·'에이전트' 답변을 **구조화 보고서 초안**으로 저장한다.
    답변+근거를 2차 LLM 패스에 넣어 위젯(제목·본문·표·차트)으로 재구성하고, 빈
    템플릿에 extra_blocks 로 붙여 create_ai_draft 경로로 개인 공간 초안을 만든다.
    게이트·취소·재시도·토큰초과 처리는 llm-author 와 동일하다."""
    import json
    from app.ai.entitlements import ai_enabled_for
    from app.ai.jsonio import extract_json
    from app.ai.llm import LLMCancelled, LLMContextError, LLMError, chat_cancellable
    from app.config import settings

    token_limit_msg = (
        "AI가 만들 내용이 모델의 토큰(컨텍스트) 한도를 초과했습니다. 답변이 너무 길면 "
        "핵심만 남기거나, 관리자에게 모델 토큰 한도 확대를 요청하세요."
    )
    if not ai_enabled_for(db, actor.user, "report_authoring"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "보고서 작성(AI) 권한이 없습니다.")
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 워크스페이스에선 보고서를 만들 수 없습니다."
        )

    _ensure_ai_answer_template(db)
    palette_types = {
        "heading", "rich_text", "bulleted_list", "key_value", "table", "chart", "pie",
    }
    rules = authoring_rules.rules_for_types(palette_types)

    # 근거 출처(프롬프트 컨텍스트 + 옵션 출처 섹션) — 번호·제목·스니펫.
    src_lines: list[str] = []
    for c in payload.citations[:12]:
        if not isinstance(c, dict):
            continue
        n = c.get("n") or len(src_lines) + 1
        title = c.get("title") or c.get("report_id") or ""
        snippet = (c.get("snippet") or "").strip().replace("\n", " ")
        src_lines.append(f"[{n}] {title} — {snippet[:200]}")
    sources_text = "\n".join(src_lines)

    system = (
        "당신은 사내 보고서 작성 어시스턴트다. 주어진 '질문'과 'AI 답변'(+근거)을 읽고 "
        "그 내용을 **보고서 위젯으로 재구성**해 **JSON 으로만**(코드블록 없이) 답하라.\n"
        '형식: {"title": "제목", "extra_blocks": [{"id": "고유키", "type": "위젯타입", '
        '"props"?: {...}, "content": ...}]}\n\n'
        "규칙:\n"
        "- 반드시 extra_blocks 로 위젯을 직접 만들어 내용을 채운다(빈 결과 금지).\n"
        "- 제목·소제목은 heading, 서술은 rich_text, 나열은 bulleted_list, 키-값은 "
        "key_value, 표는 table 로.\n"
        "- 답변에 **수치·비교·추세 데이터가 있으면 chart(막대/선) 또는 pie 로 시각화**"
        "하라. 단, **답변/근거에 없는 수치를 지어내지 말 것** — 데이터가 없으면 차트 "
        "대신 서술/표로만.\n"
        "- 표/차트는 props.columns 로 열을 정의한다. 위젯 content 형식은 [위젯 룰]을 "
        "정확히 따른다.\n"
        + (
            "- 마지막에 heading '출처' + 근거 목록을 bulleted_list 로 넣어라.\n"
            if payload.include_sources and sources_text
            else ""
        )
        + f"\n[위젯 룰]\n{rules[:6000]}"
    )
    user_base = (
        f"[질문]\n{payload.question or '(질문 없음)'}\n\n[AI 답변]\n{payload.answer}\n"
        + (f"\n[근거 출처]\n{sources_text}\n" if sources_text else "")
    )

    max_attempts = max(1, settings.llm_author_max_attempts)
    last_error = "알 수 없는 오류"
    for attempt in range(1, max_attempts + 1):
        if await request.is_disconnected():
            return error_response("보고서 저장이 취소되었습니다.", status_code=499)
        msg = user_base
        if attempt > 1:
            msg += (
                f"\n\n[직전 시도가 다음 이유로 실패 — 고쳐서 JSON 만 다시 출력]\n"
                f"{last_error}\n위젯 content 형식을 정확히 지키고, 코드블록 없이 JSON "
                "객체만 출력하세요."
            )
        try:
            res = await chat_cancellable(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": msg},
                ],
                max_tokens=settings.llm_author_max_tokens,
                json_mode=settings.llm_author_json_mode,
                should_cancel=request.is_disconnected,
            )
        except LLMCancelled:
            return error_response("보고서 저장이 취소되었습니다.", status_code=499)
        except LLMContextError as exc:
            logger.warning("from-answer 토큰(컨텍스트) 초과: %s", exc)
            return error_response(token_limit_msg, status_code=502)
        except LLMError as exc:
            return error_response(f"보고서 생성 실패(LLM 호출): {exc}", status_code=502)

        finish_reason = getattr(res, "finish_reason", None)
        truncated = (finish_reason or "").lower() == "length"
        parsed = extract_json(res.content)
        if truncated and parsed is None:
            return error_response(token_limit_msg, status_code=502)
        if parsed is None:
            last_error = "응답에서 유효한 JSON 객체를 찾지 못함."
            continue

        # 빈 템플릿이라 모든 위젯은 extra_block — blocks(dict)에 잘못 넣은 위젯도 살린다.
        raw_extra = list(parsed.get("extra_blocks") or [])
        raw_blocks = parsed.get("blocks")
        if isinstance(raw_blocks, dict):
            for bid, val in raw_blocks.items():
                if isinstance(val, dict) and val.get("type"):
                    raw_extra.append(
                        {
                            "id": str(bid),
                            "type": val.get("type"),
                            "props": val.get("props") or {},
                            "content": val.get("content", val),
                        }
                    )
        if not raw_extra:
            last_error = (
                "위젯을 하나도 만들지 않았습니다. extra_blocks 로 최소 한 개 위젯을 "
                "만들어 답변 내용을 채우세요."
            )
            continue

        title = (parsed.get("title") or payload.question or "AI 답변 보고서").strip()
        draft = AiDraftCreate(
            template_id=_AI_ANSWER_TEMPLATE_ID,
            template_version=1,
            title=(title or "AI 답변 보고서")[:255],
            extra_blocks=raw_extra,
        )
        try:
            result = create_ai_draft(draft, db, actor)
        except Exception as exc:  # noqa: BLE001 — 스키마/적용 예외도 재시도 대상
            db.rollback()
            last_error = f"적용 오류: {exc}"
            continue
        code = getattr(result, "status_code", 200)
        if code < 400:
            return result  # 성공 — {report, warnings, url}
        if code in (403, 404, 409):
            return result
        db.rollback()
        try:
            body = json.loads(bytes(result.body))
            last_error = body.get("message") or "검증 실패"
        except Exception:  # noqa: BLE001
            last_error = "검증 실패"

    return error_response(
        f"{max_attempts}회 시도 후에도 보고서 형식을 맞추지 못했습니다: {last_error}",
        status_code=502,
    )


class LlmSectionsRequest(BaseModel):
    # True=모든 위젯 재지정(기존 수동 지정도 교체), False=단락구분 없는 위젯만.
    overwrite: bool = False
    # 선택 힌트(비워도 됨).
    instructions: str = Field(default="", max_length=2000)


@router.post("/{report_id}/llm-sections")
async def llm_assign_sections(
    report_id: int,
    payload: LlmSectionsRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """연결된 local LLM 으로 현재 문서의 위젯 '단락 구분'(section)을 자동 지정한다.
    각 위젯 텍스트 + 분류 코드 목록을 LLM 에 주고 {번호: code} 를 받아 block_sections
    에 반영. 게이트(report_authoring)·취소(연결끊김)·재시도는 llm-author 와 동일.
    본인 소유·drafting 보고서만(남의 락 차단)."""
    from app.ai.entitlements import ai_enabled_for
    from app.ai.jsonio import extract_json
    from app.ai.llm import LLMCancelled, LLMContextError, LLMError, chat_cancellable
    from app.config import settings
    from app.modules.reports.models import ReportPhase
    from app.shared.permissions import can_edit
    from app.widgets.text_extraction import extract_chunks_for_report

    if not ai_enabled_for(db, actor.user, "report_authoring"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "보고서 작성(AI) 권한이 없습니다."
        )

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    # 단락 구분은 내용이 아니라 메타데이터라, "작성"(내용 생성)과 달리 drafting 에
    # 묶지 않고 **수동 편집과 동일한 권한(can_edit)** 으로 게이트한다 → 검토(reviewing)
    # 단계 보고서도 지정 가능. 발행 완료(finalized)만 편집 차단.
    if report.phase == ReportPhase.finalized:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "발행 완료된 보고서는 편집할 수 없습니다. 발행 취소 후 지정하세요.",
        )
    if not can_edit(db, actor.user, report).allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 보고서를 편집할 권한이 없습니다."
        )
    held = services.get_active_lock(db, report)
    if held is not None and held.user_id != actor.user.id:
        return _lock_conflict_response(
            services.LockHeldByOtherError(
                "다른 사용자가 이 보고서를 편집 중이라 적용할 수 없습니다. "
                "상대가 편집을 마친 뒤 다시 시도하세요.",
                holder=held,
            )
        )

    # 위젯 목록: (page_idx, block_id) 별 대표 텍스트 + 타입. 제목/페이지 마커 제외.
    pages = list(report.pages or [])
    _MARKERS = {"__title__", "__page__"}
    by_block: dict[tuple, dict] = {}
    order: list[tuple] = []
    for ch in extract_chunks_for_report(report):
        if ch.block_id is None or ch.page_idx is None or ch.widget_type in _MARKERS:
            continue
        key = (ch.page_idx, ch.block_id)
        if key not in by_block:
            by_block[key] = {"type": ch.widget_type or "", "text": ""}
            order.append(key)
        cur = by_block[key]
        if len(cur["text"]) < 400 and ch.text:
            cur["text"] = (cur["text"] + " " + ch.text).strip()[:400]

    def _already_set(page_idx: int, block_id: str) -> bool:
        if page_idx >= len(pages):
            return False
        bs = (pages[page_idx] or {}).get("block_sections") or {}
        return isinstance(bs.get(block_id), str) and bool(bs.get(block_id))

    ref_map: dict[str, tuple] = {}
    lines: list[str] = []
    for key in order:
        page_idx, block_id = key
        if not payload.overwrite and _already_set(page_idx, block_id):
            continue
        ref = str(len(ref_map) + 1)
        ref_map[ref] = key
        info = by_block[key]
        lines.append(
            f'[{ref}] ({page_idx + 1}장, {info["type"]}) {info["text"] or "(내용 없음)"}'
        )

    if not ref_map:
        return success_response(
            data={"assigned": 0, "total": 0, "warnings": ["지정할 위젯이 없습니다."]}
        )

    taxonomy = section_taxonomy_services.taxonomy_for_ai(db)
    valid = section_taxonomy_services.valid_codes(db)
    tax_lines: list[str] = []
    for cat in taxonomy:
        tax_lines.append(f'# {cat.get("category_name", "")}')
        for it in cat.get("items", []):
            en = f' ({it["en"]})' if it.get("en") else ""
            tax_lines.append(f'- {it["code"]} : {it.get("label", "")}{en}')
    tax_text = "\n".join(tax_lines)

    system = (
        "당신은 보고서 위젯에 '단락 구분'(섹션) 코드를 부여하는 분류기다. 각 위젯의 "
        "내용을 보고 [분류 목록]에서 가장 알맞은 code 하나를 고른다. **JSON 으로만** "
        "(코드블록 없이) 답하라.\n"
        '형식: {"<번호>": "<code>"}  예: {"1": "rationale", "2": "risk"}\n\n'
        "규칙:\n"
        "- 키는 위젯 번호([n] 의 n), 값은 [분류 목록]의 **code 문자열**(한글 라벨 금지).\n"
        "- 목록에 없는 code 는 쓰지 마라. 애매하면 그 번호는 생략한다.\n"
        "- 최대한 많은 위젯에 대해 판단한다.\n\n"
        f"[분류 목록]\n{tax_text}"
    )
    widget_text = "\n".join(lines)
    token_limit_msg = (
        "AI 처리 내용이 모델의 토큰(컨텍스트) 한도를 초과했습니다. 문서를 더 짧게 "
        "나누거나 관리자에게 모델 토큰 한도 확대를 요청하세요."
    )

    max_attempts = max(1, settings.llm_author_max_attempts)
    last_error = "알 수 없는 오류"
    for attempt in range(1, max_attempts + 1):
        if await request.is_disconnected():
            return error_response("단락구분 지정이 취소되었습니다.", status_code=499)
        user_msg = f"[위젯 목록]\n{widget_text}"
        if payload.instructions.strip():
            user_msg = f"[참고 지시]\n{payload.instructions.strip()}\n\n" + user_msg
        if attempt > 1:
            user_msg += (
                f"\n\n[직전 시도가 실패했습니다 — 고쳐서 JSON 만 다시 출력하세요]\n"
                f"{last_error}\n번호→code 매핑만, 코드블록 없이 JSON 객체로."
            )
        try:
            res = await chat_cancellable(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_msg},
                ],
                max_tokens=settings.llm_author_max_tokens,
                json_mode=settings.llm_author_json_mode,
                should_cancel=request.is_disconnected,
            )
        except LLMCancelled:
            return error_response("단락구분 지정이 취소되었습니다.", status_code=499)
        except LLMContextError as exc:
            logger.warning("llm-sections 토큰 초과 (report=%s): %s", report_id, exc)
            return error_response(token_limit_msg, status_code=502)
        except LLMError as exc:
            return error_response(
                f"단락구분 지정 실패(LLM 호출): {exc}", status_code=502
            )

        parsed = extract_json(res.content)
        if not isinstance(parsed, dict):
            last_error = "응답에서 유효한 JSON 객체를 찾지 못함."
            continue
        sections_by_page: dict[int, dict[str, str]] = {}
        assigned = 0
        for ref, code in parsed.items():
            key = ref_map.get(str(ref))
            if not key or not isinstance(code, str) or code not in valid:
                continue
            page_idx, block_id = key
            sections_by_page.setdefault(page_idx, {})[block_id] = code
            assigned += 1
        if assigned == 0:
            last_error = (
                "유효한 (번호→코드) 매핑이 없습니다. 목록의 code 문자열을 정확히 쓰세요."
            )
            continue
        try:
            services.apply_block_sections(db, report, sections_by_page)
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            return error_response(f"적용 오류: {exc}", status_code=500)
        return success_response(
            data={"assigned": assigned, "total": len(ref_map), "warnings": []}
        )

    return error_response(
        f"단락구분 지정이 {max_attempts}회 시도 후에도 형식을 맞추지 못했습니다: {last_error}",
        status_code=502,
    )


@router.post("")
def create_report(
    payload: ReportCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Cannot create report in a virtual workspace; switch to a real workspace.",
        )
    # Phase 1: every new report is born in the creator's personal
    # workspace, regardless of which workspace they're currently
    # browsing. Promotion to org boards is a deliberate "게시" action
    # afterwards. This is the structural enforcement of the "개인
    # 작업공간과 조직 게시판 분리" decision (협업개선_설계.md §2).
    target_workspace = f"personal-{actor.user.id}"
    try:
        report = services.create_report(
            db, target_workspace, payload, owner_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=_read_with_perms(db, actor, report))


@router.post("/{report_id}/copy")
def copy_report(
    report_id: int,
    payload: ReportCopy,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Duplicate a report the caller can read into their personal space.

    The copy is born in `personal-{user}` like any new report (게시는 이후
    별도 액션). `mode` controls how much metadata/relations travel — see
    ReportCopy / services.copy_report.
    """
    source = services.get_report(db, report_id)
    if not source:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, source):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    target_workspace = f"personal-{actor.user.id}"
    try:
        new_report = services.copy_report(
            db,
            report_id,
            target_workspace=target_workspace,
            title=payload.title,
            folder_id=payload.folder_id,
            mode=payload.mode,
            owner_user_id=actor.user.id,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=_read_with_perms(db, actor, new_report))


@router.put("/{report_id}/author-lock")
def set_author_lock(
    report_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Toggle the author lock. Body: {enabled: bool, reason?: str}.

    Permission: report owner OR system admin (force unset). System
    admins can override the lock to unblock a stuck workflow when the
    author is unavailable — that path emits a separate
    `report.lock_force_unset` notification to the owner so they know.
    """
    from datetime import datetime as _dt
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification
    from app.modules.mounts.models import ReportMount
    from app.modules.users.models import WorkspaceMember, Role
    from sqlalchemy import select

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")

    enabled = bool(payload.get("enabled"))
    reason = (payload.get("reason") or "").strip()
    is_owner = report.owner_user_id == actor.user.id
    is_system_admin = actor.user.is_system_admin
    is_force_unset = (not enabled) and not is_owner and is_system_admin

    if not is_owner and not is_force_unset:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "작성자만 잠금/해제 가능합니다 (또는 시스템 관리자의 강제 해제).",
        )

    report.author_lock_enabled = enabled
    if enabled:
        report.author_lock_reason = reason
        report.author_lock_set_at = _dt.utcnow()
    else:
        report.author_lock_reason = ""
        report.author_lock_set_at = None

    record_activity(
        db,
        report_id=report.id,
        type=(
            ReportActivityType.lock_force_unset if is_force_unset
            else ReportActivityType.locked if enabled
            else ReportActivityType.unlocked
        ),
        actor_user_id=actor.user.id,
        payload={"reason": reason} if enabled else {},
    )

    # Notify on lock — every board lead the report is mounted to should
    # know so they don't try editing and hit a wall.
    if enabled:
        mount_slugs = list(
            db.execute(
                select(ReportMount.workspace_slug).where(
                    ReportMount.report_id == report.id
                )
            ).scalars()
        )
        notified: set[int] = set()
        for slug in mount_slugs:
            leads = db.execute(
                select(WorkspaceMember.user_id).where(
                    WorkspaceMember.workspace_slug == slug,
                    WorkspaceMember.role == Role.manager,
                )
            ).scalars()
            for uid in leads:
                if uid in notified or uid == actor.user.id:
                    continue
                notified.add(uid)
                create_notification(
                    db,
                    recipient_user_id=uid,
                    actor_user_id=actor.user.id,
                    type=NotificationType.report_locked,
                    ref_table="reports",
                    ref_id=report.id,
                    workspace_slug=slug,
                    payload={
                        "report_title": report.title,
                        "reason": reason,
                    },
                )
    # Force-unset path notifies the owner about the override.
    if is_force_unset and report.owner_user_id is not None:
        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor.user.id,
            type=NotificationType.report_lock_force_unset,
            ref_table="reports",
            ref_id=report.id,
            payload={"report_title": report.title},
        )

    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("/{report_id}/publish")
def publish_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Owner-only: bump phase → finalized. Editing is gated downstream
    based on phase (finalized = read-only at the frontend layer; the
    backend update path will reject in Phase 2C alongside author lock).

    Recording: activity row + notification to mounted-board members are
    fired here. Idempotent — already-finalized just returns the current
    state.
    """
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification
    from app.modules.reports.models import ReportPhase
    from app.modules.mounts.models import ReportMount
    from app.modules.users.models import WorkspaceMember
    from sqlalchemy import select

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "발행은 작성자만 가능합니다."
        )
    if report.phase == ReportPhase.finalized:
        return success_response(data=_read_with_perms(db, actor, report))

    previous = report.phase
    report.phase = ReportPhase.finalized
    record_activity(
        db,
        report_id=report.id,
        type=ReportActivityType.phase_to_finalized,
        actor_user_id=actor.user.id,
        payload={"previous_phase": previous.value},
    )
    # Notify all members of every workspace this report is mounted to.
    mount_slugs = [
        m for m in db.execute(
            select(ReportMount.workspace_slug).where(
                ReportMount.report_id == report.id
            )
        ).scalars()
    ]
    notified: set[int] = set()
    for slug in mount_slugs:
        members = db.execute(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_slug == slug
            )
        ).scalars()
        for uid in members:
            if uid in notified or uid == actor.user.id:
                continue
            notified.add(uid)
            create_notification(
                db,
                recipient_user_id=uid,
                actor_user_id=actor.user.id,
                type=NotificationType.report_phase_to_finalized,
                ref_table="reports",
                ref_id=report.id,
                workspace_slug=slug,
                payload={"report_title": report.title},
            )
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("/{report_id}/unpublish")
def unpublish_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Owner-only: finalized 해제. 되돌아갈 단계는 현재 협업 상태로 판정한다
    (services.resolve_reactivation_phase):
      - 아직 게시판에 게시돼 있거나 외부 댓글이 있으면 → reviewing(리뷰중)
      - 순수 개인 보고서면 → drafting(작성중)
    drafting → reviewing 승격 규칙(게시/외부 댓글)과 대칭. 어느 쪽이든 다시
    발행하려면 명시적으로 '발행'을 눌러야 한다.
    """
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.reports.models import ReportPhase

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "발행 취소는 작성자만 가능합니다."
        )
    if report.phase != ReportPhase.finalized:
        return success_response(data=_read_with_perms(db, actor, report))

    target = services.resolve_reactivation_phase(db, report)
    report.phase = target
    record_activity(
        db,
        report_id=report.id,
        type=(
            ReportActivityType.phase_to_reviewing
            if target == ReportPhase.reviewing
            else ReportActivityType.phase_to_drafting
        ),
        actor_user_id=actor.user.id,
        payload={"trigger": "unpublish", "target_phase": target.value},
    )
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.put("/{report_id}/folder")
def move_report_to_folder(
    report_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Metadata-only assignment of a report to a personal folder.

    Separate from the main PATCH /reports/{id} because (a) it doesn't
    touch content/structure (no lock needed), (b) only the report owner
    can move their own report (folders are per-user), and (c) the UI
    needs a one-shot endpoint that doesn't require the optimistic
    revision dance — folder placement is independent of content
    revisions.

    Body: { "folder_id": int | null }  (null = uncategorized)
    """
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "본인 보고서만 폴더 이동할 수 있습니다.",
        )
    folder_id = payload.get("folder_id")
    if folder_id is not None and not isinstance(folder_id, int):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "folder_id must be int or null"
        )
    # If a folder id is given, sanity-check it belongs to the report's
    # owner (not just the actor — for sys admin moving another user's
    # report). Without this, forging a folder id could park a report
    # under someone else's folder.
    if folder_id is not None:
        from app.modules.folders.models import Folder

        folder = db.get(Folder, folder_id)
        expected_owner = report.owner_user_id
        if folder is None or folder.user_id != expected_owner:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"폴더를 찾을 수 없거나 권한이 없습니다: {folder_id}",
            )
    report.folder_id = folder_id
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.patch("/{report_id}")
def update_report(
    report_id: int,
    payload: ReportUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    # Phase 3 — single can_edit() check. Subsumes the Phase 2 hard-lock
    # veto (decision_role='locked') and adds boss/coauthor/editor paths.
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        if decision.role == "locked":
            reason = report.author_lock_reason or "사유 미기재"
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"작성자가 수정 잠금 상태입니다 (사유: {reason}). 잠금 해제 후 다시 시도하세요.",
            )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없습니다.",
        )
    # Phase 2B — finalized reports are read-only. Author must unpublish
    # (POST /reports/{id}/unpublish) to make changes.
    from app.modules.reports.models import ReportPhase

    if report.phase == ReportPhase.finalized:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "발행된 보고서는 편집할 수 없습니다. '발행 취소' 후 수정하세요.",
        )
    try:
        report = services.update_report(
            db,
            report,
            payload,
            updated_by_user_id=actor.user.id,
            expected_revision=payload.expected_revision,
        )
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    # Phase 3 — notify owner when a non-owner edits. Decision #4: no
    # debounce. Activity log already has the full sequence; the inbox
    # just gets one row per save (user can mass-clear).
    if (
        report.owner_user_id is not None
        and report.owner_user_id != actor.user.id
    ):
        from app.modules.notifications.models import NotificationType
        from app.modules.notifications.services import create_notification

        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor.user.id,
            type=NotificationType.report_edited_by_other,
            ref_table="reports",
            ref_id=report.id,
            payload={
                "report_title": report.title,
                "editor_role": decision.role,
            },
        )
        db.commit()

    return success_response(data=_read_with_perms(db, actor, report))


@router.patch("/{report_id}/rename")
def rename_report(
    report_id: int,
    payload: ReportRename,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """제목만 바꾸는 가벼운 갱신 — 목록에서의 즉시 변경(inline rename)용. 편집
    잠금을 잡지 않는다(폴더 이동·AI 요약 적용과 같은 메타데이터 패턴). 게이트는
    전체 편집 PATCH 와 동일: can_edit + 발행 전(finalized 제외). 제목 변경은 ORM
    before_update 훅이 search_text·임베딩을 자동 재색인한다."""
    from app.shared.permissions import can_edit
    from app.modules.reports.models import ReportPhase

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        if decision.role == "locked":
            reason = report.author_lock_reason or "사유 미기재"
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"작성자가 수정 잠금 상태입니다 (사유: {reason}). 잠금 해제 후 다시 시도하세요.",
            )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없습니다.",
        )
    if report.phase == ReportPhase.finalized:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "발행된 보고서는 편집할 수 없습니다. '발행 취소' 후 수정하세요.",
        )

    new_title = payload.title.strip()
    if not new_title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "제목을 입력하세요.")
    report.title = new_title
    report.updated_by_user_id = actor.user.id
    report.revision = (report.revision or 1) + 1
    db.commit()
    db.refresh(report)

    # 소유자가 아닌 사람이 이름을 바꾸면 소유자에게 알림(전체 편집 PATCH 와 동일).
    if (
        report.owner_user_id is not None
        and report.owner_user_id != actor.user.id
    ):
        from app.modules.notifications.models import NotificationType
        from app.modules.notifications.services import create_notification

        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor.user.id,
            type=NotificationType.report_edited_by_other,
            ref_table="reports",
            ref_id=report.id,
            payload={
                "report_title": report.title,
                "editor_role": decision.role,
            },
        )
        db.commit()

    return success_response(data={"id": report.id, "title": report.title})


@router.post("/{report_id}/suggest-entities")
def suggest_report_entities(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """본문에서 엔티티(축) 태그 후보를 추천 — **자동 태깅이 아니라 제안 칩**.

    결정적 매칭(본문에 값/코드/별칭이 그대로 등장, 환각 0) + report_chunks 임베딩
    유사도(mock 백엔드면 생략). 반환은 후보 목록일 뿐 아무것도 저장하지 않는다 —
    사용자가 수락해 entity_ids 로 PATCH 해야 태깅된다(엔티티관리개선_설계.md §4.4).

    편집 권한(can_edit)을 요구한다 — 태깅 보조 도구이므로 편집 가능한 사용자만.
    """
    from app.modules.entities import autotag
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    if not can_edit(db, actor.user, report).allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 보고서를 편집할 권한이 없습니다."
        )

    result = autotag.suggest_entities(db, report)
    return success_response(data=result)


@router.post("/{report_id}/entities/add")
def add_report_entities(
    report_id: int,
    payload: ReportEntitiesAdd,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """기존 태그에 entity_ids 를 **가산**(union)으로 더한다 — 제거 안 함.

    일괄 AI 태그 적용(목록에서 여러 보고서 선택→추천 검토→수락)의 쓰기 경로.
    보고서를 편집 세션으로 여는 게 아니므로 편집 락을 요구하지 않고(다른 일괄
    동작과 동일), 합집합만 적용해 동시 편집자의 기존 태그를 덮어쓰지 않는다.
    편집 권한(can_edit)은 요구한다. 반환은 적용 후 전체 엔티티 리스트.
    """
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    if not can_edit(db, actor.user, report).allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 보고서를 편집할 권한이 없습니다."
        )
    before = {e.id for e in (report.entities or [])}
    try:
        entities = services.add_entities_to_report(db, report, payload.entity_ids)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    after = [e.id for e in entities]
    return success_response(
        data={
            "report_id": report.id,
            "entity_ids": after,  # 적용 후 전체 태그 id
            "added": len([i for i in after if i not in before]),  # 새로 추가된 수
        }
    )


# --------------------------------------------------------------------------- #
# Version history (수정 이력 · 되돌리기)                                        #
# --------------------------------------------------------------------------- #
def _version_meta_list(db: Session, rows) -> list[ReportVersionMeta]:
    ids = {r.author_user_id for r in rows if r.author_user_id is not None}
    names = {}
    if ids:
        names = {
            u.id: u.name
            for u in db.execute(select(User).where(User.id.in_(ids))).scalars()
        }
    out = []
    for r in rows:
        m = ReportVersionMeta.model_validate(r)
        m.author_name = names.get(r.author_user_id)
        out.append(m)
    return out


@router.get("/{report_id}/versions")
def list_report_versions(
    report_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    before_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """보고서 수정 이력(최신순, cursor=before_id). 본문 제외 메타만. 보기 권한 필요."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    rows = services.list_report_versions(
        db, report_id, limit=limit, before_id=before_id
    )
    return success_response(data=_version_meta_list(db, rows))


@router.get("/{report_id}/versions/{version_id}")
def get_report_version(
    report_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """특정 버전의 본문(미리보기용)을 복원해 반환. 보기 권한 필요."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    version = services.get_report_version(db, report_id, version_id)
    if not version:
        return not_found_response(f"Version not found: {version_id}")
    meta = _version_meta_list(db, [version])[0]
    return success_response(
        data={"version": meta, "body": versioning.decode_body(version)}
    )


@router.post("/{report_id}/versions/{version_id}/restore")
def restore_report_version(
    report_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """이 버전으로 비파괴 되돌리기 — 편집 권한 필요. 다른 사용자가 편집 중이면 막음."""
    from app.shared.permissions import can_edit
    from app.modules.reports.models import ReportPhase

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 보고서를 편집할 권한이 없습니다."
        )
    if report.phase == ReportPhase.finalized:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "발행된 보고서는 되돌릴 수 없습니다. '발행 취소' 후 시도하세요.",
        )
    version = services.get_report_version(db, report_id, version_id)
    if not version:
        return not_found_response(f"Version not found: {version_id}")

    # 다른 사용자가 편집 잠금을 쥐고 있으면 충돌 — 덮어쓰기 방지. 본인/무잠금이면
    # 잠시 점유했다가 되돌리기 후 해제.
    try:
        services.acquire_lock(db, report, actor.user.id)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    try:
        report = services.restore_version(
            db, report, version, actor_user_id=actor.user.id
        )
    finally:
        services.release_lock(db, report, actor.user.id)
    return success_response(
        data=_read_with_perms(db, actor, report), message="이 버전으로 되돌렸습니다."
    )


# --------------------------------------------------------------------------- #
# Edit lock endpoints                                                         #
# --------------------------------------------------------------------------- #


def _resolve_writable_report(
    db: Session, report_id: int, actor: CurrentUser
):
    """Shared guard for the three lock endpoints. Returns the report or
    raises the standard 404/403. Kept inline (not a Depends) because all
    three handlers need to surface the report object itself."""
    report = services.get_report(db, report_id)
    if not report:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"Report not found: {report_id}"
        )
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return report


@router.post("/{report_id}/lock")
def acquire_lock(
    report_id: int,
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Claim or refresh the edit lock. Pass `?force=true` to override an
    existing live lock (the previous holder will fail their next heartbeat
    / save and be bounced back to view mode)."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.acquire_lock(db, report, actor.user.id, force=force)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    db.refresh(report)
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.post("/{report_id}/lock/heartbeat")
def heartbeat_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Extend the caller's lock TTL. Returns 409 if the caller doesn't hold
    a live lock — the frontend treats that as "you got bumped" and exits
    edit mode."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.heartbeat_lock(db, report, actor.user.id)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.delete("/{report_id}/lock")
def release_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Drop the lock. Idempotent — releases for non-holders or already-
    expired locks return 200 with a no-op so the frontend can fire-and-
    forget from beforeunload handlers."""
    report = _resolve_writable_report(db, report_id, actor)
    services.release_lock(db, report, actor.user.id)
    db.commit()
    return success_response(data=None, message="Released")


@router.delete("/{report_id}")
def delete_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """영구삭제(purge) — 원본을 지워 게시된 모든 부서 게시판·종합보고 안건에서
    cascade 로 사라지는 비가역 작업. 평소 "삭제"는 이게 아니라 소프트삭제
    (/trash)를 쓴다. 권한: 소유자/시스템관리자만. **게시 중이면 차단** — 부서
    기록을 작성자가 일방적으로 날리지 못하게, 게시취소(해제/내리기 요청 승인)
    가 끝나 mount 가 0이 된 뒤에만 영구삭제할 수 있다."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_purge_report(db, actor, report):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 영구 삭제할 권한이 없습니다 (소유자만 가능).",
        )
    mount_count = services.report_mount_count(db, report.id)
    if mount_count > 0:
        return error_response(
            f"아직 {mount_count}개 부서 게시판에 게시 중입니다. 먼저 게시취소"
            "(해제 또는 '게시판에서 내리기 요청' 승인) 후 영구 삭제하세요.",
            errors=[{"code": "report_still_mounted"}],
            status_code=409,
        )
    services.delete_report(db, report)
    return success_response(data=None, message="Deleted")


@router.post("/{report_id}/trash")
def trash_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """소프트삭제 — 휴지통으로 보낸다(deleted_at set). 개인 목록/검색에서
    숨지만 게시된 부서 게시판에는 그대로 남는다(게시분 보존). 복구 가능.
    권한: 소유자/시스템관리자(개인 공간 회수)."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_trash_report(db, actor, report):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 삭제할 권한이 없습니다 (소유자만 가능).",
        )
    services.soft_delete_report(db, report, actor)
    return success_response(data=None, message="Trashed")


@router.post("/{report_id}/restore")
def restore_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """휴지통에서 복구 — deleted_at 해제. 권한: 소유자/시스템관리자."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_trash_report(db, actor, report):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 복구할 권한이 없습니다 (소유자만 가능).",
        )
    services.restore_report(db, report)
    return success_response(data=None, message="Restored")


@router.post("/{report_id}/takedown-requests")
def request_report_takedown(
    report_id: int,
    workspace_slug: str | None = None,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """"게시판에서 내리기 요청" — 게시된 부서 게시판마다 게시취소 요청을
    팬아웃한다. `workspace_slug` 를 주면 그 게시판 하나에만 요청한다(게시판별
    개별 내리기). 요청자가 관리하는 게시판은 즉시 게시취소되고, 나머지는 그
    board 매니저의 승인을 기다리는 pending 요청이 된다. 권한: 작성자 본인."""
    from app.modules.mounts import services as mount_services

    try:
        result = mount_services.request_takedown(
            db,
            report_id=report_id,
            actor_user_id=actor.user.id,
            workspace_slug=workspace_slug,
        )
    except mount_services.MountForbiddenError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc))
    except mount_services.MountTargetInvalidError as exc:
        return not_found_response(str(exc))
    return success_response(data=result, message="Takedown requested")


@router.delete("/{report_id}/takedown-requests")
def cancel_report_takedown(
    report_id: int,
    workspace_slug: str | None = None,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """게시취소 요청 철회 — 작성자가 자신이 보낸 pending 요청을 취소한다.
    `workspace_slug` 를 주면 그 게시판 하나만, 없으면 이 보고서의 pending 요청
    전부. 이미 매니저가 처리한 요청은 손대지 않는다. 권한: 작성자 본인."""
    from app.modules.mounts import services as mount_services

    try:
        result = mount_services.cancel_takedown_request(
            db,
            report_id=report_id,
            actor_user_id=actor.user.id,
            workspace_slug=workspace_slug,
        )
    except mount_services.MountForbiddenError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc))
    except mount_services.MountTargetInvalidError as exc:
        return not_found_response(str(exc))
    return success_response(data=result, message="Takedown request canceled")


# ─── Report links ────────────────────────────────────────────────────────── #


def _link_to_read(report_id: int, link) -> ReportLinkRead:
    """ORM ReportLink → ReportLinkRead. direction 은 link 가 이 보고서의
    outgoing 인지 incoming 인지로 결정. counterpart 도 그쪽으로 set."""
    if link.from_report_id == report_id:
        direction = "outgoing"
        cp = link.to_report
    else:
        direction = "incoming"
        cp = link.from_report
    return ReportLinkRead(
        id=link.id,
        kind=link.kind,
        note=link.note,
        direction=direction,
        counterpart=ReportLinkRefMini(
            id=cp.id,
            workspace_slug=cp.workspace_slug,
            title=cp.title,
            owner_name=getattr(cp.owner, "name", None) if cp.owner else None,
            report_date=cp.report_date,
        ),
        created_at=link.created_at,
        created_by_name=(
            getattr(link.created_by, "name", None) if link.created_by else None
        ),
    )


@router.get("/{report_id}/links")
def get_report_links(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 보고서의 양방향 link 목록. 권한은 보고서 read 와 동일."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    links = services.list_links_for_report(db, report_id)
    # 가시성 가드 제거 — picker 가 시스템 전체 linkable 풀에서 후보를
    # 보여주므로 (POST 도 같은 정책) link 자체도 동일하게 노출.
    payload = [_link_to_read(report_id, lk) for lk in links]
    return success_response(data=payload)


@router.get("/{report_id}/link-graph")
def get_report_link_graph(
    report_id: int,
    depth: int = Query(default=2, ge=1, le=3),
    include_tags: bool = Query(default=False),
    tag_axes: list[str] | None = Query(default=None),
    tag_min_degree: int = Query(default=1, ge=1, le=20),
    include_composites: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 보고서를 중심으로 한 ±depth hop 관계도 (지식그래프 Phase 1a).

    권한은 보고서 read 와 동일 — 중심 보고서가 보이면 그래프도 본다.
    이웃 노드의 가시성은 별도로 가드하지 않는다 (link 자체가 이미 시스템
    전체 linkable 정책으로 노출되는 것과 일관, links GET 과 같은 정책)."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    graph = services.build_link_graph(
        db,
        report_id,
        depth=depth,
        include_tags=include_tags,
        tag_axes=tag_axes,
        tag_min_degree=tag_min_degree,
        include_composites=include_composites,
    )
    if graph is None:
        return not_found_response(f"Report not found: {report_id}")
    return success_response(data=LinkGraphResponse.model_validate(graph))


@router.post("/{report_id}/links")
def create_report_link(
    report_id: int,
    payload: ReportLinkCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """현재 보고서(path) 와 payload.to_report_id 사이 link 생성.
    direction 에 따라 단방향 저장 방향이 결정 — outgoing 이면
    path→target, incoming 이면 target→path. 권한 검사는 *path 보고서* 만."""
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not services.can_read_report(db, actor, report):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없어 link 를 추가할 수 없습니다.",
        )
    target = services.get_report(db, payload.to_report_id)
    if not target:
        return not_found_response(
            f"Target report not found: {payload.to_report_id}"
        )
    # 대상 적격성: "거는 사람이 읽을 수 있는 보고서"만 — 조직/개인 구분 없이 일관.
    # (이전엔 is_linkable_target 으로 조직 보고서면 읽기권한이 없어도 허용했지만,
    #  내가 못 보는 보고서를 연결하는 건 의미가 없고, 어차피 죽은 링크는 조직
    #  보고서에서도 생기므로 읽기권한 기준으로 통일.)
    if not services.can_read_report(db, actor, target):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "연결할 수 없습니다 — 대상 보고서를 볼 권한이 없습니다.",
        )
    # direction 에 따라 from/to 결정. 데이터는 항상 단방향 한 row.
    if payload.direction == "incoming":
        from_id = payload.to_report_id
        to_id = report_id
    else:
        from_id = report_id
        to_id = payload.to_report_id
    try:
        link = services.create_link(
            db,
            from_report_id=from_id,
            to_report_id=to_id,
            kind=payload.kind,
            note=payload.note,
            created_by_user_id=actor.user.id,
        )
    except services.LinkError as exc:
        return error_response(
            str(exc),
            errors=[{"code": exc.code, "message": str(exc)}],
            status_code=400 if exc.code != "duplicate" else 409,
        )
    return created_response(data=_link_to_read(report_id, link))


@router.delete("/{report_id}/links/{link_id}")
def delete_report_link(
    report_id: int,
    link_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """삭제 권한: path 의 보고서 쪽 can_edit 면 OK — link 의 from 이든
    to 든 자기 보고서에서 보이는 link 라면 자기 손으로 정리 가능."""
    from app.shared.permissions import can_edit

    link = services.get_link(db, link_id)
    if link is None:
        return not_found_response(f"Link not found: {link_id}")
    if link.from_report_id != report_id and link.to_report_id != report_id:
        return not_found_response("이 보고서의 link 가 아닙니다.")
    report = services.get_report(db, report_id)
    if report is None:
        return not_found_response(f"Report not found: {report_id}")
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없어 link 를 끊을 수 없습니다.",
        )
    services.delete_link(db, link)
    return success_response(data=None, message="Deleted")
