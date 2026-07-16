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

    def _index_response() -> FileResponse:
        """index.html 은 **매번 재검증**시킨다(no-cache).

        이 파일만이 해시 붙은 청크 이름들의 유일한 진입점이다. 배포는 SIF 를
        통째로 갈아끼워 /assets 의 옛 청크를 전부 없애므로, 브라우저가 옛
        index.html 을 계속 쓰면 이미 사라진 청크를 가리키게 되고 지연 로딩
        (예: HTML 내보내기)이 404 로 죽는다 —
        "Failed to fetch dynamically imported module".

        헤더가 없으면 브라우저는 휴리스틱 캐싱(마지막 수정 이후 경과의 10% 가량)
        으로 재검증 없이 옛 파일을 며칠씩 쓸 수 있어, 새로고침해도 안 낫는다.

        참고: FileResponse 는 조건부 요청(If-None-Match)을 처리하지 않아 304 를
        내주지 못한다 — 매 요청마다 index.html 본문이 다시 나간다. 수 KB짜리
        진입점 하나라 그대로 둔다. 정말 문제가 되면 StaticFiles(304 처리 있음)로
        옮기거나 여기서 ETag 를 직접 비교하면 된다.

        /assets 아래 파일들은 내용 해시가 이름에 박혀 있어 이 처리가 필요 없다.
        """
        return FileResponse(index_file, headers={"Cache-Control": "no-cache"})

    @app.get("/", include_in_schema=False)
    def _serve_index() -> FileResponse:
        return _index_response()

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
        return _index_response()

    logger.info("Serving frontend dist from %s", dist_path)


app = create_app()
