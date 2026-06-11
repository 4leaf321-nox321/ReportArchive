"""ReportArchive MCP 서버 — Claude 가 보고서를 검색/조회/작성(초안)하게 하는 도구.

백엔드(FastAPI)와 의존성이 충돌(mcp ↔ starlette/pydantic)하므로 **별도 프로세스·
별도 venv** 로 돌리고, 백엔드와는 **REST API** 로만 통신한다. 사용자의 JWT(Authorization)
와 X-Workspace-Slug 를 그대로 백엔드에 전달해 **그 사용자 권한**으로 동작한다(만능 토큰 X).

스마트 로직(AI 느슨한 입력 → widget-v1 정규화·검증·초안 생성)은 백엔드 엔드포인트
(/api/reports/authoring-guide, /api/reports/ai-draft)에 있고, 여기선 그걸 호출만 한다.

실행:
    REPORTARCHIVE_API_BASE=http://localhost:3000 \
    ./venv/bin/python server.py          # streamable-http, 기본 127.0.0.1:3002/mcp

Claude Code 등록(사용자별 토큰):
    claude mcp add --transport http reportarchive http://<host>:3002/mcp \
      --header "Authorization: Bearer <내 토큰>" --header "X-Workspace-Slug: <부서slug>"
"""
import os

import httpx
from mcp.server.fastmcp import Context, FastMCP

API_BASE = os.environ.get("REPORTARCHIVE_API_BASE", "http://localhost:3000").rstrip("/")

mcp = FastMCP("reportarchive")


def _forward_headers(ctx: Context) -> dict:
    """들어온 MCP HTTP 요청의 인증/워크스페이스 헤더를 백엔드로 전달."""
    headers: dict[str, str] = {}
    req = getattr(getattr(ctx, "request_context", None), "request", None)
    if req is not None:
        for h in ("authorization", "x-workspace-slug"):
            v = req.headers.get(h)
            if v:
                # 백엔드가 기대하는 표기로.
                headers["Authorization" if h == "authorization" else "X-Workspace-Slug"] = v
    return headers


def _unwrap(r: httpx.Response):
    """백엔드 표준 응답 {success, data, message} 언래핑. 에러면 {error,...}."""
    try:
        body = r.json()
    except Exception:
        return {"error": f"HTTP {r.status_code} (non-JSON)", "status": r.status_code}
    if r.status_code >= 400 or not body.get("success", True):
        return {"error": body.get("message") or f"HTTP {r.status_code}", "detail": body}
    return body.get("data", body)


async def _get(ctx, path, params=None):
    async with httpx.AsyncClient(base_url=API_BASE, timeout=60) as client:
        return _unwrap(await client.get(path, params=params, headers=_forward_headers(ctx)))


async def _post(ctx, path, json_body):
    async with httpx.AsyncClient(base_url=API_BASE, timeout=120) as client:
        return _unwrap(await client.post(path, json=json_body, headers=_forward_headers(ctx)))


@mcp.tool()
async def list_templates(ctx: Context) -> list:
    """사용 가능한 보고서 템플릿 목록(template_id, version, name, description). 어떤
    템플릿으로 쓸지 고를 때 먼저 호출."""
    return await _get(ctx, "/api/templates")


@mcp.tool()
async def describe_template(template_id: str, template_version: int, ctx: Context) -> dict:
    """이 템플릿으로 보고서를 쓸 때 **각 블록(block_id)을 무엇으로 채워야 하는지** 안내.
    표의 열 키·선택지, 글 형식 등을 알려줌. create_report_draft 전에 호출해 blocks 를 구성."""
    return await _get(
        ctx,
        "/api/reports/authoring-guide",
        {"template_id": template_id, "template_version": template_version},
    )


@mcp.tool()
async def search_reports(q: str, ctx: Context, limit: int = 20) -> dict:
    """보고서 제목·본문 전문검색(내가 볼 수 있는 범위 내). 기존 내용을 참고할 때."""
    return await _get(ctx, "/api/reports/search", {"q": q, "limit": limit})


@mcp.tool()
async def get_report(report_id: int, ctx: Context) -> dict:
    """보고서 1건 상세(content 포함)."""
    return await _get(ctx, f"/api/reports/{report_id}")


@mcp.tool()
async def create_report_draft(
    template_id: str,
    template_version: int,
    title: str,
    blocks: dict,
    ctx: Context,
) -> dict:
    """보고서를 **초안(draft)** 으로 생성. `blocks` 는 block_id→내용(describe_template 참고).
    내용은 느슨하게 줘도 서버가 정규화·검증한다. 검증 실패 시 결과의 `error` 에 블록별
    메시지가 오니, 그걸 보고 `blocks` 를 고쳐 다시 호출하라. 성공하면 `url` 로 사람이 검토."""
    return await _post(
        ctx,
        "/api/reports/ai-draft",
        {
            "template_id": template_id,
            "template_version": template_version,
            "title": title,
            "blocks": blocks,
        },
    )


if __name__ == "__main__":
    mcp.settings.host = os.environ.get("MCP_HOST", "127.0.0.1")
    mcp.settings.port = int(os.environ.get("MCP_PORT", "3002"))
    mcp.run(transport="streamable-http")
