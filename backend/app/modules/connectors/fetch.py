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

import json
import logging
from urllib.parse import quote, urlencode, urljoin, urlparse

import httpx

from app.config import settings
from app.modules.connectors.schemas import ConnectionConfig, StreamConfig
from app.modules.entities.schemas import EntityImportMapping, ImportRelationCol

# 한 번에 가져올 레코드 상한(과도 응답 방지) — run_import 의 _MAX_ROWS 와 정렬.
_MAX_RECORDS = 20000  # 총 레코드 상한(페이지네이션 포함). 초과 시 증분 유도.
_MAX_PAGES = 500      # 페이지 루프 runaway 가드.
_TIMEOUT = 30.0

logger = logging.getLogger(__name__)


class FetchError(Exception):
    """외부 fetch 실패 — 호출부에서 400/이력 오류로 변환."""


def _dig(obj, path: str):
    """점 표기 경로로 중첩 JSON 을 판다. 배열 인덱스 지원(a.0.b). 경로가 비었거나
    '$' 면 obj 자체. 없으면 None."""
    p = (path or "").strip().lstrip("$").lstrip(".")
    if not p:
        return obj
    # 리터럴 전체 키 우선 — 키 자체에 '.'이 든 경우(OData @odata.nextLink 등)를 처리.
    if isinstance(obj, dict) and p in obj:
        return obj[p]
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


def _loads_concatenated(text: str) -> list:
    """이어붙은 다중 JSON 문서를 앞에서부터 모두 파싱(관대). 일부 서버는 한 응답에
    JSON 문서를 두 개 이상 이어붙여 주는데(→ json.loads 는 'Extra data' 로 실패),
    raw_decode 로 문서를 하나씩 떼어내고 사이 공백은 건너뛴다. JSON 이 아닌 잔여물
    (오염·HTML 등)을 만나면 거기서 멈추고 그때까지 파싱한 문서들만 돌려준다."""
    dec = json.JSONDecoder()
    idx, n, docs = 0, len(text), []
    while idx < n:
        while idx < n and text[idx].isspace():
            idx += 1
        if idx >= n:
            break
        try:
            obj, end = dec.raw_decode(text, idx)
        except ValueError:
            break
        docs.append(obj)
        idx = end
    return docs


def _merge_docs(docs: list):
    """이어붙은 문서들을 하나로 병합 — 리스트 값(예: OData `value`)은 이어붙이고,
    스칼라/기타는 마지막 값이 이긴다(@odata.nextLink 등). 이러면 두 조각으로 쪼개
    온 레코드 배열도 손실 없이 합쳐진다. 첫 문서가 dict 가 아니면 그대로 반환."""
    if len(docs) == 1 or not isinstance(docs[0], dict):
        return docs[0]
    merged = dict(docs[0])
    for d in docs[1:]:
        if not isinstance(d, dict):
            continue
        for k, v in d.items():
            if isinstance(v, list) and isinstance(merged.get(k), list):
                merged[k] = merged[k] + v  # 배열 이어붙임(새 리스트 — 원본 불변)
            else:
                merged[k] = v
    return merged


# OData 시스템 쿼리 옵션은 $ ( ) = , : ' / 같은 문자를 리터럴로 써야 하는데
# ($expand=product($select=ProjectCode) 등) httpx 의 기본 params 인코딩은 이들을
# 퍼센트 인코딩(%24 %28 %3D…)해 일부 커스텀 OData 서버가 거부한다. 그래서 params 를
# 직접 이 문자들을 보존한 쿼리스트링으로 만들어 URL 에 붙이고 httpx params 는 쓰지
# 않는다. 공백·& 등 진짜 위험한 문자는 여전히 인코딩된다.
_ODATA_SAFE = "$(),=:'/*"


def _apply_query(url: str, params: dict) -> str:
    """params 를 OData 안전 문자를 보존한 채 url 에 덧붙인다(httpx params 대체)."""
    if not params:
        return url
    qs = urlencode(params, quote_via=quote, safe=_ODATA_SAFE)
    sep = "&" if urlparse(url).query else "?"
    return url + sep + qs


def _parse_body(text: str):
    """응답 본문 → (payload, error_msg|None). 정상 단일 JSON 이면 (그대로, None).
    이어붙은 다중 문서면 데이터 문서들은 병합하고, 트레일링 OData 오류 객체
    ({"error":{...}})가 있으면 그 메시지를 error_msg 로 함께 돌려준다(부분 데이터 +
    오류 신호). 파싱 자체가 불가하면 FetchError."""
    try:
        return json.loads(text), None
    except ValueError:
        docs = _loads_concatenated(text)
        if not docs:
            raise FetchError(f"JSON 파싱 실패: {text[:200]}") from None
        err_msg = None
        data_docs = []
        for d in docs:
            if isinstance(d, dict) and isinstance(d.get("error"), dict):
                e = d["error"]
                err_msg = e.get("message") or e.get("code") or "OData error"
            else:
                data_docs.append(d)
        payload = _merge_docs(data_docs) if data_docs else {}
        return payload, err_msg


def _request_json_partial(client, method, url, headers, params, basic):
    """HTTP 요청 → (payload, error_msg|None). 서버가 응답 도중 오류를 붙여 보내도
    받은 부분 데이터와 오류를 함께 돌려준다(자동 스킵용). 쿼리는 _apply_query 로
    URL 에 직접 붙인다(OData 특수문자 리터럴 보존)."""
    full_url = _apply_query(url, params or {})
    try:
        resp = client.request(method or "GET", full_url, headers=headers,
                              auth=basic)
    except httpx.HTTPError as exc:
        raise FetchError(f"요청 실패: {exc}") from exc
    if resp.status_code >= 400:
        raise FetchError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    return _parse_body(resp.text)


def _request_json(client, method, url, headers, params, basic):
    """단일 HTTP 요청 → 파싱된 JSON. 트레일링 OData 오류가 있으면(부분 데이터+오류)
    부분 데이터를 조용히 삼키지 않고 그 오류를 surface 한다(FetchError)."""
    payload, err = _request_json_partial(client, method, url, headers, params, basic)
    if err:
        raise FetchError(
            f"서버가 응답 도중 오류를 반환했습니다(데이터 불완전): {err}"
        ) from None
    return payload


def _extract_records(payload, records_path: str) -> list[dict]:
    """응답에서 records_path 로 레코드 배열 추출(단건 dict 는 1건 배열로 관대 처리)."""
    records = _dig(payload, records_path)
    if isinstance(records, dict):
        records = [records]
    if not isinstance(records, list):
        raise FetchError(
            f"records_path('{records_path}')가 배열이 아닙니다. "
            "응답에서 레코드 배열의 위치를 점 표기로 지정하세요."
        )
    return [r for r in records if isinstance(r, dict)]


def _guard_total(n: int) -> None:
    if n > _MAX_RECORDS:
        raise FetchError(
            f"레코드가 상한({_MAX_RECORDS})을 초과했습니다. 증분 동기화(watermark)를 "
            "설정하거나 대상 범위를 좁히세요."
        )


def _check_outbound(url: str) -> None:
    """스킴(http/https) + SSRF allowlist 검증. 매 요청 URL(nextLink 포함)마다 호출."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise FetchError("http/https URL 만 허용됩니다.")
    allow = [
        h.strip().lower()
        for h in (settings.connector_allowed_hosts or "").split(",")
        if h.strip()
    ]
    if allow and (parsed.hostname or "").lower() not in allow:
        raise FetchError(
            f"허용되지 않은 호스트입니다: {parsed.hostname}. "
            "관리자에게 CONNECTOR_ALLOWED_HOSTS 설정 확인을 요청하세요."
        )


def fetch_records(
    conn: ConnectionConfig, stream: StreamConfig, *, since: str | None = None
) -> list[dict]:
    """커넥션+스트림으로 외부 API 호출 → 레코드(dict) 목록. records_path 로 배열 추출.
    page_style 에 따라 여러 페이지를 이어 가져오고, since 가 있으면 watermark_param 으로
    "그 이후 변경분"만 요청한다(증분)."""
    base = (conn.base_url or "").strip()
    if not base:
        raise FetchError("base_url 이 비었습니다.")
    url = urljoin(base if base.endswith("/") else base + "/",
                  (stream.endpoint_path or "").lstrip("/"))
    _check_outbound(url)

    headers, basic = _auth_kwargs(conn)
    method = stream.http_method or "GET"
    base_query = dict(stream.query or {})
    if since and stream.watermark_param:
        # 값에 식이 필요한 API(OData $filter 등)는 템플릿으로. {since}·{field} 치환.
        if stream.watermark_template:
            base_query[stream.watermark_param] = (
                stream.watermark_template
                .replace("{since}", since)
                .replace("{field}", stream.watermark_field or "")
            )
        else:
            base_query[stream.watermark_param] = since

    style = stream.page_style
    out: list[dict] = []
    with httpx.Client(timeout=_TIMEOUT, follow_redirects=True) as client:
        if style in ("offset", "page"):
            size = max(1, stream.page_size)
            n = 0 if style == "offset" else 1
            # 자동 스킵은 offset 에서만(그래야 실패한 레코드를 $skip 으로 건너뜀).
            skip_on_error = stream.skip_on_error and style == "offset"
            skipped = 0
            for _ in range(_MAX_PAGES):
                q = {**base_query, stream.page_param: n, stream.size_param: size}
                payload, err = _request_json_partial(
                    client, method, url, headers, q, basic
                )
                recs = _extract_records(payload, stream.records_path)
                out.extend(recs)
                _guard_total(len(out))
                if err:
                    if not skip_on_error:
                        raise FetchError(
                            "서버가 응답 도중 오류를 반환했습니다(데이터 불완전): "
                            f"{err}"
                        )
                    # 이 페이지가 받은 recs 다음 레코드에서 죽었다 — 그 1건을 건너뛰고
                    # 이어서 가져온다. 받은 게 0건이어도 최소 1은 전진해 무한루프 방지.
                    skipped += 1
                    n = n + len(recs) + 1
                    continue
                if not recs or len(recs) < size:
                    break
                n = n + size if style == "offset" else n + 1
            if skipped:
                logger.warning(
                    "커넥터 자동 스킵: 서버 오류로 %d개 레코드를 건너뜀 "
                    "(endpoint=%s)",
                    skipped, stream.endpoint_path,
                )
        elif style == "cursor":
            cursor = None
            for _ in range(_MAX_PAGES):
                q = dict(base_query)
                if cursor:
                    q[stream.cursor_param] = cursor
                payload = _request_json(client, method, url, headers, q, basic)
                recs = _extract_records(payload, stream.records_path)
                out.extend(recs)
                _guard_total(len(out))
                cursor = _dig(payload, stream.cursor_path) if stream.cursor_path else None
                if not recs or not cursor:
                    break
        elif style == "next_url":
            # 응답이 알려주는 "완전한 다음 URL"을 따라간다(OData @odata.nextLink 등).
            # 첫 요청만 base_query 를 붙이고, 이후 nextLink 는 쿼리를 이미 포함하므로 그대로.
            next_url = url
            params = base_query
            for _ in range(_MAX_PAGES):
                _check_outbound(next_url)  # 매 홉 SSRF 재검증.
                payload = _request_json(client, method, next_url, headers, params, basic)
                recs = _extract_records(payload, stream.records_path)
                out.extend(recs)
                _guard_total(len(out))
                nxt = _dig(payload, stream.next_url_path) if stream.next_url_path else None
                if not recs or not nxt:
                    break
                next_url = urljoin(next_url, str(nxt))  # 상대→절대 해석.
                params = None
        else:  # none — 단일 요청.
            out = _extract_records(
                _request_json(client, method, url, headers, base_query, basic),
                stream.records_path,
            )
            _guard_total(len(out))
    return out


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
            column=f"__r_{i}", relation=rm.relation, target_type=rm.target_type,
            match_key=rm.match_key,
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
