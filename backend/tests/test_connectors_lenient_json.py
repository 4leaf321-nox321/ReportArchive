"""커넥터 관대 JSON 파싱 — 서버가 JSON 문서를 이어붙여 줄 때('Extra data')
두 문서를 파싱해 OData `value` 배열을 손실 없이 병합하는지 확인한다.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.modules.connectors.fetch import (
    FetchError,
    _apply_query,
    _loads_concatenated,
    _merge_docs,
    _request_json,
)


def test_apply_query_keeps_odata_chars_literal():
    # $ ( ) = , 는 리터럴로(퍼센트 인코딩 금지) — 서버가 중첩 $expand 를 받도록.
    u = _apply_query(
        "http://h/spdm_modelinfo",
        {"$expand": "product($select=ProjectCode)", "$top": "1"},
    )
    assert u == "http://h/spdm_modelinfo?$expand=product($select=ProjectCode)&$top=1"


def test_apply_query_encodes_spaces_and_ampersand():
    # 진짜 위험한 문자(공백·&)는 여전히 인코딩돼야 파라미터가 안 깨진다.
    u = _apply_query("http://h/x", {"$filter": "a eq b & c"})
    assert " " not in u and "%20" in u
    # 값 안의 & 는 인코딩(%26)돼 파라미터 구분자와 안 섞임
    assert u.count("&") == 0 or "%26" in u


def test_apply_query_appends_to_existing_query():
    u = _apply_query("http://h/x?a=1", {"$top": "5"})
    assert u == "http://h/x?a=1&$top=5"


class _FakeResp:
    """_request_json 이 기대하는 최소 httpx 응답 흉내."""

    def __init__(self, text, status_code=200):
        self.text = text
        self.status_code = status_code

    def json(self):  # 안 쓰이지만 안전용
        return json.loads(self.text)


class _FakeClient:
    def __init__(self, text):
        self._text = text

    def request(self, *a, **k):
        return _FakeResp(self._text)


def test_request_json_raises_on_trailing_odata_error():
    # 데이터 문서 뒤에 500 에러 객체가 이어붙은 실제 SPDM 케이스 — 부분 데이터를
    # 조용히 삼키지 말고 오류를 surface 해야 한다.
    body = (
        '{"value":[{"id":1}]}'
        '{"error":{"code":"500","message":"exception occurred while processing OData req"}}'
    )
    with pytest.raises(FetchError) as exc:
        _request_json(_FakeClient(body), "GET", "http://x", {}, None, None)
    assert "오류" in str(exc.value) and "OData" in str(exc.value)


def test_request_json_merges_concatenated_data_pages():
    body = '{"value":[{"id":1}]}{"value":[{"id":2}]}'
    out = _request_json(_FakeClient(body), "GET", "http://x", {}, None, None)
    assert [r["id"] for r in out["value"]] == [1, 2]


# --- 자동 스킵(skip_on_error) 통합 --- #
from urllib.parse import parse_qs, urlparse  # noqa: E402

from app.modules.connectors import fetch as F  # noqa: E402
from app.modules.connectors.schemas import ConnectionConfig, StreamConfig  # noqa: E402


class _PoisonHttpxClient:
    """$skip/$top 을 읽어 레코드를 페이지로 돌려주되, poison 인덱스에 닿으면 그
    레코드 전까지만 주고 뒤에 500 오류 객체를 이어붙인다(SPDM 재현)."""

    def __init__(self, records, poison):
        self.records = records
        self.poison = poison

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def request(self, method, url, headers=None, auth=None):
        q = parse_qs(urlparse(url).query)
        skip = int(q.get("$skip", ["0"])[0])
        top = int(q.get("$top", ["100"])[0])
        got, hit = [], False
        i = skip
        while i < skip + top and i < len(self.records):
            if i == self.poison:
                hit = True
                break
            got.append(self.records[i])
            i += 1
        body = '{"value":' + json.dumps(got) + "}"
        if hit:
            body += '{"error":{"code":"500","message":"boom"}}'
        return _FakeResp(body)


def test_fetch_records_skip_on_error_skips_poison(monkeypatch):
    records = [{"id": i} for i in range(10)]
    monkeypatch.setattr(
        F.httpx, "Client", lambda *a, **k: _PoisonHttpxClient(records, poison=3)
    )
    conn = ConnectionConfig(base_url="http://x.test")
    st = StreamConfig(
        endpoint_path="/m", records_path="value", page_style="offset",
        page_param="$skip", size_param="$top", page_size=5, skip_on_error=True,
    )
    out = F.fetch_records(conn, st)
    # poison(id=3)만 빠지고 나머지 9건 전부 수집.
    assert [r["id"] for r in out] == [0, 1, 2, 4, 5, 6, 7, 8, 9]


def test_fetch_records_without_skip_raises(monkeypatch):
    records = [{"id": i} for i in range(10)]
    monkeypatch.setattr(
        F.httpx, "Client", lambda *a, **k: _PoisonHttpxClient(records, poison=3)
    )
    conn = ConnectionConfig(base_url="http://x.test")
    st = StreamConfig(
        endpoint_path="/m", records_path="value", page_style="offset",
        page_param="$skip", size_param="$top", page_size=5, skip_on_error=False,
    )
    with pytest.raises(FetchError) as exc:
        F.fetch_records(conn, st)
    assert "오류" in str(exc.value)


def test_single_doc_unchanged():
    text = json.dumps({"value": [{"a": 1}], "@odata.context": "x"})
    docs = _loads_concatenated(text)
    assert len(docs) == 1
    assert _merge_docs(docs) == {"value": [{"a": 1}], "@odata.context": "x"}


def test_concatenated_odata_docs_merge_value_arrays():
    d1 = {"@odata.context": "c", "value": [{"id": 1}, {"id": 2}]}
    d2 = {"@odata.context": "c", "value": [{"id": 3}]}
    text = json.dumps(d1) + json.dumps(d2)  # 이어붙음(구분자 없음) — Extra data 유발
    # 표준 파서는 실패한다.
    try:
        json.loads(text)
        raise AssertionError("표준 json.loads 가 실패해야 한다")
    except ValueError:
        pass
    docs = _loads_concatenated(text)
    assert len(docs) == 2
    merged = _merge_docs(docs)
    assert [r["id"] for r in merged["value"]] == [1, 2, 3]  # 배열 이어붙음


def test_whitespace_between_docs_tolerated():
    text = '{"value":[{"id":1}]}\n  {"value":[{"id":2}]}'
    merged = _merge_docs(_loads_concatenated(text))
    assert [r["id"] for r in merged["value"]] == [1, 2]


def test_trailing_garbage_stops_gracefully():
    # 유효 JSON 뒤에 JSON 이 아닌 오염물 → 거기서 멈추고 앞 문서만 사용.
    text = '{"value":[{"id":1}]}<html>error</html>'
    docs = _loads_concatenated(text)
    assert len(docs) == 1
    assert _merge_docs(docs)["value"] == [{"id": 1}]


def test_last_scalar_wins_for_nextlink():
    d1 = {"value": [{"id": 1}], "@odata.nextLink": "page2"}
    d2 = {"value": [{"id": 2}], "@odata.nextLink": "page3"}
    merged = _merge_docs(_loads_concatenated(json.dumps(d1) + json.dumps(d2)))
    assert merged["@odata.nextLink"] == "page3"  # 스칼라는 마지막이 이김
    assert [r["id"] for r in merged["value"]] == [1, 2]


# --- probe 필드 경로 수집 --- #


def test_probe_collects_paths_beyond_sample():
    """자동완성 경로는 화면에 보여줄 5건이 아니라 받아온 레코드 전체에서 모은다.

    $expand 된 navigation 은 앞쪽 레코드에서 null 인 경우가 흔하다(실제 SPDM 의
    product). 5건만 훑으면 product.ProductCode 가 통째로 빠져 자동완성에 안 뜬다.
    """
    from unittest.mock import patch

    from app.modules.connectors import services as S

    records = [{"id": i, "Name": f"M{i}", "product": None} for i in range(5)]
    records.append({"id": 5, "Name": "M5", "product": {"ProductCode": "P-5"}})

    with patch.object(S, "fetch_records", return_value=records):
        out = S.probe_stream(ConnectionConfig(base_url="http://x"), StreamConfig())

    assert "product.ProductCode" in out["fields"]  # 6번째 레코드에만 있어도 잡힌다
    assert out["record_count"] == 6
    assert out["scanned"] == 6
    assert len(out["sample"]) == 5              # 화면 미리보기는 5건 그대로
    assert out["sample"][0]["product"] is None  # 첫 건은 여전히 null


def test_probe_drops_interior_paths():
    """null 때문에 leaf 로 잡힌 중간 노드('product')는 제안하지 않는다 — 하위
    경로가 있으면 그 경로는 객체를 가리키므로 속성 값으로 쓸 수 없다."""
    from unittest.mock import patch

    from app.modules.connectors import services as S

    records = [{"product": None}, {"product": {"ProductCode": "P-1"}}]
    with patch.object(S, "fetch_records", return_value=records):
        out = S.probe_stream(ConnectionConfig(base_url="http://x"), StreamConfig())

    assert out["fields"] == ["product.ProductCode"]


def test_probe_keeps_null_only_field():
    """전 레코드에서 null 인 필드는 하위 경로가 없으니 그대로 남긴다(존재 자체가 정보)."""
    from unittest.mock import patch

    from app.modules.connectors import services as S

    with patch.object(S, "fetch_records", return_value=[{"a": 1, "product": None}]):
        out = S.probe_stream(ConnectionConfig(base_url="http://x"), StreamConfig())
    assert out["fields"] == ["a", "product"]


def test_probe_array_paths_match_dig_notation():
    """컬렉션 navigation 은 인덱스 표기로 — _dig 가 읽는 표기와 같아야 한다."""
    from unittest.mock import patch

    from app.modules.connectors import services as S
    from app.modules.connectors.fetch import _dig

    rec = {"product": [{"ProductCode": "P-1"}]}
    with patch.object(S, "fetch_records", return_value=[rec]):
        out = S.probe_stream(ConnectionConfig(base_url="http://x"), StreamConfig())

    assert out["fields"] == ["product.0.ProductCode"]
    # 제안한 경로가 실제로 값을 뽑아내는지 — 자동완성이 거짓말하면 안 된다.
    assert _dig(rec, out["fields"][0]) == "P-1"
