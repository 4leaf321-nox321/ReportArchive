"""외부 fetch + JSON→rows 변환.

외부에서 받은 중첩 JSON 을 "엑셀 붙여넣기 한 것과 똑같은 평평한 rows"로 바꾸는 어댑터.
그 뒤 온톨로지 쓰기는 기존 import_service.run_import 이 그대로 처리한다(신규 로직 0).

fetch 는 커넥션(base_url·인증)과 스트림(엔드포인트·records_path·매핑)을 함께 받는다 —
한 커넥션 아래 여러 스트림이 접속을 공유한다.

주의(SSRF): 이 커넥터는 사내 시스템(사설 IP)도 대상이라 shared/url_fetch 의 '공인 IP만'
가드를 적용하지 않는다 — 대신 http/https 스킴만 강제. 관리자 전용 등록으로 완화하며,
호스트 allowlist·egress 방화벽은 운영 보강(설계 v3).
"""
from __future__ import annotations

from urllib.parse import urljoin, urlparse

import httpx

from app.modules.connectors.schemas import ConnectionConfig, StreamConfig
from app.modules.entities.schemas import EntityImportMapping, ImportRelationCol

# 한 번에 가져올 레코드 상한(과도 응답 방지) — run_import 의 _MAX_ROWS 와 정렬.
_MAX_RECORDS = 2000
_TIMEOUT = 30.0


class FetchError(Exception):
    """외부 fetch 실패 — 호출부에서 400/이력 오류로 변환."""


def _dig(obj, path: str):
    """점 표기 경로로 중첩 JSON 을 판다. 배열 인덱스 지원(a.0.b). 경로가 비었거나
    '$' 면 obj 자체. 없으면 None."""
    p = (path or "").strip().lstrip("$").lstrip(".")
    if not p:
        return obj
    cur = obj
    for seg in p.split("."):
        if cur is None:
            return None
        if isinstance(cur, list):
            if not seg.isdigit():
                return None
            idx = int(seg)
            cur = cur[idx] if 0 <= idx < len(cur) else None
        elif isinstance(cur, dict):
            cur = cur.get(seg)
        else:
            return None
    return cur


def _cell(value) -> str:
    """레코드 필드값 → run_import 이 먹는 문자열 셀. dict/list 는 무시(빈 문자열)."""
    if value is None or isinstance(value, (dict, list)):
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def _auth_kwargs(conn: ConnectionConfig) -> tuple[dict, object | None]:
    """커넥션 auth → (headers, httpx auth). 헤더/기본인증으로 분기."""
    headers: dict[str, str] = dict(conn.headers or {})
    auth = conn.auth
    basic = None
    if auth.type == "bearer" and auth.token:
        headers["Authorization"] = f"Bearer {auth.token}"
    elif auth.type == "api_key" and auth.token:
        headers[auth.header or "X-API-Key"] = auth.token
    elif auth.type == "basic" and (auth.username or auth.password):
        basic = httpx.BasicAuth(auth.username, auth.password)
    return headers, basic


def fetch_records(conn: ConnectionConfig, stream: StreamConfig) -> list[dict]:
    """커넥션+스트림으로 외부 API 호출 → 레코드(dict) 목록. records_path 로 배열 추출."""
    base = (conn.base_url or "").strip()
    if not base:
        raise FetchError("base_url 이 비었습니다.")
    url = urljoin(base if base.endswith("/") else base + "/",
                  (stream.endpoint_path or "").lstrip("/"))
    if urlparse(url).scheme not in ("http", "https"):
        raise FetchError("http/https URL 만 허용됩니다.")

    headers, basic = _auth_kwargs(conn)
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True) as client:
            resp = client.request(
                stream.http_method or "GET",
                url,
                headers=headers,
                params=stream.query or None,
                auth=basic,
            )
    except httpx.HTTPError as exc:
        raise FetchError(f"요청 실패: {exc}") from exc
    if resp.status_code >= 400:
        raise FetchError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise FetchError(f"JSON 파싱 실패: {exc}") from exc

    records = _dig(payload, stream.records_path)
    if isinstance(records, dict):
        # 단건 객체를 준 경우 1건 배열로 관대 처리.
        records = [records]
    if not isinstance(records, list):
        raise FetchError(
            f"records_path('{stream.records_path}')가 배열이 아닙니다. "
            "응답에서 레코드 배열의 위치를 점 표기로 지정하세요."
        )
    if len(records) > _MAX_RECORDS:
        raise FetchError(
            f"레코드가 너무 많습니다({len(records)}). 최대 {_MAX_RECORDS}건. "
            "증분(watermark)·페이지네이션은 후속(v3)입니다."
        )
    return [r for r in records if isinstance(r, dict)]


def build_rows_and_mapping(
    stream: StreamConfig, records: list[dict], *, dry_run: bool
) -> tuple[EntityImportMapping, list[dict]]:
    """레코드 목록 → (run_import 매핑, 평평한 rows). 각 레코드를 합성 헤더로 dict 화
    (__value__ / __p_<slug> / __r_<i>)하고 매핑이 그 헤더를 가리킨다."""
    property_columns: dict[str, str] = {}
    for slug in stream.property_map:
        property_columns[f"__p_{slug}"] = slug
    relation_columns = [
        ImportRelationCol(
            column=f"__r_{i}", relation=rm.relation, target_type=rm.target_type
        )
        for i, rm in enumerate(stream.relation_map)
    ]
    # 코드 매칭(안정 식별자) — match_key='code' + code_path 있으면 코드 열을 실어보낸다.
    code_column = "__code__" if (stream.match_key == "code" and stream.code_path) else None

    rows: list[dict] = []
    for rec in records:
        row = {"__value__": _cell(_dig(rec, stream.value_path))}
        if code_column:
            row["__code__"] = _cell(_dig(rec, stream.code_path))
        for slug, path in stream.property_map.items():
            row[f"__p_{slug}"] = _cell(_dig(rec, path))
        for i, rm in enumerate(stream.relation_map):
            row[f"__r_{i}"] = _cell(_dig(rec, rm.path))
        rows.append(row)

    mapping = EntityImportMapping(
        type_id=stream.target_type_id,
        value_column="__value__",
        property_columns=property_columns,
        relation_columns=relation_columns,
        code_column=code_column,
        dry_run=dry_run,
    )
    return mapping, rows
