"""요청이 어디서 왔는지 — 'web'(사람) 대 'mcp'(AI 가 사용자 권한으로).

MCP 서버가 자기 요청마다 `X-Client: mcp` 헤더를 붙인다. 이건 **보안 경계가
아니다** — 헤더는 누구나 위조할 수 있고, 권한은 어차피 토큰으로 판정한다.
쓰임새는 두 가지다.

1. **경위 표식** — 남에게 보이는 흔적(댓글 p90 · 게시 p91 · 안건 요청 p92 ·
   `report_versions.source`)에 "AI가 한 것"을 남겨, 읽는 사람이 오해하지 않게.
2. **2단계 확인 대상 고르기** — 게시처럼 되돌리기 번거로운 행위는 MCP 경로에
   한해 미리보기·확인 토큰을 요구한다.
"""

from __future__ import annotations

from fastapi import Request

VIA_WEB = "web"
VIA_MCP = "mcp"


def via_of(request: Request) -> str:
    """`X-Client: mcp` 면 'mcp', 아니면 'web'."""
    return VIA_MCP if (request.headers.get("x-client") or "").lower() == VIA_MCP else VIA_WEB
