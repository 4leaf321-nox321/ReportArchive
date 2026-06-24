"""Admin services — system-level visibility (storage, etc.).

Routes under this module are gated to admins only; the data they expose
(host paths, disk usage, per-workspace footprint) shouldn't leak to
regular users.
"""
from __future__ import annotations

import os
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import engine
from app.modules.files.models import File
from app.modules.reports.models import Report
from app.modules.workspaces.models import Workspace
from app.shared.runtime_tuning import LIMITS as TUNING_LIMITS
from app.shared.runtime_tuning import get_int as tuning_get_int
from app.shared.storage import SAFETY_MARGIN_BYTES, disk_usage

# CPU 모델·물리 socket 수는 런타임에 바뀌지 않으니 lazy cache. /proc
# 파싱은 약 1ms 수준이라 캐시 없어도 큰 비용은 아니지만, 페이지를
# 자주 새로고침해도 같은 값을 다시 읽으니 깔끔.
_CPU_MODEL_CACHE: str | None = None
_CPU_SOCKETS_CACHE: int | None = None


def _read_proc(path: str) -> str:
    """Best-effort /proc read. Non-Linux 환경(개발 macOS 등) 에선 빈 문자열."""
    try:
        return Path(path).read_text()
    except OSError:
        return ""


def _cpu_info() -> dict:
    """CPU 모델·코어 수·load average. Linux /proc/cpuinfo + /proc/loadavg 사용."""
    global _CPU_MODEL_CACHE, _CPU_SOCKETS_CACHE
    if _CPU_MODEL_CACHE is None:
        text = _read_proc("/proc/cpuinfo")
        model: str | None = None
        physical_ids: set[str] = set()
        for line in text.splitlines():
            if model is None and line.startswith("model name"):
                _, _, val = line.partition(":")
                model = val.strip()
            elif line.startswith("physical id"):
                _, _, val = line.partition(":")
                physical_ids.add(val.strip())
        # ARM / 일부 가상화 환경엔 "model name" 이 없어 platform.processor() 폴백.
        _CPU_MODEL_CACHE = model or platform.processor() or "unknown"
        _CPU_SOCKETS_CACHE = len(physical_ids) or None

    load_avg = (0.0, 0.0, 0.0)
    try:
        load_avg = os.getloadavg()
    except (AttributeError, OSError):
        pass

    return {
        "model": _CPU_MODEL_CACHE,
        "physical_sockets": _CPU_SOCKETS_CACHE,
        "logical_cpus": os.cpu_count(),
        "load_avg_1m": round(load_avg[0], 2),
        "load_avg_5m": round(load_avg[1], 2),
        "load_avg_15m": round(load_avg[2], 2),
    }


def _memory_info() -> dict:
    """전체/사용가능/사용 메모리. /proc/meminfo 의 MemTotal / MemAvailable 기반.

    MemAvailable 은 커널 3.14+ 이 노출하는 "실용적인 free" — Page cache 와
    reclaimable slab 까지 고려한 값이라 호스트가 "이만큼은 즉시 새 프로세스
    할당에 줄 수 있다" 의 진짜 수치. 옛날 환경 fallback 으로 MemFree.
    """
    text = _read_proc("/proc/meminfo")
    info: dict[str, int] = {}
    for line in text.splitlines():
        m = re.match(r"^(\w+):\s+(\d+)\s+kB", line)
        if m:
            info[m.group(1)] = int(m.group(2)) * 1024
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", info.get("MemFree", 0))
    used = total - available if total else 0
    return {
        "total_bytes": total,
        "available_bytes": available,
        "used_bytes": used,
        "percent_used": round(used * 100 / total, 1) if total else 0.0,
    }


def _host_info() -> dict:
    """OS · 커널 · 호스트네임 · 부팅 후 경과 시간."""
    uptime_seconds = 0
    text = _read_proc("/proc/uptime")
    if text:
        try:
            uptime_seconds = int(float(text.split()[0]))
        except (ValueError, IndexError):
            pass
    return {
        "hostname": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "kernel": platform.version(),
        "arch": platform.machine(),
        "uptime_seconds": uptime_seconds,
    }


def _process_info() -> dict:
    """이 uvicorn worker 프로세스 자체 footprint."""
    pid = os.getpid()
    rss_kb = 0
    text = _read_proc(f"/proc/{pid}/status")
    for line in text.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2:
                try:
                    rss_kb = int(parts[1])
                except ValueError:
                    pass
            break
    return {
        "pid": pid,
        "rss_bytes": rss_kb * 1024,
        "python_version": sys.version.split()[0],
    }


def _database_info(db: Session) -> dict:
    """PostgreSQL 서버 버전 + SQLAlchemy connection pool 현재 사용량."""
    version_str = "unknown"
    try:
        # SHOW server_version_num + server_version 둘 다 가능. 사람이
        # 읽기 좋은 server_version ("16.3") 쪽 사용.
        version_str = (
            db.execute(select(func.current_setting("server_version"))).scalar()
            or "unknown"
        )
    except Exception:  # noqa: BLE001 — DB 가 죽어 있어도 페이지 자체는 떠야 함
        pass

    pool = engine.pool
    pool_data: dict = {}
    # 모든 pool 클래스가 size/checkedout 을 노출하진 않음(예: NullPool).
    # 안전하게 getattr.
    for attr in ("size", "checkedout", "checkedin", "overflow"):
        fn = getattr(pool, attr, None)
        if callable(fn):
            try:
                pool_data[attr] = fn()
            except Exception:  # noqa: BLE001
                pass
    return {
        "version": version_str,
        "pool": pool_data,
    }


def get_server_info(db: Session) -> dict:
    """OS · CPU · 메모리 · 런타임 · DB 한 페이로드. 관리자만 호출."""
    return {
        "host": _host_info(),
        "cpu": _cpu_info(),
        "memory": _memory_info(),
        "process": _process_info(),
        "runtime": {
            "uvicorn_workers": tuning_get_int("uvicorn_workers"),
            "app_env": os.environ.get("APP_ENV", "development"),
            "serve_frontend_dist": bool(
                os.environ.get("SERVE_FRONTEND_DIST", "").strip()
            ),
        },
        "database": _database_info(db),
    }


# --- Runtime tuning ---------------------------------------------------- #
#
# 관리자-서버 UI 에서 편집 가능한 키들. 값은 runtime_settings 테이블에
# 저장되고, 워커가 다음 부팅 시 읽는다. 실시간 hot-reload 가 아니라
# 운영자가 `systemctl restart` 를 명시적으로 실행해야 적용 — UI 에
# "재시작 필요" 배지를 띄워 표시한다.

_TUNABLE_KEYS = ("uvicorn_workers", "db_pool_size", "db_max_overflow")


def get_runtime_tuning(db: Session) -> dict:
    """저장된 (= 다음 재시작 시 적용될) 값과 현재 실행중 (= 이 워커가
    부팅 시 읽었던) 값을 함께 반환. UI 가 둘을 비교해서 mismatch 시
    "재시작 필요" 표시.

    runtime_settings 테이블이 아직 없는 경우(첫 배포에서 마이그레이션
    안 돈 시점) 라도 500 으로 죽지 않고 effective-만-노출 모드로
    fallback. 응답에 `migration_required: true` 플래그를 실어 UI 가
    안내를 띄울 수 있게 한다.
    """
    migration_required = False
    rows = []
    try:
        # 키들은 모듈 상수라 SQL injection 위험 없음 — 그대로 인라인.
        rows = db.execute(
            text(
                "SELECT key, value, updated_at, updated_by_user_id "
                "FROM runtime_settings "
                "WHERE key IN ('uvicorn_workers', 'db_pool_size', 'db_max_overflow')"
            ),
        ).all()
    except Exception:  # noqa: BLE001
        # 테이블 없음 / 일시적 DB 오류 모두 graceful. 세션은 invalidate
        # 상태이므로 rollback 후 빈 stored 로 진행.
        db.rollback()
        migration_required = True

    stored: dict[str, dict] = {}
    for key, value, updated_at, updated_by in rows:
        stored[key] = {
            "value": value,
            "updated_at": updated_at.isoformat() if updated_at else None,
            "updated_by_user_id": updated_by,
        }

    pool = engine.pool
    effective_pool_size = None
    effective_max_overflow = None
    try:
        # SQLAlchemy QueuePool 의 size() 는 *설정된* pool_size 를 반환
        # (= 현재 활성 connection 수가 아님 — 그건 checkedout()).
        if callable(getattr(pool, "size", None)):
            effective_pool_size = pool.size()
        # max_overflow 는 내부 attr — public API 없음. getattr fallback.
        effective_max_overflow = getattr(pool, "_max_overflow", None)
    except Exception:  # noqa: BLE001
        pass

    effective = {
        "uvicorn_workers": tuning_get_int("uvicorn_workers"),
        "db_pool_size": effective_pool_size,
        "db_max_overflow": effective_max_overflow,
    }

    limits = {key: {"min": lo, "max": hi} for key, (lo, hi) in TUNING_LIMITS.items()}

    settings_out: dict = {}
    for key in _TUNABLE_KEYS:
        meta = stored.get(key) or {}
        stored_int: int | None = None
        if meta.get("value") is not None:
            try:
                stored_int = int(meta["value"])
            except (TypeError, ValueError):
                stored_int = None
        settings_out[key] = {
            "stored": stored_int,
            "effective": effective.get(key),
            "limits": limits.get(key),
            "updated_at": meta.get("updated_at"),
            "updated_by_user_id": meta.get("updated_by_user_id"),
            "restart_required": (
                stored_int is not None
                and effective.get(key) is not None
                and stored_int != effective.get(key)
            ),
        }
    # UI 가 안내 박스를 띄울 수 있도록 migration 플래그를 함께 포함.
    settings_out["__meta__"] = {"migration_required": migration_required}
    return settings_out


def set_runtime_tuning(
    db: Session, *, key: str, value: int, user_id: int | None
) -> dict:
    """Upsert 한 항목. 알 수 없는 key 또는 범위 밖이면 ValueError."""
    if key not in _TUNABLE_KEYS:
        raise ValueError(f"알 수 없는 튜닝 키: {key}")
    lo, hi = TUNING_LIMITS.get(key, (0, 1_000_000))
    if not isinstance(value, int) or value < lo or value > hi:
        raise ValueError(f"{key}는 {lo}~{hi} 사이 정수여야 합니다.")

    try:
        db.execute(
            text(
                "INSERT INTO runtime_settings (key, value, updated_at, updated_by_user_id) "
                "VALUES (:key, :value, :now, :user_id) "
                "ON CONFLICT (key) DO UPDATE SET "
                "value = EXCLUDED.value, "
                "updated_at = EXCLUDED.updated_at, "
                "updated_by_user_id = EXCLUDED.updated_by_user_id"
            ),
            {
                "key": key,
                "value": str(value),
                "now": datetime.now(timezone.utc),
                "user_id": user_id,
            },
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        # 사용자한테 마이그레이션을 안내. 라우트 단의 HTTPException 에서
        # 그대로 메시지 전달.
        raise ValueError(
            "저장 실패. runtime_settings 테이블이 아직 없을 수 있습니다 — "
            "백엔드에서 `alembic upgrade head` 실행 후 다시 시도하세요. "
            f"(원인: {type(e).__name__})"
        ) from e
    return get_runtime_tuning(db)


def get_storage_stats(db: Session) -> dict:
    """Snapshot the upload partition + the app's footprint inside it.

    Two distinct numbers that are easy to confuse:
      - `partition.*`  — the WHOLE filesystem backing upload_dir_path;
        what `df` would show. Drives the upload guard.
      - `upload_dir.*` — the bytes accounted to ReportArchive (SUM of
        files.size). Tells the operator what THIS app contributes,
        independent of other tenants on the same partition.
    """
    upload_path = settings.upload_dir_path
    total, used, free = disk_usage()

    app_size = (
        db.execute(select(func.coalesce(func.sum(File.size), 0))).scalar() or 0
    )
    app_count = db.execute(select(func.count(File.id))).scalar() or 0

    # Workspace breakdown — join in display name so the admin UI doesn't
    # need a second round-trip to translate slugs back to labels.
    rows = db.execute(
        select(
            File.workspace_slug,
            Workspace.name,
            func.coalesce(func.sum(File.size), 0).label("size_bytes"),
            func.count(File.id).label("file_count"),
        )
        .join(Workspace, Workspace.slug == File.workspace_slug, isouter=True)
        .group_by(File.workspace_slug, Workspace.name)
        .order_by(func.sum(File.size).desc())
    ).all()

    # Report count per workspace — soft-deleted(휴지통) 제외. 파일 집계와
    # 별도 테이블이라 슬러그 → 개수 맵으로 뽑아 아래에서 병합. 파일이 0인
    # 부서는 위 file-기준 rows 에 안 잡혀 표에 안 나오지만, 이 표 자체가
    # 저장공간(footprint) 중심이라 그 동작을 그대로 유지한다.
    report_rows = db.execute(
        select(
            Report.workspace_slug,
            func.count(Report.id).label("report_count"),
        )
        .where(Report.deleted_at.is_(None))
        .group_by(Report.workspace_slug)
    ).all()
    report_count_by_slug = {slug: int(count) for slug, count in report_rows}

    return {
        "partition": {
            "path": str(upload_path),
            "total_bytes": int(total),
            "used_bytes": int(used),
            "free_bytes": int(free),
            "percent_used": round(used * 100 / total, 2) if total else 0.0,
        },
        "upload_dir": {
            "path": str(upload_path),
            "size_bytes": int(app_size),
            "file_count": int(app_count),
        },
        "by_workspace": [
            {
                "workspace_slug": slug,
                "workspace_name": name,
                "size_bytes": int(size),
                "file_count": int(count),
                "report_count": report_count_by_slug.get(slug, 0),
            }
            for slug, name, size, count in rows
        ],
        "safety_margin_bytes": SAFETY_MARGIN_BYTES,
        "upload_max_bytes": settings.upload_max_bytes,
    }
