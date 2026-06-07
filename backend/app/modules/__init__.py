"""
Module router registration.

Each feature lives under app/modules/<name>/ and exposes `router` (an
APIRouter). Add new modules to `register_routers` below.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.modules.admin.routes import router as admin_router
from app.modules.auth.routes import router as auth_router
from app.modules.comments.routes import router as comments_router
from app.modules.composites.routes import router as composites_router
from app.modules.editors.routes import router as editors_router
from app.modules.embed.routes import router as embed_router
from app.modules.activities.routes import router as activities_router
from app.modules.entities.routes import (
    entities_router,
    entity_types_router,
)
from app.modules.files.routes import router as files_router
from app.modules.folders.routes import router as folders_router
from app.modules.grants.routes import router as grants_router
from app.modules.members.routes import router as members_router
from app.modules.mounts.routes import router as mounts_router
from app.modules.notifications.routes import router as notifications_router
from app.modules.presets.routes import router as presets_router
from app.modules.prompts.routes import router as prompts_router
from app.modules.report_types.routes import router as report_types_router
from app.modules.reports.routes import router as reports_router
from app.modules.section_taxonomy.routes import router as section_taxonomy_router
from app.modules.template_categories.routes import router as template_categories_router
from app.modules.templates.routes import router as templates_router
from app.modules.users.routes import router as users_router
from app.modules.widget_relations.routes import router as widget_relations_router
from app.modules.widgets.routes import router as widgets_router
from app.modules.voc.routes import router as voc_router
from app.modules.workspaces.routes import router as workspaces_router


def register_routers(app: FastAPI) -> None:
    app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
    app.include_router(workspaces_router, prefix="/api/workspaces", tags=["workspaces"])
    app.include_router(members_router, prefix="/api/workspaces", tags=["members"])
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
        entities_router,
        prefix="/api/entities",
        tags=["entities"],
    )
    app.include_router(prompts_router, prefix="/api/prompts", tags=["prompts"])
    app.include_router(composites_router, prefix="/api/composites", tags=["composites"])
    app.include_router(presets_router, prefix="/api/presets", tags=["presets"])
    app.include_router(files_router, prefix="/api/files", tags=["files"])
    app.include_router(embed_router, prefix="/api/embed", tags=["embed"])
    app.include_router(
        section_taxonomy_router,
        prefix="/api/section-taxonomy",
        tags=["section-taxonomy"],
    )
    app.include_router(admin_router, prefix="/api/admin", tags=["admin"])
    app.include_router(voc_router, prefix="/api/voc", tags=["voc"])
    # Phase 0 — empty routers registered now so Phase 1/2/3/4 can
    # add endpoints without touching this file. See each module's
    # routes.py for the activation phase.
    app.include_router(mounts_router, prefix="/api/mounts", tags=["mounts"])
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
