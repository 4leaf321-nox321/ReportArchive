"""커넥터 서비스 — 데이터소스 CRUD + 동기화 실행(run_sync).

핵심: run_sync 은 커넥션 아래 각 스트림마다 fetch_records → build_rows_and_mapping →
**기존 run_import** 으로 수렴한다(온톨로지 쓰기 전부 재사용). 스트림은 나열 순서대로
실행 — 상위 축(공급사)을 먼저 채우면 하위 축(과제)의 관계가 그걸 찾아 링크한다.

시크릿(connection.auth.token/password)은 응답에서 마스킹하고 갱신 시 빈 값이면 보존.
구(舊) 플랫 config(소스=축 1개)는 _normalize_raw 로 새 구조(커넥션+스트림 1개)로 변환.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.connectors.crypto import decrypt_secret, encrypt_secret
from app.modules.connectors.fetch import (
    FetchError,
    build_rows_and_mapping,
    fetch_records,
)
from app.modules.connectors.models import DataSource, SyncRun
from app.modules.connectors.schemas import (
    DataSourceCreate,
    DataSourceRead,
    DataSourceUpdate,
    SourceConfig,
    SyncRunRead,
)
from app.modules.entities.import_service import run_import

_ZERO = {"total": 0, "create": 0, "update": 0, "error": 0,
         "linked": 0, "link_unresolved": 0}


# --- config 정규화(하위호환) + 시크릿 마스킹 --------------------------------
def _normalize_raw(raw: dict | None) -> dict:
    """구 플랫 config({base_url, endpoint_path, target_type_id, ...})를 새 구조
    ({connection:{...}, streams:[{...}]})로 승격. 이미 새 구조면 그대로."""
    raw = raw or {}
    if "streams" in raw or "connection" in raw:
        return raw
    # 구 플랫 → 커넥션 + 스트림 1개.
    stream_keys = ("endpoint_path", "http_method", "query", "records_path",
                   "target_type_id", "match_key", "value_path", "code_path",
                   "property_map", "relation_map")
    stream = {k: raw[k] for k in stream_keys if k in raw}
    return {
        "connection": {
            "base_url": raw.get("base_url", ""),
            "auth": raw.get("auth", {}),
            "headers": raw.get("headers", {}),
        },
        "streams": [stream] if stream else [],
    }


def _parse_config(raw: dict | None) -> SourceConfig:
    return SourceConfig.model_validate(_normalize_raw(raw))


def to_stored_config(cfg: SourceConfig) -> dict:
    """저장용 dict — 커넥션 시크릿을 암호화(평문 저장 금지). 입력 cfg 는 평문."""
    stored = cfg.model_copy(deep=True)
    stored.connection.auth.token = encrypt_secret(stored.connection.auth.token)
    stored.connection.auth.password = encrypt_secret(stored.connection.auth.password)
    return stored.model_dump()


def from_stored_config(raw: dict | None) -> SourceConfig:
    """저장값 → 평문 SourceConfig(시크릿 복호). fetch 실행 직전에만 쓴다."""
    cfg = _parse_config(raw)
    cfg.connection.auth.token = decrypt_secret(cfg.connection.auth.token)
    cfg.connection.auth.password = decrypt_secret(cfg.connection.auth.password)
    return cfg


def _mask(cfg: SourceConfig) -> tuple[SourceConfig, bool]:
    """커넥션 시크릿을 지운 사본 + has_secret 플래그. 원본은 건드리지 않는다."""
    masked = cfg.model_copy(deep=True)
    auth = masked.connection.auth
    has_secret = bool(auth.token or auth.password)
    auth.token = ""
    auth.password = ""
    return masked, has_secret


def to_read(source: DataSource) -> DataSourceRead:
    masked, has_secret = _mask(_parse_config(source.config))
    return DataSourceRead(
        id=source.id,
        name=source.name,
        kind=source.kind,
        enabled=source.enabled,
        config=masked,
        has_secret=has_secret,
        schedule_kind=source.schedule_kind,
        interval_minutes=source.interval_minutes,
        next_run_at=source.next_run_at,
        last_run_at=source.last_run_at,
        last_status=source.last_status,
        created_at=source.created_at,
        updated_at=source.updated_at,
    )


def _preserve_secrets(new_cfg: SourceConfig, old_raw: dict | None) -> SourceConfig:
    """갱신 config 의 커넥션 시크릿이 비었으면(=UI 가 마스킹된 값 그대로 보냄) 기존 보존.
    기존은 복호해 평문으로 되살린다(뒤에서 to_stored_config 가 한 번만 재암호화)."""
    old = from_stored_config(old_raw)
    if not new_cfg.connection.auth.token:
        new_cfg.connection.auth.token = old.connection.auth.token
    if not new_cfg.connection.auth.password:
        new_cfg.connection.auth.password = old.connection.auth.password
    return new_cfg


# --- CRUD --------------------------------------------------------------------
def list_sources(db: Session) -> list[DataSource]:
    return list(db.scalars(select(DataSource).order_by(DataSource.name)).all())


def get_source(db: Session, source_id: int) -> DataSource | None:
    return db.get(DataSource, source_id)


def _next_run_for(schedule_kind: str, interval_minutes: int | None) -> datetime | None:
    """interval 스케줄이면 다음 실행시각(지금 + interval). v2 스케줄러가 스캔."""
    if schedule_kind == "interval" and interval_minutes:
        from datetime import timedelta

        return datetime.now(timezone.utc) + timedelta(minutes=interval_minutes)
    return None


def create_source(db: Session, payload: DataSourceCreate, *, user_id: int) -> DataSource:
    source = DataSource(
        name=payload.name.strip(),
        kind=payload.kind,
        enabled=payload.enabled,
        config=to_stored_config(payload.config),
        schedule_kind=payload.schedule_kind,
        interval_minutes=payload.interval_minutes,
        next_run_at=_next_run_for(payload.schedule_kind, payload.interval_minutes),
        created_by_user_id=user_id,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


def update_source(db: Session, source: DataSource, payload: DataSourceUpdate) -> DataSource:
    if payload.name is not None:
        source.name = payload.name.strip()
    if payload.enabled is not None:
        source.enabled = payload.enabled
    if payload.config is not None:
        merged = _preserve_secrets(payload.config, source.config)
        source.config = to_stored_config(merged)
    if payload.schedule_kind is not None:
        source.schedule_kind = payload.schedule_kind
    if payload.interval_minutes is not None:
        source.interval_minutes = payload.interval_minutes
    if payload.schedule_kind is not None or payload.interval_minutes is not None:
        source.next_run_at = _next_run_for(source.schedule_kind, source.interval_minutes)
    db.commit()
    db.refresh(source)
    return source


def delete_source(db: Session, source: DataSource) -> None:
    db.delete(source)
    db.commit()


# --- 동기화 이력 -------------------------------------------------------------
def list_runs(db: Session, source_id: int, *, limit: int = 20) -> list[SyncRun]:
    return list(
        db.scalars(
            select(SyncRun)
            .where(SyncRun.source_id == source_id)
            .order_by(SyncRun.started_at.desc(), SyncRun.id.desc())
            .limit(limit)
        ).all()
    )


def run_to_read(run: SyncRun) -> SyncRunRead:
    return SyncRunRead(
        id=run.id,
        source_id=run.source_id,
        status=run.status,
        triggered_by=run.triggered_by,
        summary=run.summary,
        error=run.error,
        started_at=run.started_at,
        finished_at=run.finished_at,
    )


def _finish_run(db: Session, run_id: int, source_id: int, *, status: str,
                summary: dict | None = None, error: str | None = None) -> None:
    """이력·소스 상태를 갱신하고 커밋(별도 트랜잭션으로 마무리)."""
    now = datetime.now(timezone.utc)
    run = db.get(SyncRun, run_id)
    if run is not None:
        run.status = status
        run.summary = summary
        run.error = error
        run.finished_at = now
    source = db.get(DataSource, source_id)
    if source is not None:
        source.last_run_at = now
        source.last_status = status
    db.commit()


# --- 핵심: 동기화 실행(스트림 순회) ------------------------------------------
def run_sync(db: Session, source: DataSource, *, dry_run: bool,
             triggered_by: str, user_id: int) -> dict:
    """커넥션의 각 스트림을 순서대로 fetch → rows 변환 → run_import(upsert). dry_run
    이면 검증만(쓰기 없음). 스트림별 결과를 모으고 집계 요약을 함께 돌려준다."""
    cfg = from_stored_config(source.config)  # 시크릿 복호(fetch 직전)

    run_id = None
    if not dry_run:
        run = SyncRun(source_id=source.id, status="running",
                      triggered_by=triggered_by, created_by_user_id=user_id)
        db.add(run)
        db.commit()
        run_id = run.id

    agg = dict(_ZERO)
    stream_results: list[dict] = []
    any_failed = False

    for i, st in enumerate(cfg.streams):
        label = st.label or f"스트림 {i + 1}"
        try:
            records = fetch_records(cfg.connection, st)
            mapping, rows = build_rows_and_mapping(st, records, dry_run=dry_run)
            result = run_import(db, mapping=mapping, rows=rows,
                                creator_user_id=user_id, dry_run=dry_run)
            s = result["summary"]
            for k in _ZERO:
                agg[k] += s.get(k, 0)
            stream_results.append({
                "label": label,
                "target_type_id": st.target_type_id,
                "summary": s,
                "error_rows": [r for r in result["rows"] if r["status"] == "error"][:20],
            })
        except (FetchError, ValueError) as exc:
            db.rollback()
            any_failed = True
            stream_results.append({
                "label": label,
                "target_type_id": st.target_type_id,
                "error": str(exc)[:500],
            })

    agg["committed"] = not dry_run
    agg["streams"] = len(cfg.streams)
    out = {"summary": agg, "streams": stream_results}

    if run_id is not None:
        _finish_run(db, run_id, source.id,
                    status=("failed" if any_failed else "done"),
                    summary={**agg, "stream_results": stream_results})
    return out


# --- probe(스트림 단위 샘플) -------------------------------------------------
def probe_stream(connection, stream) -> dict:
    """저장 전 매핑 UI 용 — 커넥션+스트림으로 응답을 받아 레코드 샘플·필드명 반환."""
    records = fetch_records(connection, stream)
    sample = records[:5]
    fields = sorted(sample[0].keys()) if sample else []
    return {"record_count": len(records), "fields": fields, "sample": sample}
