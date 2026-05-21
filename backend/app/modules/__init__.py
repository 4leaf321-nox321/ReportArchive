"""
Module router registration.

Each feature lives under app/modules/<name>/ and exposes `router` (an
APIRouter). Add new modules to `register_routers` below.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.modules.admin.routes import router as admin_router
from app.modules.auth.routes import router as auth_router
from app.modules.composites.routes import router as composites_router
from app.modules.files.routes import router as files_router
from app.modules.members.routes import router as members_router
from app.modules.reports.routes import router as reports_router
from app.modules.section_taxonomy.routes import router as section_taxonomy_router
from app.modules.template_categories.routes import router as template_categories_router
from app.modules.templates.routes import router as templates_router
from app.modules.users.routes import router as users_router
from app.modules.widget_relations.routes import router as widget_relations_router
from app.modules.widgets.routes import router as widgets_router
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
    app.include_router(composites_router, prefix="/api/composites", tags=["composites"])
    app.include_router(files_router, prefix="/api/files", tags=["files"])
    app.include_router(
        section_taxonomy_router,
        prefix="/api/section-taxonomy",
        tags=["section-taxonomy"],
    )
    app.include_router(admin_router, prefix="/api/admin", tags=["admin"])
