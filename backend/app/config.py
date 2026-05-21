"""
Application configuration.

Uses pydantic-settings to read environment variables and .env values.
Cross-platform: paths are resolved with pathlib so the same code runs
on Windows / Linux / macOS without changes.
"""
from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_ROOT.parent


class Settings(BaseSettings):
    """Single source of truth for runtime configuration."""

    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App ---
    app_env: str = Field(default="development")
    app_name: str = Field(default="ReportArchive")
    app_host: str = Field(default="0.0.0.0")
    app_port: int = Field(default=3000)

    # --- Security ---
    secret_key: str = Field(default="dev-secret-key-change-me")
    jwt_secret_key: str = Field(default="dev-jwt-secret-key-change-me")
    jwt_access_token_expires_hours: int = Field(default=12)
    jwt_refresh_token_expires_days: int = Field(default=30)

    # --- Database ---
    database_url: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/report_automation"
    )
    test_database_url: Optional[str] = Field(default=None)
    sqlalchemy_echo: bool = Field(default=False)

    # --- CORS ---
    cors_origins: str = Field(
        default="http://localhost:3000,http://localhost:3001"
    )

    # --- Frontend serving (combined deployment) ---
    serve_frontend_dist: str = Field(default="")

    # --- File uploads ---
    upload_dir: str = Field(default="uploads")
    upload_max_bytes: int = Field(default=25 * 1024 * 1024)  # 25 MB
    # CAD models (GLB/STL/STEP/...) routinely exceed the general image
    # limit. The files route detects CAD extensions and applies this
    # cap instead. Phase-1 default of 200 MB matches the realistic
    # ceiling for a mid-size assembly export.
    upload_max_bytes_cad: int = Field(default=200 * 1024 * 1024)

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() == "development"

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @property
    def cors_origin_list(self) -> List[str]:
        if not self.cors_origins.strip():
            return []
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def jwt_access_token_expires(self) -> timedelta:
        return timedelta(hours=self.jwt_access_token_expires_hours)

    @property
    def jwt_refresh_token_expires(self) -> timedelta:
        return timedelta(days=self.jwt_refresh_token_expires_days)

    @property
    def upload_dir_path(self) -> Path:
        """Absolute path to the upload directory; created on first access."""
        candidate = Path(self.upload_dir)
        if not candidate.is_absolute():
            candidate = (BACKEND_ROOT / candidate).resolve()
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate

    @property
    def frontend_dist_path(self) -> Optional[Path]:
        """Resolved absolute path to the frontend dist directory, or None."""
        raw = self.serve_frontend_dist.strip()
        if not raw:
            return None
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = (BACKEND_ROOT / candidate).resolve()
        return candidate

    @field_validator("app_env")
    @classmethod
    def _normalize_env(cls, v: str) -> str:
        return v.lower().strip()


settings = Settings()
