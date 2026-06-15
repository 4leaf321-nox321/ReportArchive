"""링크 방식(URL 인제스트) — /api/files/from-url + SSRF 가드.

성공 경로는 네트워크 의존을 피하려 fetch 를 monkeypatch 한다. 차단 경로는
IP 리터럴이라 네트워크 없이도 검증된다(getaddrinfo 가 리터럴을 그대로 반환).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token
from app.shared.url_fetch import UrlFetchError, _validate_public_url, basename_from_url

WS = "dx"


def _h():
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": WS}


def test_from_url_success_monkeypatched(monkeypatch):
    """URL 에서 받은 바이트가 저장되고 file_id 로 다시 받을 수 있다."""
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64

    def fake_fetch(url, *, max_bytes):
        return ("chart.png", "image/png", png)

    monkeypatch.setattr(
        "app.modules.files.routes.fetch_file_from_url", fake_fetch
    )
    client = TestClient(app)
    res = client.post(
        "/api/files/from-url",
        headers=_h(),
        json={"url": "https://example.com/chart.png"},
    )
    assert res.status_code in (200, 201), res.text
    data = res.json()["data"]
    assert data["filename"] == "chart.png"
    assert data["mime_type"] == "image/png"
    assert data["is_image"] is True
    # 저장된 바이트를 file_id 로 다시 받을 수 있다.
    fid = data["id"]
    got = client.get(f"/api/files/{fid}", headers=_h())
    assert got.status_code == 200
    assert got.content == png


def test_from_url_respects_filename_override(monkeypatch):
    monkeypatch.setattr(
        "app.modules.files.routes.fetch_file_from_url",
        lambda url, *, max_bytes: ("auto.png", "image/png", b"\x89PNG\r\n\x1a\nxx"),
    )
    client = TestClient(app)
    res = client.post(
        "/api/files/from-url",
        headers=_h(),
        json={"url": "https://example.com/x.png", "filename": "내사진.png"},
    )
    assert res.status_code in (200, 201), res.text
    assert res.json()["data"]["filename"] == "내사진.png"


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/secret",
        "http://localhost:8080/x",
        "http://169.254.169.254/latest/meta-data/",  # 클라우드 메타데이터
        "http://10.0.0.5/internal",
        "http://192.168.0.1/admin",
        "ftp://example.com/x",  # 스킴 거부
    ],
)
def test_from_url_blocks_ssrf(url):
    """사설/loopback/링크로컬 + 비-http 스킴은 400 으로 차단."""
    client = TestClient(app)
    res = client.post("/api/files/from-url", headers=_h(), json={"url": url})
    assert res.status_code == 400, f"{url} → {res.status_code} {res.text}"


def test_validate_public_url_unit():
    # 차단 대상은 예외.
    for bad in (
        "http://127.0.0.1/",
        "http://10.1.2.3/",
        "http://169.254.169.254/",
        "https://[::1]/",
        "gopher://x/",
    ):
        with pytest.raises(UrlFetchError):
            _validate_public_url(bad)


def test_basename_from_url():
    assert basename_from_url("https://a.com/path/to/img.png?x=1") == "img.png"
    assert basename_from_url("https://a.com/") == ""
    # 마지막 세그먼트가 확장자 없으면 그대로 — 저장 시 mime 로 확장자 보강.
    assert basename_from_url("https://a.com/dir/") == "dir"
