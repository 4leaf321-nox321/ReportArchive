"""Report models — instances of templated documents.

Each report is bound to a specific template version (so it stays renderable
even when the template evolves). `content` is the JSON document conforming
to the template's JSON Schema; only the envelope fields (workspace, status,
report_date, owner) are promoted to columns for easy filtering.

Workspace scoping is enforced at the service / RLS layer via `workspace_slug`.
A leaf workspace owns its reports; queries on a non-leaf workspace pull all
descendants via the workspace tree helper.
"""
from __future__ import annotations

import enum
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    event,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, Session, attributes, mapped_column, relationship

from app.database import Base
from app.modules.users.models import User


class ReportPhase(str, enum.Enum):
    """Report's collaboration lifecycle — label, not gate.

    Designed to avoid the "approval workflow that nobody uses" trap:
    phase changes happen as side-effects of natural actions (mounting to
    an org board, getting a first external comment, hitting "publish"),
    never via an explicit "request review" gesture. See 협업개선_설계.md
    §8.3 for the auto-transition rules and UI behavior matrix.
    """

    drafting = "drafting"     # 작성 중 — 편집 위주, 핀 hover로만
    reviewing = "reviewing"   # 리뷰 중 — 피드백 수렴, 핀 항상 표시
    finalized = "finalized"   # 발행 완료 — 편집 차단, 코멘트 read-only


class ReportLifecycle(str, enum.Enum):
    """Whether the work the report covers is one-shot or ongoing.

    Orthogonal to `phase` (which is about collaboration state). Used by
    the composite recurring-rollup logic (§7) to decide auto-carry-over
    candidates. `single_shot` only appears in the week it was first
    published; `ongoing` is automatically offered as a carry-over
    candidate every subsequent recurring composite until `closed_at` is
    set.
    """

    single_shot = "single_shot"
    ongoing = "ongoing"


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        # Composite FK to (templates.template_id, templates.version) so a
        # report can never reference a non-existent template version.
        ForeignKeyConstraint(
            ["template_id", "template_version"],
            ["templates.template_id", "templates.version"],
            name="fk_reports_template_version",
            ondelete="RESTRICT",
        ),
        Index("ix_reports_workspace", "workspace_slug"),
        Index("ix_reports_template", "template_id", "template_version"),
        Index("ix_reports_phase", "phase"),
        Index("ix_reports_owner", "owner_user_id"),
        Index("ix_reports_folder", "folder_id"),
        # Carried over from earlier migrations (e18e0d43a9a6, 4b5fea6acfdd)
        # so autogen doesn't try to drop them. The dashboard filters on
        # report_date; updated_by_user_id powers the "최근 편집자" list.
        Index("ix_reports_report_date", "report_date"),
        Index("ix_reports_updated_by_user_id", "updated_by_user_id"),
        # 본문 전문검색 — search_text 평문에 pg_trgm GIN(부분일치, 한국어). 인덱스는
        # 마이그레이션 p37 이 만들지만, autogen 이 드롭하지 않게 여기 선언도 둔다.
        Index(
            "ix_reports_search_text_trgm",
            "search_text",
            postgresql_using="gin",
            postgresql_ops={"search_text": "gin_trgm_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    workspace_slug: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="RESTRICT"),
        nullable=False,
    )
    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    template_version: Mapped[int] = mapped_column(Integer, nullable=False)

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    # Collaboration lifecycle — see ReportPhase docstring.
    # Auto-transitions: first external comment OR mount-to-org-board
    # bumps drafting → reviewing. Explicit "publish" / "unpublish"
    # buttons toggle finalized. No "request review" gate.
    phase: Mapped[ReportPhase] = mapped_column(
        Enum(ReportPhase, name="report_phase_enum"),
        default=ReportPhase.drafting,
        server_default=ReportPhase.drafting.value,
        nullable=False,
    )
    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Tracks who last modified the report (touched on every successful
    # update_report() call). Snapshot only — full history lives in journald
    # if needed; an audit-log table would be overkill at this scale.
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # Phase 3 — denormalized "last editor" for listing UIs ("박과장 작성
    # · 김부장 수정"). Updated whenever someone other than the owner
    # saves, OR also bumped on owner edits so listings always have the
    # most recent. updated_by_user_id stays for backward compat (some
    # legacy views reference it).
    last_edited_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    last_edited_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )

    # Free-form tags — small flat list. Will become a dedicated table once
    # entity extraction lands (개발계획.md §1-4 Phase 1).
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list, nullable=False)

    # "협업 부서" — 이 보고서 업무에 함께 참여한 조직(부서) 워크스페이스 슬러그
    # 목록. 기준정보(엔티티)와 달리 별도 등록 없이 *시스템에 이미 등록된 부서
    # 트리(workspaces)* 를 그대로 참조한다 — 진실의 원천은 워크스페이스. 작성
    # 부서(workspace_slug)·게시 부서(mounts)와는 다른 의미(함께 일한 조직)라
    # 별도 필드. 이름/색은 프런트가 /api/workspaces 로 해석한다. 비어 있으면 [].
    # 역방향 조회("이 부서가 협업한 보고서")가 필요해지면 GIN 인덱스/조인
    # 테이블로 승격(지금은 배열로 단순하게).
    collab_workspace_slugs: Mapped[list[str]] = mapped_column(
        ARRAY(String), default=list, server_default="{}", nullable=False
    )

    # The actual report content as JSON, conforming to the bound template's
    # schema. Validated on write in the service layer.
    content: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # Per-report layout overrides keyed by template block id:
    #   { "<block_id>": { "row": int, "col_span": int, "row_span": int }, ... }
    # When a block id is absent here, the template's layout is used. Reports
    # cannot add/remove blocks via this field — only resize/reposition the
    # ones the template already declared.
    layout_overrides: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Per-report widget-props overrides keyed by template block id:
    #   { "<block_id>": { "text_style": {...}, "depth_styles": {...} }, ... }
    # Only visual-style keys are accepted (see services._sanitize_props_overrides);
    # structural props (items, min_length, etc.) cannot be overridden per report
    # because the content schema is derived from them.
    props_overrides: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Ordered list of pages for multi-page reports. Each entry is shaped:
    #   {template_id, template_version, content, layout_overrides, props_overrides}
    # `pages[0]` is mirrored into the top-level columns above so the FK
    # constraint and list-view fields remain authoritative for the *primary*
    # template. Subsequent pages reference their template only via id+version
    # inside this JSON blob (no DB-level FK).
    pages: Mapped[list[dict]] = mapped_column(JSONB, default=list, nullable=False)

    # 본문 전문검색용 평탄화 평문(제목 + 모든 위젯 텍스트). app.widgets.
    # text_extraction 으로 쓰기 경로에서 갱신, pg_trgm GIN 으로 부분일치 검색.
    # NULL = 아직 색인 안 됨(백필 전 기존 행).
    search_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Optimistic-concurrency counter. Bumped on every successful
    # update_report() call; PATCH callers must echo back the revision they
    # fetched, otherwise the service raises a revision_mismatch 409. Pairs
    # with the pessimistic ReportEditLock below as a belt-and-suspenders
    # safety net (matters specifically right after a forced takeover, when
    # the prior holder may still try to save before they notice).
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )

    # Aggregation reference date — used by the dashboard's period filters
    # instead of created_at, so reports that are filled in retroactively
    # can still be bucketed against the period they actually describe.
    # Defaults to today on insert; editable from the report form.
    report_date: Mapped[date] = mapped_column(
        Date, nullable=False, server_default=func.current_date()
    )

    # Per-report max content width in pixels. NULL = use the frontend's
    # narrow default (~1024px). Editable from the report detail view via
    # the empty-area right-click "보고서 폭 설정". Capped client-side at
    # 3000; the server only enforces the integer column type.
    page_width_px: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Per-report vertical gap (px) between top-level widget rows. NULL =
    # use the frontend default. Editable from the 보고서 설정 dialog's
    # 페이지 설정 tab. Capped client-side at 0–200; the server only
    # enforces the integer column type.
    page_gap_px: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # When True, widget container chrome (the per-block card border /
    # background / shadow) blends into the page so individual widgets
    # are no longer visually delimited. NULL/False keeps the default
    # bordered cards. Editable from the 보고서 설정 dialog's page tab.
    page_blend_blocks: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True
    )

    # PPT export 보조용 슬라이드 가이드. 본문 위에 슬라이드 한 장이
    # 차지할 세로 경계를 점선으로 보여준다. 4개 컬럼 모두 NULL이면
    # 프론트는 "가이드 OFF"로 취급한다. page_slide_ratio 는 "16:9" /
    # "4:3" / "16:10" / "custom" 중 하나이고, "custom" 일 때만 _custom_w
    # / _custom_h 가 의미를 가진다.
    page_slide_guide: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    page_slide_ratio: Mapped[str | None] = mapped_column(String(16), nullable=True)
    page_slide_ratio_custom_w: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    page_slide_ratio_custom_h: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )

    # 긴 글(rich_text) 위젯의 depth-별 머리 기호 override. 세 칸이 (depth 0
    # 대표 문장 / depth 1 상세 / depth 2+ 깊은 설명) 에 대응하며, 깊은
    # 들여쓰기(depth 3+) 는 depth 2 글리프를 그대로 이어 쓴다. 각 칸이 NULL
    # 이면 그 depth 만 프런트 기본 글리프(■ / – / ·) 로 폴백 — 일부만 지정해
    # 부분 override 가 가능하다. 다이얼로그에서 8자 컷 (컬럼도 String(8)).
    page_rich_text_prefix_d0: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    page_rich_text_prefix_d1: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    page_rich_text_prefix_d2: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )

    # 보고서별 기본 보기 모드 — "paginated"(페이지별) / "all"(전체 스택).
    # NULL 이면 프런트가 개인 전역 환경설정(localStorage)→"paginated" 로 폴백.
    # 편집모드에서 보기 토글을 바꾸면 여기에 저장돼 그 보고서를 다시 열 때
    # 같은 모드로 뜬다. (기존/ MCP·AI 작성 보고서는 NULL 로 남아 폴백.)
    page_default_view_mode: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )

    # Optional report-type tag — system-wide controlled vocabulary
    # orthogonal to the template (templates describe shape; types
    # describe purpose, e.g. "주간 보고", "안전 점검"). Managed by
    # the report_types module; SET NULL on delete so reports never
    # cascade-vanish when an admin cleans up the vocabulary.
    report_type_id: Mapped[int | None] = mapped_column(
        ForeignKey("report_types.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # ── Personal-space organization ─────────────────────────────────────
    # Personal-space folder this report sits in. NULL = uncategorized
    # ("분류 안 한 보고서"). Folders are per-user (folders module owns
    # them). Mount status / org visibility is orthogonal — folder is a
    # purely personal organizational concern.
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), nullable=True
    )

    # ── Lifecycle (single vs ongoing) ───────────────────────────────────
    # See ReportLifecycle docstring. `ongoing` reports are auto-offered
    # as carry-over candidates in the next recurring composite; `closed_at`
    # turns that off (the work wrapped up).
    lifecycle: Mapped[ReportLifecycle] = mapped_column(
        Enum(ReportLifecycle, name="report_lifecycle_enum"),
        default=ReportLifecycle.single_shot,
        server_default=ReportLifecycle.single_shot.value,
        nullable=False,
    )
    closed_at: Mapped[date | None] = mapped_column(Date, nullable=True)

    # ── Author hard lock (max-priority edit veto) ───────────────────────
    # When `author_lock_enabled` is True, only the owner can edit — every
    # other path (lead role, additional editors, coauthor policy) is
    # blocked. Reason is shown in the lock banner. Workspace admin can
    # force-unset (audit-logged) when the owner is unavailable.
    author_lock_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    author_lock_reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    author_lock_set_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )

    # ── Soft delete (휴지통) ───────────────────────────────────────────
    # "삭제"는 즉시 파괴가 아니라 소프트삭제 — deleted_at 이 set 되면 작성자
    # 개인 목록·검색에서 숨고(=휴지통), 복구 가능. 단 게시(mount)된 부서
    # 게시판에는 그대로 남는다(게시분 보존). 영구삭제(purge)는 별도 경로.
    # 보고서 삭제 재설계(소프트삭제+게시판별 게시취소 요청) 1단계.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    deleted_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # ── Fork lineage (referenced copy from another team's report) ──────
    # Set when this report was created via "참조 복제" from another
    # report (Phase 8 feature; columns laid down now to avoid a later
    # migration). `forked_from_report_id` is SET NULL on origin delete so
    # the copy survives; `forked_at_revision` records the origin's
    # revision number at the moment of copy for "compare to current"
    # back-references.
    forked_from_report_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id", ondelete="SET NULL"), nullable=True
    )
    forked_at_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Eagerly load the two user joins — every read of a Report needs the
    # owner / last-editor display info, so paying one JOIN beats N+1 lookups
    # in the route layer.
    owner: Mapped["User | None"] = relationship(
        "User", foreign_keys=[owner_user_id], lazy="joined"
    )
    updated_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[updated_by_user_id], lazy="joined"
    )
    # Phase 3 — Same JOIN cost as updated_by; tiny User row, eagerly
    # loaded so listings can render "박과장 · 김부장 수정" without N+1.
    last_editor: Mapped["User | None"] = relationship(
        "User", foreign_keys=[last_edited_by_user_id], lazy="joined"
    )

    # Eager-load the report-type tag — list payloads need name + status
    # for the "종류" column, and detail views show the description in
    # the settings dialog. Skipping the JOIN would mean an N+1 over the
    # list endpoint.
    report_type: Mapped["ReportType | None"] = relationship(  # noqa: F821
        "ReportType",
        foreign_keys=[report_type_id],
        lazy="joined",
    )
    # Current edit lock, if any. Eager-loaded so the report GET can include
    # "who's editing" without a second query. The lock row may exist but be
    # expired — the service layer decides what counts as live.
    edit_lock: Mapped["ReportEditLock | None"] = relationship(
        "ReportEditLock",
        back_populates="report",
        uselist=False,
        cascade="all, delete-orphan",
        lazy="joined",
    )

    # M:N to Entity via the `report_entities` link table (owned by the
    # `entities` module). `selectin` avoids the row-multiplication a
    # joined load would cause across the M:N — one extra SELECT per
    # batch is the right trade-off for list endpoints that pull dozens
    # of reports at once. `order_by` keeps the JSON shape deterministic.
    entities: Mapped[list["Entity"]] = relationship(  # noqa: F821
        "Entity",
        secondary="report_entities",
        lazy="selectin",
        order_by="Entity.value",
    )

    # Org-board placements (게시). `selectin` so a list endpoint pulling
    # 50 reports does one extra SELECT IN for all their mounts rather
    # than 50 lazy lookups. `viewonly` because the actual mount/unmount
    # lifecycle is owned by the mounts service — this side is read-only
    # projection. ReportMount.workspace is `joined`, so the mount rows
    # arrive with the Workspace name already attached for the list cell
    # ("팀1·본부A에 게시됨").
    mounts: Mapped[list["ReportMount"]] = relationship(  # noqa: F821
        "ReportMount",
        primaryjoin="Report.id == ReportMount.report_id",
        foreign_keys="ReportMount.report_id",
        lazy="selectin",
        order_by="ReportMount.mounted_at",
        viewonly=True,
    )


@event.listens_for(Report, "before_insert")
@event.listens_for(Report, "before_update")
def _report_reindex_search_text(mapper, connection, target: "Report") -> None:
    """본문 전문검색 평문(search_text) 자동 유지.

    title / content / pages 중 하나라도 바뀐 insert·update 에서만 재계산한다 —
    폴더 이동·잠금 터치·phase 변경 등 본문과 무관한 update 에서는 건너뛰어
    불필요한 JSON 워킹을 피한다. 평문 추출은 위젯 구조·HTML strip 이 필요해
    Python(app.widgets.text_extraction)이 담당하므로 DB 트리거가 아니라 여기서.
    """
    changed = any(
        attributes.get_history(target, name).has_changes()
        for name in ("title", "content", "pages")
    )
    if not changed:
        return
    # 지연 import — 위젯 레지스트리 패키지 init 과의 import 순서/순환 회피.
    from app.widgets.text_extraction import extract_searchable_text_for_report

    target.search_text = extract_searchable_text_for_report(target) or None


# --------------------------------------------------------------------------- #
# 온-세이브 임베딩 트리거 (RAG) — 본문이 바뀐 보고서를 커밋 후 임베딩 큐에 적재.
# search_text 처럼 모든 저장 경로를 한 곳(세션 이벤트)에서 잡는다. 임베딩은 느리고
# 외부 모델(Ollama) 호출이라 인라인으로 하지 않고 embed_report 워커 잡으로 위임한다.
# 적재는 *커밋 이후* (별도 세션) — id 가 확정되고, 보고서 저장 트랜잭션을 막지 않게.
# settings.embedding_auto_on_save 로 게이트(미배포 환경 보호). embed_report 가
# content_hash 로 변화 없는 건 스킵하므로, 본문 무관 저장이 잡혀도 비용은 무시 수준.
# --------------------------------------------------------------------------- #
def _report_content_changed(target: "Report") -> bool:
    return any(
        attributes.get_history(target, name).has_changes()
        for name in ("title", "content", "pages")
    )


@event.listens_for(Session, "before_flush")
def _collect_reports_for_embedding(session, flush_context, instances) -> None:
    # 새 보고서 + 본문 바뀐 보고서를 세션 버킷에 모은다(id 는 커밋 후 읽음).
    bucket = session.info.setdefault("_reports_to_embed", set())
    for obj in session.new:
        if isinstance(obj, Report):
            bucket.add(obj)
    for obj in session.dirty:
        if isinstance(obj, Report) and _report_content_changed(obj):
            bucket.add(obj)


@event.listens_for(Session, "after_rollback")
def _clear_embedding_bucket(session) -> None:
    session.info.pop("_reports_to_embed", None)


@event.listens_for(Session, "after_commit")
def _enqueue_report_ai_jobs(session) -> None:
    """저장된 보고서에 임베딩(RAG)·자동요약(B) 잡을 적재. 두 스위치는 독립이라
    한쪽만 켜도 그 잡만 뜬다. 자동요약의 작성자 엔티틀먼트(§E) 게이트는 핸들러
    에서 — 트리거는 전역 스위치만 본다."""
    bucket = session.info.pop("_reports_to_embed", None)
    if not bucket:
        return
    from app.config import settings

    do_embed = settings.embedding_auto_on_save
    do_summarize = settings.llm_auto_summarize_on_save
    if not (do_embed or do_summarize):
        return
    report_ids = {o.id for o in bucket if getattr(o, "id", None) is not None}
    if not report_ids:
        return
    # 별도 세션에서 적재 — 원 트랜잭션은 이미 끝났다. dedup_key 로 같은 보고서가
    # 대기/처리 중이면 중복 적재 안 함(빠른 연속 저장 흡수). 실패 시 다음 저장/배치
    # 스윕이 보강.
    from sqlalchemy.exc import IntegrityError

    from app.database import SessionLocal
    from app.jobs.queue import enqueue

    def _try(s2, job_type, rid):
        try:
            enqueue(s2, job_type, {"report_id": rid}, dedup_key=f"{job_type}:{rid}")
            s2.commit()
        except IntegrityError:
            s2.rollback()  # 이미 같은 보고서 잡이 대기/처리 중

    s2 = SessionLocal()
    try:
        for rid in report_ids:
            if do_embed:
                _try(s2, "embed_report", rid)
            if do_summarize:
                _try(s2, "summarize_report", rid)
    finally:
        s2.close()


class ReportEditLock(Base):
    """Pessimistic edit lock — at most one row per report (report_id is PK).

    Acquired when a user enters edit mode; refreshed by periodic heartbeats
    while editing; released on save/cancel/page-leave. The TTL (`expires_at`)
    lets abandoned sessions auto-release: any acquire call past that point
    treats the row as orphaned and upserts the new holder.

    Reads of this row should *always* compare `expires_at` against `now` in
    the service layer — never trust mere existence. See
    services.get_active_lock().
    """

    __tablename__ = "report_edit_locks"

    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    acquired_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    report: Mapped["Report"] = relationship(
        "Report", back_populates="edit_lock"
    )
    user: Mapped["User"] = relationship("User", lazy="joined")


class ReportLink(Base):
    """보고서 간 단방향 의미 link — (from_report) → (to_report).

    같은 쌍에 여러 kind 를 동시에 둘 수 있다 (예: A 가 B 를 「참조」하면서
    동시에 「후속」으로도 표시). 양방향 backlink 는 별도 row 가 아니라
    동일 row 를 to_report 쪽 화면에서 reverseLabel 로 뒤집어 보여주는
    방식 — 데이터 중복 없음.

    kind 는 self-validating 하지 않고 app/shared/link_kinds.py 의
    LINK_KINDS 상수 안 key 들만 허용 (서비스 레이어에서 검증). 새 유형은
    그 상수에 한 줄 추가 — 마이그레이션 불필요.
    """

    __tablename__ = "report_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    from_report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    to_report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
    )

    from_report: Mapped["Report"] = relationship(
        "Report", foreign_keys=[from_report_id]
    )
    to_report: Mapped["Report"] = relationship(
        "Report", foreign_keys=[to_report_id]
    )
    created_by: Mapped["User | None"] = relationship("User", lazy="joined")

    __table_args__ = (
        UniqueConstraint(
            "from_report_id",
            "to_report_id",
            "kind",
            name="uq_report_links_from_to_kind",
        ),
    )


class ReportLinkKind(Base):
    """관리자가 정의하는 link 의미 카탈로그.

    seed 시 ``reference`` / ``successor`` 두 row 가 system_locked=True 로
    들어가 있다 — 라벨/색은 바꿀 수 있지만 key 와 row 자체는 못 건드린다
    (기존 ``report_links.kind`` 와의 호환성 유지). 그 외 row 는 admin 이
    자유롭게 추가/편집/삭제 가능. 단, 사용 중 (= 같은 key 를 가진
    report_links 가 존재) 인 row 는 삭제 거부 — 서비스 레이어에서 검사.

    ``report_links.kind`` 와 FK 로 묶지 않는 이유: cascade 정책이 복잡하고
    (실수로 link 까지 같이 날아가는 게 위험), "사용 중이면 거부" 정책을
    서비스 레이어에서 더 표현력 있게 다룰 수 있어서.
    """

    __tablename__ = "report_link_kinds"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    forward_label: Mapped[str] = mapped_column(String(40), nullable=False)
    reverse_label: Mapped[str] = mapped_column(String(40), nullable=False)
    color: Mapped[str] = mapped_column(String(16), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    system_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
    )


class ReportVersion(Base):
    """보고서 본문 과거 스냅샷 — 수정 이력·되돌리기. 핫 `reports` 와 분리한 콜드
    테이블(보고서 삭제 시 CASCADE). 본문은 gzip 한 JSON 을 BYTEA(body_gzip)로
    담는다(통째로 읽고 쓰는 불투명 blob — JSONB 오버헤드·파싱 불필요, 압축률↑).
    비용은 (1) 세션 병합 + 무변경 dedup 으로 버전 수를, (2) gzip 으로 크기를,
    (3) 보고서당 최근 N 보존(prune)으로 총량을 누른다. 미디어(영상/이미지)는
    file_id 참조만 들어가 스냅샷에 복제되지 않는다(설계문서 §1).
    """

    __tablename__ = "report_versions"
    __table_args__ = (
        # 타임라인 목록(report 별 최신순) + FK 조회(report_id 선두) 겸용.
        Index("ix_report_versions_report_created", "report_id", "created_at"),
        UniqueConstraint("report_id", "seq", name="uq_report_versions_report_seq"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=False
    )
    # 보고서당 1,2,3… 순번(표시·정렬·UNIQUE). revision 은 그때의 낙관적 잠금값.
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    author_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 'save' | 'restore' | 'publish' — 이 버전이 생긴 경위(앱 레벨 값).
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="save"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    # gzip(JSON{title, pages, content, layout_overrides, props_overrides}).
    body_gzip: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # 압축 전 JSON 의 sha256 — 직전 버전과 같으면 무변경 dedup 으로 스냅샷 skip.
    body_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    # 압축 전 바이트수(표시·용량 추정용).
    body_bytes: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    # 명명 체크포인트(후순위) — 있으면 prune 에서 항상 보존.
    label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # 고정(항상 보존) 플래그.
    is_pinned: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
