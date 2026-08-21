"""게시 2단계 확인 토큰 — preview 에서 발급, 실제 게시에서 검증.

게시(mount)는 **되돌리기 어려운 바깥 방향 행위**다. 문서가 조직에 보이는 순간
사람들이 읽고 인용하고 종합보고에 넣으며, 내리려면 게시판 매니저 승인이 필요하다
(`ReportTakedownRequest`). 웹에서는 사람이 대상 게시판을 눈으로 고르고 누르지만,
AI(MCP)는 이름을 잘못 해석해 **상위 부문 게시판에 순식간에 올릴 수 있다.**

그래서 MCP 경로만 2단계를 강제한다:
  1) `POST /api/mounts/preview` — 어디에 얼마나 보이게 되는지 + **confirm_token**
  2) `POST /api/mounts` — 그 토큰이 있어야 실행

토큰은 **(사용자, 보고서, 게시판 집합, 만료)** 에 서명한 값이라, 미리 본 것과 다른
대상으로 게시할 수 없다. 서명 기반이라 **저장 테이블이 없다**(재시작·다중 워커에도
무관). 서명 키는 앱의 JWT 시크릿을 재사용한다 — 유출돼도 얻는 건 "본인이 이미 할 수
있는 게시를 확인 단계 없이" 정도라 별도 키를 두지 않는다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time

from app.config import settings

# 미리 본 내용이 오래되면 게시판 구성·권한이 달라질 수 있다. 대화 한 턴 안에서
# 쓰는 값이라 짧게 잡는다.
TTL_SECONDS = 600


def _payload(user_id: int, report_id: int, boards, exp: int) -> str:
    joined = ",".join(sorted(str(b) for b in boards))
    return f"{user_id}:{report_id}:{joined}:{exp}"


def _sign(raw: str) -> str:
    mac = hmac.new(
        settings.jwt_secret_key.encode(), raw.encode(), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def issue(user_id: int, report_id: int, boards) -> str:
    """이 (사용자, 보고서, 게시판 집합) 조합에만 쓸 수 있는 확인 토큰."""
    exp = int(time.time()) + TTL_SECONDS
    raw = _payload(user_id, report_id, boards, exp)
    return f"{exp}.{_sign(raw)}"


def verify(token: str | None, user_id: int, report_id: int, boards) -> str | None:
    """유효하면 None, 아니면 사람이 읽을 수 있는 거절 사유."""
    if not token or "." not in token:
        return (
            "게시 전에 미리보기가 필요합니다 — POST /api/mounts/preview 로 어디에 "
            "게시되는지 확인한 뒤 받은 confirm_token 을 함께 보내세요."
        )
    exp_s, sig = token.split(".", 1)
    try:
        exp = int(exp_s)
    except ValueError:
        return "확인 토큰 형식이 올바르지 않습니다."
    if exp < int(time.time()):
        return "확인 토큰이 만료되었습니다. 미리보기를 다시 받아 주세요."
    expected = _sign(_payload(user_id, report_id, boards, exp))
    # 타이밍 공격 방어는 과하지만 비교는 상수시간으로 — 습관.
    if not hmac.compare_digest(expected, sig):
        return (
            "확인 토큰이 이 요청과 맞지 않습니다(보고서·게시판이 미리보기와 다름). "
            "게시할 대상 그대로 미리보기를 다시 받으세요."
        )
    return None
