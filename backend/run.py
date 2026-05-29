"""
FastAPI Application Entry Point.

Cross-platform launcher for the backend. Reads host/port/env from .env or
environment variables so the same script works on Windows, Linux and macOS.

Usage:
    python run.py                    # development (reload on)
    APP_ENV=production python run.py # production (multi-worker uvicorn)
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the backend root, regardless of CWD.
BACKEND_ROOT = Path(__file__).resolve().parent
load_dotenv(BACKEND_ROOT / ".env")


def main() -> None:
    import uvicorn

    env = os.environ.get("APP_ENV", "development")
    host = os.environ.get("APP_HOST", "0.0.0.0")
    port = int(os.environ.get("APP_PORT", "3000"))
    # 워커 수는 관리자-서버 UI 에서 DB 행으로 저장 가능 — 그쪽이 있으면
    # 우선, 없으면 env 의 UVICORN_WORKERS, 마지막은 4. runtime_tuning
    # 모듈이 모두 fallback 하므로 단일 호출로 충분.
    from app.shared.runtime_tuning import get_int

    workers = get_int("uvicorn_workers")

    banner = f"""
    ================================================================
    |              Report Archive Backend (FastAPI)                |
    ================================================================
    |  Environment: {env:<46}|
    |  Host:        {host:<46}|
    |  Port:        {port:<46}|
    ================================================================
    """
    print(banner)

    if env == "development":
        # Reload watches the app package; use the import-string form so
        # uvicorn can spawn workers / reload them safely.
        uvicorn.run(
            "app.main:app",
            host=host,
            port=port,
            reload=True,
            reload_dirs=[str(BACKEND_ROOT / "app")],
        )
    else:
        uvicorn.run(
            "app.main:app",
            host=host,
            port=port,
            workers=workers,
            log_level="info",
        )


if __name__ == "__main__":
    main()
