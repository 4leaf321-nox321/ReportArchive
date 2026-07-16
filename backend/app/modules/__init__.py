"""
Module router registration.

Each feature lives under app/modules/<name>/ and exposes `router` (an
APIRouter). Add new modules to `register_routers` below.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.jobs.admin_routes import router as jobs_admin_router
from app.jobs.routes import router as jobs_router
from app.modules.admin.routes import router as admin_router
from app.modules.ai.routes import router as ai_router
from app.modules.alerts.routes import router as alerts_router
from app.modules.auth.routes import router as auth_router
from app.modules.comments.routes import router as comments_router
from app.modules.composites.routes import router as composites_router
from app.modules.connectors.routes import router as connectors_router
from app.modules.composite_presets.routes import router as composite_presets_router
from app.modules.dashboard.routes import router as dashboard_router
from app.modules.pins.routes import router as pins_router
from app.modules.template_metrics.routes import router as template_metrics_router
from app.modules.editors.routes import router as editors_router
from app.modules.embed.routes import router as embed_router
from app.modules.activities.routes import router as activities_router
from app.modules.entities.routes import (
    entities_router,
    entity_types_router,
    objects_router,
    relation_types_router,
)
from app.modules.files.routes import router as files_router
from app.modules.folders.routes import router as folders_router
from app.modules.imports.routes import router as imports_router
from app.modules.grants.routes import router as grants_router
from app.modules.members.routes import router as members_router
from app.modules.mounts.routes import router as mounts_router
from app.modules.mounts.routes import takedown_router
from app.modules.notifications.routes import router as notifications_router
from app.modules.presets.routes import router as presets_router
from app.modules.prompts.routes import router as prompts_router
from app.modules.report_types.routes import router as report_types_router
from app.modules.reports.routes import router as reports_router
from app.modules.saved_searches.routes import router as saved_searches_router
from app.modules.section_taxonomy.routes import router as section_taxonomy_router
from app.modules.template_categories.routes import router as template_categories_router
from app.modules.templates.routes import router as templates_router
from app.modules.users.routes import router as users_router
from app.modules.widget_relations.routes import router as widget_relations_router
from app.modules.widgets.routes import router as widgets_router
from app.modules.notices.routes import router as notices_router
from app.modules.voc.routes import router as voc_router
from app.modules.workspaces.routes import router as workspaces_router


def register_routers(app: FastAPI) -> None:
    app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
    app.include_router(workspaces_router, prefix="/api/workspaces", tags=["workspaces"])
    app.include_router(members_router, prefix="/api/workspaces", tags=["members"])
    app.include_router(pins_router, prefix="/api/workspaces", tags=["pins"])
    app.include_router(users_router, prefix="/api", tags=["users"])  # /api/me, /api/users
    app.include_router(
        template_categories_router,
        prefix="/api/template-categories",
        tags=["template-categories"],
    )
    app.include_router(templates_router, prefix="/api/templates", tags=["templates"])
    app.include_router(widgets_router, prefix="/api/widgets", tags=["widgets"])
    app.include_router(
        widget_relations_router,
        prefix="/api/widget-relations",
        tags=["widget-relations"],
    )
    app.include_router(reports_router, prefix="/api/reports", tags=["reports"])
    app.include_router(
        saved_searches_router,
        prefix="/api/saved-searches",
        tags=["saved-searches"],
    )
    app.include_router(
        report_types_router,
        prefix="/api/report-types",
        tags=["report-types"],
    )
    app.include_router(
        entity_types_router,
        prefix="/api/entity-types",
        tags=["entity-types"],
    )
    app.include_router(
        relation_types_router,
        prefix="/api/relation-types",
        tags=["relation-types"],
    )
    app.include_router(
        entities_router,
        prefix="/api/entities",
        tags=["entities"],
    )
    app.include_router(objects_router, prefix="/api/objects", tags=["objects"])
    app.include_router(prompts_router, prefix="/api/prompts", tags=["prompts"])
    app.include_router(composites_router, prefix="/api/composites", tags=["composites"])
    app.include_router(
        composite_presets_router,
        prefix="/api/composite-presets",
        tags=["composite-presets"],
    )
    app.include_router(presets_router, prefix="/api/presets", tags=["presets"])
    # 외부 시스템 연계 커넥터(관리자) — 외부 API → 온톨로지 동기화.
    app.include_router(connectors_router, prefix="/api/connectors", tags=["connectors"])
    app.include_router(dashboard_router, prefix="/api", tags=["dashboard"])
    app.include_router(
        template_metrics_router,
        prefix="/api/admin/template-metrics",
        tags=["template-metrics"],
    )
    app.include_router(files_router, prefix="/api/files", tags=["files"])
    app.include_router(imports_router, prefix="/api/imports", tags=["imports"])
    app.include_router(embed_router, prefix="/api/embed", tags=["embed"])
    app.include_router(
        section_taxonomy_router,
        prefix="/api/section-taxonomy",
        tags=["section-taxonomy"],
    )
    app.include_router(admin_router, prefix="/api/admin", tags=["admin"])
    # B300 보조 AI — 연결 진단(M0). 이후 RAG Q&A·엔티틀먼트가 같은 prefix 로 붙는다.
    app.include_router(ai_router, prefix="/api/ai", tags=["ai"])
    app.include_router(voc_router, prefix="/api/voc", tags=["voc"])
    # 공지 게시판 — 시스템 관리자만 작성, 전원 열람. VOC 와 대칭.
    app.include_router(notices_router, prefix="/api/notices", tags=["notices"])
    # Phase D 경보/트리거(관리자) — 온톨로지 상태 규칙 발화. 1단계=수동 실행.
    app.include_router(alerts_router, prefix="/api/alerts", tags=["alerts"])
    # Phase 0 — empty routers registered now so Phase 1/2/3/4 can
    # add endpoints without touching this file. See each module's
    # routes.py for the activation phase.
    app.include_router(mounts_router, prefix="/api/mounts", tags=["mounts"])
    app.include_router(
        takedown_router, prefix="/api/takedown-requests", tags=["takedowns"]
    )
    # Comments routes span multiple root paths (/api/reports/.../threads,
    # /api/threads/..., /api/comments/...) so we mount with just /api.
    app.include_router(comments_router, prefix="/api", tags=["comments"])
    app.include_router(
        notifications_router, prefix="/api/notifications", tags=["notifications"]
    )
    app.include_router(folders_router, prefix="/api/folders", tags=["folders"])
    # Editors routes use full paths starting with /reports — mount at
    # /api so the URL becomes /api/reports/{id}/editors.
    app.include_router(editors_router, prefix="/api", tags=["editors"])
    # Activities routes use full paths starting with /reports — mount at
    # /api so the URL becomes /api/reports/{id}/activities.
    app.include_router(activities_router, prefix="/api", tags=["activities"])
    # 통합 공유(grant) — /api/{reports|composites}/{id}/shares.
    app.include_router(grants_router, prefix="/api", tags=["grants"])
    # 백그라운드 작업 큐 — 운영(관리자) 라우트를 폴링 라우트보다 *먼저* 등록해야
    # "/api/jobs/admin" 이 jobs_router 의 GET /{job_id} 로 새지 않는다(라우트 매칭
    # 은 등록 순서). 관리자: 통계·헬스·재시도·취소·정리.
    app.include_router(
        jobs_admin_router, prefix="/api/jobs/admin", tags=["jobs-admin"]
    )
    # 상태 폴링(읽기 전용, 본인 잡). 적재는 각 도메인 라우트가 직접.
    app.include_router(jobs_router, prefix="/api/jobs", tags=["jobs"])
