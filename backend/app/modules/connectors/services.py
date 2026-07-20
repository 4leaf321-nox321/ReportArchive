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
    _dig,
    build_rows_and_mapping,
    fetch_offset_backfill,
    fetch_records,
)
from app.modules.connectors.models import DataSource, SyncRun
from app.modules.connectors.provenance import record_provenance
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


def _max_watermark(records: list[dict], field: str) -> str | None:
    """레코드들의 watermark_field 값 중 최댓값(문자열 비교 — ISO 타임스탬프·증가 id 가정).
    다음 동기화의 since 로 쓴다."""
    vals = []
    for r in records:
        v = _dig(r, field)
        if v is not None and str(v).strip():
            vals.append(str(v).strip())
    return max(vals) if vals else None


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
        sync_state=source.sync_state or {},
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
             triggered_by: str, user_id: int,
             stream_index: int | None = None) -> dict:
    """커넥션의 각 스트림을 순서대로 fetch → rows 변환 → run_import(upsert). dry_run
    이면 검증만(쓰기 없음). 스트림별 결과를 모으고 집계 요약을 함께 돌려준다.

    stream_index 를 주면 그 인덱스의 스트림 하나만 실행한다(나머지는 건너뜀) — 큰
    소스에서 문제 스트림만 재시도하거나 초기 백필을 스트림별로 나눠 돌릴 때 쓴다.
    watermark·계보 갱신은 실행한 스트림에만 적용되니 증분 상태도 그대로 유지된다."""
    cfg = from_stored_config(source.config)  # 시크릿 복호(fetch 직전)

    if stream_index is not None and not (0 <= stream_index < len(cfg.streams)):
        raise ValueError(
            f"스트림 인덱스({stream_index})가 범위를 벗어났습니다. "
            f"이 소스의 스트림은 {len(cfg.streams)}개입니다."
        )

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
        if stream_index is not None and i != stream_index:
            continue
        label = st.label or f"스트림 {i + 1}"
        state = source.sync_state or {}
        off_key, done_key = f"{i}:backfill_offset", f"{i}:backfill_done"
        # 백필 모드 판정 — backfill 켜졌고 아직 끝(done)이 아니면 오프셋 창 방식.
        # dry_run(미리보기)도 현재 오프셋 기준으로 "다음에 받을 창"을 보여준다.
        backfilling = st.backfill and (dry_run or state.get(done_key) != "1")
        try:
            backfill_meta = None
            if backfilling:
                start = int(state.get(off_key) or 0)
                records, next_off, done = fetch_offset_backfill(
                    cfg.connection, st, start_offset=start,
                    window=st.backfill_window or None,
                )
                backfill_meta = {"from": start, "to": next_off, "done": done}
            elif st.backfill and not st.incremental and not dry_run:
                # 백필 완료 + 증분 미설정 → 더 받을 것 없음. 전체 재조회(상한 초과) 회피.
                records = []
                backfill_meta = {"done": True, "idle": True}
            else:
                # 증분 — 마지막 watermark 이후 변경분만(dry_run 은 전체, 미리보기라).
                since = state.get(str(i)) if (st.incremental and not dry_run) else None
                records = fetch_records(cfg.connection, st, since=since)
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
                "backfill": backfill_meta,
                "error_rows": [r for r in result["rows"] if r["status"] == "error"][:20],
            })
            # 계보 — 이번에 채운 객체에 출처(소스·run) 태깅.
            if not dry_run:
                eids = [r["entity_id"] for r in result["rows"] if r.get("entity_id")]
                record_provenance(db, entity_ids=eids,
                                  data_source_id=source.id, sync_run_id=run_id)
            # 런타임 상태 전진 — 백필 오프셋 + watermark 를 스트림별 즉시 커밋(뒤 스트림
            # 실패에도 진행분 보존). watermark 는 백필 중에도 최댓값을 계속 올려둬,
            # 백필 완료 후 첫 증분 실행이 전체 재조회 없이 since 를 이어받게 한다.
            if not dry_run:
                new_state = dict(source.sync_state or {})
                if backfill_meta and not backfill_meta.get("idle"):
                    new_state[off_key] = str(backfill_meta["to"])
                    if backfill_meta["done"]:
                        new_state[done_key] = "1"
                if st.incremental and st.watermark_field:
                    new_wm = _max_watermark(records, st.watermark_field)
                    if new_wm:
                        new_state[str(i)] = new_wm
                if new_state != (source.sync_state or {}):
                    source.sync_state = new_state
                    db.commit()
        except (FetchError, ValueError) as exc:
            db.rollback()
            any_failed = True
            stream_results.append({
                "label": label,
                "target_type_id": st.target_type_id,
                "error": str(exc)[:500],
            })

    agg["committed"] = not dry_run
    agg["streams"] = len(stream_results)  # 실제 실행한 스트림 수(단일 실행이면 1)
    out = {"summary": agg, "streams": stream_results}

    if run_id is not None:
        _finish_run(db, run_id, source.id,
                    status=("failed" if any_failed else "done"),
                    summary={**agg, "stream_results": stream_results})
    return out


def reset_backfill(db: Session, source: DataSource,
                   stream_index: int | None = None) -> None:
    """백필 진행 상태(오프셋·done)를 초기화 — 처음(offset 0)부터 다시 받게 한다.
    orderby 를 잘못 걸어 창 경계가 어긋났거나, 소스를 통째로 재적재할 때. watermark
    커서(str(i))는 건드리지 않는다. stream_index 를 주면 그 스트림만."""
    state = dict(source.sync_state or {})
    prefixes = (
        [f"{stream_index}:"] if stream_index is not None
        else None
    )

    def _is_backfill_key(k: str) -> bool:
        return k.endswith(":backfill_offset") or k.endswith(":backfill_done")

    for k in list(state.keys()):
        if not _is_backfill_key(k):
            continue
        if prefixes and not any(k.startswith(p) for p in prefixes):
            continue
        del state[k]
    source.sync_state = state
    db.commit()


def maybe_alert_sync_failure(
    db: Session, source: DataSource, result: dict, *, prior_status: str | None
) -> bool:
    """주기 동기화가 실패했고 **직전엔 실패가 아니었으면**(실패 전이) 소스 소유자에게
    메일로 알린다 — 분당 스팸 방지(지속 실패는 재알림 안 함). 메일러가 켜져 있을 때만.
    반환: 알림을 보냈으면 True. 커밋은 호출자."""
    if prior_status == "failed":
        return False
    failed = [s for s in result.get("streams", []) if s.get("error")]
    if not failed:
        return False

    from app.mailer import service as mailer
    from app.modules.users.models import User

    if not mailer.is_active():
        return False
    owner = db.get(User, source.created_by_user_id) if source.created_by_user_id else None
    if owner is None or not getattr(owner, "email", None):
        return False

    lines = "\n".join(f"- {s['label']}: {s['error']}" for s in failed)
    mailer.enqueue_email(
        db,
        to=owner.email,
        subject=f"[커넥터] '{source.name}' 동기화 실패 ({len(failed)}개 스트림)",
        text=(
            f"데이터소스 '{source.name}'의 주기 동기화에서 {len(failed)}개 스트림이 "
            f"실패했습니다.\n\n{lines}\n\n관리자 → 외부 시스템 연계에서 확인하세요."
        ),
        dedup_key=f"connsyncfail:{source.id}",
    )
    return True


# --- probe(스트림 단위 샘플) -------------------------------------------------
_PROBE_SAMPLE = 5        # 화면에 그대로 보여줄 원본 레코드 수(응답 크기 억제).
_PROBE_SCAN = 500        # 경로 수집용 스캔 상한. 앞쪽이 전부 null 인 navigation 을
                         # 놓치지 않을 만큼 넓게, 큰 응답에서 CPU 를 안 태울 만큼 좁게.


def _flatten_paths(obj, prefix: str = "", out: set[str] | None = None) -> set[str]:
    """레코드 하나를 점표기 leaf 경로 집합으로 평탄화(name, product.ProductCode …).

    배열은 첫 원소만 파고들며 인덱스를 경로에 남긴다(product.0.ProductCode) —
    build_rows_and_mapping 의 _dig 가 읽는 표기와 같아야 한다.
    """
    if out is None:
        out = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            _flatten_paths(v, f"{prefix}.{k}" if prefix else str(k), out)
    elif isinstance(obj, list):
        if obj:
            _flatten_paths(obj[0], f"{prefix}.0", out)
        elif prefix:
            out.add(prefix)
    elif prefix:
        out.add(prefix)
    return out


def probe_stream(connection, stream) -> dict:
    """저장 전 매핑 UI 용 — 커넥션+스트림으로 응답을 받아 레코드 샘플·필드 경로 반환.

    필드 경로는 **샘플이 아니라 받아온 레코드 전체**(스캔 상한까지)에서 모은다.
    $expand 된 navigation 은 앞쪽 레코드에서 null 인 경우가 흔해서(SPDM 의 product
    등), 화면에 보여줄 5건만 훑으면 그 하위 경로가 자동완성에서 통째로 빠진다 —
    fetch 는 이미 전체를 받아왔으므로 여기서 훑는 게 공짜에 가깝다.
    """
    records = fetch_records(connection, stream)
    sample = records[:_PROBE_SAMPLE]
    paths: set[str] = set()
    for r in records[:_PROBE_SCAN]:
        if isinstance(r, dict):
            paths |= _flatten_paths(r)
    # 중간 노드 제거 — product 가 어떤 레코드에서 null 이면 leaf 로 잡혀 'product' 가
    # 들어오는데, 다른 레코드에서 product.ProductCode 가 나왔다면 'product' 는 객체를
    # 가리키는 경로다. 속성 칸에 넣어도 값이 안 나오니 제안하지 않는다.
    fields = sorted(
        p for p in paths if not any(q.startswith(f"{p}.") for q in paths)
    )
    return {
        "record_count": len(records),
        "fields": fields,
        "sample": sample,
        "scanned": min(len(records), _PROBE_SCAN),
    }
