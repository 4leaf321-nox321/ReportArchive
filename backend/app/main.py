"""
FastAPI application factory.

This module wires up:
  - CORS (so the frontend can call this API from any allowed origin)
  - Module routers under /api/...
  - Standardized error handlers
  - Optional SPA fallback that serves the built frontend (combined deployment)

The same backend supports two deployment shapes:
  1. Independent: only /api/* is exposed; the frontend is hosted elsewhere.
  2. Combined  : SERVE_FRONTEND_DIST points to frontend/dist; this app
                 also serves index.html and static assets, with SPA fallback.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.modules import register_routers
from app.shared.errors import register_exception_handlers

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown hooks. Add DB warmup, cache, etc. here."""
    logger.info("Starting %s in %s mode", settings.app_name, settings.app_env)
    yield
    logger.info("Shutting down %s", settings.app_name)


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    _configure_cors(app)
    register_exception_handlers(app)
    register_routers(app)

    @app.get("/api/health", tags=["health"])
    def health() -> dict:
        return {"status": "ok", "env": settings.app_env, "name": settings.app_name}

    _mount_frontend_if_configured(app)

    return app


def _configure_cors(app: FastAPI) -> None:
    origins = settings.cors_origin_list
    if not origins:
        logger.warning("CORS_ORIGINS is empty; cross-origin requests will be rejected.")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins or ["*"] if settings.is_development else origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )


def _mount_frontend_if_configured(app: FastAPI) -> None:
    """
    If SERVE_FRONTEND_DIST is set and exists, mount it as static files
    and provide an SPA fallback for non-API routes. This is what lets a
    single backend process serve the React build directly.
    """
    dist_path: Path | None = settings.frontend_dist_path
    if dist_path is None:
        return
    if not dist_path.exists():
        logger.warning("SERVE_FRONTEND_DIST set but path does not exist: %s", dist_path)
        return

    assets_dir = dist_path / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    index_file = dist_path / "index.html"

    @app.get("/", include_in_schema=False)
    def _serve_index() -> FileResponse:
        return FileResponse(index_file)

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_fallback(full_path: str, request: Request):
        # API routes are handled by routers; if a request reaches here with
        # /api prefix, no route matched -> return JSON 404.
        if full_path.startswith("api/"):
            return JSONResponse(
                {"success": False, "message": f"API endpoint not found: /{full_path}"},
                status_code=404,
            )

        # Try real file first (e.g. /favicon.ico, /robots.txt)
        candidate = dist_path / full_path
        if candidate.is_file():
            return FileResponse(candidate)

        # Otherwise let React Router handle the route.
        return FileResponse(index_file)

    logger.info("Serving frontend dist from %s", dist_path)


app = create_app()
