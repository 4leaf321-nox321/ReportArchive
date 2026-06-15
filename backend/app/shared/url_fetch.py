"""SSRF-guarded remote file fetch — "링크 방식"(URL 인제스트)의 다운로드 계층.

AI/사용자가 준 URL에서 파일 바이트를 받아오되, 서버가 임의 URL을 받아오는
SSRF 위험을 막는다:
  - http/https 스킴만 허용
  - 호스트를 DNS 해석해 **모든** 결과 IP 가 공인(global)인지 검사
    (loopback/사설/링크로컬/예약/멀티캐스트 차단 → 사내망·메타데이터 IP 보호)
  - 리다이렉트는 직접 따라가며 매 홉마다 같은 검사를 반복(최대 3회)
  - 다운로드 중 크기 상한 초과 시 즉시 중단

주의: 검사 시점과 실제 연결 시점 사이의 DNS 재바인딩(TOCTOU)은 완전히는
막지 못한다. 인증된 사용자 권한으로만 호출되고, 추가로 운영망에서는
egress 방화벽으로 보강하는 것을 권장한다.
"""
from __future__ import annotations

import ipaddress
import socket
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx

# 다운로드 시 메모리 버퍼 청크.
_CHUNK = 1024 * 1024
# 리다이렉트 최대 추적 횟수.
_MAX_REDIRECTS = 3
# 연결/읽기 타임아웃(초).
_TIMEOUT = 30.0


class UrlFetchError(Exception):
    """URL 인제스트 실패 — 호출부에서 400 으로 변환."""


def _host_is_public(host: str) -> bool:
    """host(도메인 또는 IP 리터럴)를 해석해 **모든** 결과 IP 가 공인인지."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise UrlFetchError(f"호스트를 찾을 수 없습니다: {host}")
    if not infos:
        raise UrlFetchError(f"호스트를 해석할 수 없습니다: {host}")
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return False
        # 공인이 아닌 모든 범주 차단(사설/loopback/링크로컬/예약/멀티캐스트/미지정).
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False
    return True


def _validate_public_url(url: str) -> None:
    """스킴·호스트 검증. 위반 시 UrlFetchError."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UrlFetchError("http/https URL 만 허용됩니다.")
    host = parsed.hostname
    if not host:
        raise UrlFetchError("URL 에 호스트가 없습니다.")
    if not _host_is_public(host):
        raise UrlFetchError(
            "사설·내부 네트워크 주소로의 요청은 차단됩니다."
        )


def basename_from_url(url: str) -> str:
    """URL 경로의 마지막 세그먼트를 파일명 후보로(쿼리·프래그먼트 제외).
    없으면 빈 문자열."""
    path = urlparse(url).path
    name = unquote(Path(path).name) if path else ""
    # 경로 구분자·널 제거(저장 파일명 안전).
    return name.replace("/", "").replace("\\", "").strip()


_MIME_EXT_FALLBACK = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}


def _filename_for(url: str, mime_type: str) -> str:
    name = basename_from_url(url)
    if name and Path(name).suffix:
        return name[:255]
    ext = _MIME_EXT_FALLBACK.get((mime_type or "").split(";")[0].strip(), "")
    base = name or "download"
    return f"{base}{ext}"[:255]


def fetch_file_from_url(url: str, *, max_bytes: int) -> tuple[str, str, bytes]:
    """URL 에서 파일을 받아 `(filename, mime_type, content_bytes)` 반환.
    SSRF 검증 + 리다이렉트 직접 추적(매 홉 검증) + 크기 상한.
    실패 시 UrlFetchError."""
    current = url
    with httpx.Client(follow_redirects=False, timeout=_TIMEOUT) as client:
        for _ in range(_MAX_REDIRECTS + 1):
            _validate_public_url(current)
            try:
                with client.stream("GET", current) as resp:
                    # 리다이렉트면 Location 을 검증 후 다음 홉으로.
                    if resp.is_redirect:
                        loc = resp.headers.get("location")
                        if not loc:
                            raise UrlFetchError("리다이렉트에 Location 이 없습니다.")
                        current = str(httpx.URL(current).join(loc))
                        continue
                    if resp.status_code >= 400:
                        raise UrlFetchError(
                            f"다운로드 실패: HTTP {resp.status_code}"
                        )
                    mime_type = (
                        resp.headers.get("content-type", "application/octet-stream")
                        .split(";")[0]
                        .strip()
                        or "application/octet-stream"
                    )
                    # Content-Length 선검사(있으면) — 큰 파일 조기 차단.
                    clen = resp.headers.get("content-length")
                    if clen and clen.isdigit() and int(clen) > max_bytes:
                        raise UrlFetchError(
                            f"파일이 너무 큽니다. 최대 {max_bytes // (1024 * 1024)} MB."
                        )
                    buf = bytearray()
                    for chunk in resp.iter_bytes(_CHUNK):
                        buf.extend(chunk)
                        if len(buf) > max_bytes:
                            raise UrlFetchError(
                                f"파일이 너무 큽니다. 최대 {max_bytes // (1024 * 1024)} MB."
                            )
                    if not buf:
                        raise UrlFetchError("빈 파일은 받을 수 없습니다.")
                    return _filename_for(current, mime_type), mime_type, bytes(buf)
            except httpx.HTTPError as e:
                raise UrlFetchError(f"다운로드 중 오류: {e}") from e
    raise UrlFetchError("리다이렉트가 너무 많습니다.")
