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
import base64
import binascii
import os

import httpx
from mcp.server.fastmcp import Context, FastMCP

API_BASE = os.environ.get("REPORTARCHIVE_API_BASE", "http://localhost:3000").rstrip("/")

# base64 로 받은 바이트를 도구 인자로 나르는 건 모델 출력 토큰을 그대로 먹는다
# (1MB ≈ 1.3MB base64 ≈ 수십만 토큰). 그래서 upload_file 은 작은 이미지 전용으로
# 막아두고, 큰 파일/PPT 는 upload_from_url(서버가 직접 받음)로 유도한다.
_UPLOAD_BASE64_MAX_BYTES = 256 * 1024

# download_file 이 base64 로 되돌려 줄 수 있는 최대 크기. 여긴 반대로 **모델
# 입력(툴 결과) 토큰**을 먹으므로(1MB ≈ 1.3MB base64 ≈ 수십만 토큰) 상한을 둔다.
# 넘으면 바이트 없이 메타만 돌려주고 웹 UI 다운로드로 유도. 운영에서 조절 가능.
_DOWNLOAD_BASE64_MAX_BYTES = int(
    os.environ.get("MCP_DOWNLOAD_MAX_BYTES", str(1024 * 1024))
)

# 아웃오브밴드 업로드 라우트 — 일부러 streamable 엔드포인트(/mcp)와 같은 prefix
# 아래 둔다. FastMCP 가 /mcp 를 정확매칭 Route 로 달기 때문에 /mcp/files/upload 는
# 충돌 없이 공존하고, 리버스프록시가 이미 잡고 있는 `location /mcp` 가 그대로
# 커버한다(별도 location·MCP_PUBLIC_BASE 불필요).
_UPLOAD_ROUTE = "/mcp/files/upload"

# 기본은 SSE(streamable-http 스트림) 응답. 다만 중간에 SSE 를 버퍼링하는 프록시/
# VPN/보안장비가 끼면 initialize 응답의 첫 바이트가 클라이언트까지 도달하지 못해
# "무응답 → 타임아웃"이 난다(스트림은 끝나지 않으니 프록시가 붙잡고 안 흘려보냄).
# MCP_JSON_RESPONSE=1 이면 응답을 **단발 JSON**(Content-Length 완결)으로 돌려
# 그런 프록시를 통과시킨다. 대가로 처리 중 서버→클라이언트 스트리밍 메시지(진행률/
# 로그/재개)를 포기하지만, 이 서버는 그 기능들을 쓰지 않으므로 실질 손실이 없다.
_JSON_RESPONSE = os.environ.get("MCP_JSON_RESPONSE") == "1"

mcp = FastMCP("reportarchive", json_response=_JSON_RESPONSE)


def _forward_headers(ctx: Context) -> dict:
    """들어온 MCP HTTP 요청의 인증/워크스페이스 헤더를 백엔드로 전달.

    `X-Client: mcp` 를 함께 붙인다 — MCP 는 **사용자의 토큰으로** 동작해서 인증
    정보만으론 사람이 한 건지 AI 가 한 건지 구분할 수 없다. 백엔드가 이 헤더로
    댓글의 `via` 같은 **표시용 감사 표식**을 정한다(보안 경계 아님)."""
    headers: dict[str, str] = {"X-Client": "mcp"}
    req = getattr(getattr(ctx, "request_context", None), "request", None)
    if req is not None:
        for h in ("authorization", "x-workspace-slug"):
            v = req.headers.get(h)
            if v:
                # 백엔드가 기대하는 표기로.
                headers["Authorization" if h == "authorization" else "X-Workspace-Slug"] = v
    return headers


def _public_base(ctx: Context) -> str:
    """이 MCP 서버에 클라이언트가 도달하는 외부 base URL — 아웃오브밴드 업로드
    URL(/files/upload)을 만들 때 쓴다. 리버스프록시 뒤면 MCP_PUBLIC_BASE 로 명시,
    아니면 들어온 요청의 Host(+X-Forwarded-*)에서 유추한다."""
    env = os.environ.get("MCP_PUBLIC_BASE")
    if env:
        return env.rstrip("/")
    req = getattr(getattr(ctx, "request_context", None), "request", None)
    if req is not None:
        proto = req.headers.get("x-forwarded-proto") or req.url.scheme or "http"
        host = req.headers.get("x-forwarded-host") or req.headers.get("host")
        if host:
            return f"{proto}://{host}"
    return f"http://127.0.0.1:{os.environ.get('MCP_PORT', '3002')}"


def _unwrap(r: httpx.Response):
    """백엔드 표준 응답 {success, data, message} 언래핑. 에러면 {error,...}."""
    try:
        body = r.json()
    except Exception:
        return {"error": f"HTTP {r.status_code} (non-JSON)", "status": r.status_code}
    if r.status_code >= 400 or not body.get("success", True):
        return {"error": body.get("message") or f"HTTP {r.status_code}", "detail": body}
    return body.get("data", body)


def _headers(ctx, workspace: str | None = None) -> dict:
    """전달 헤더 + (선택) **이 호출만** 다른 게시판 컨텍스트로.

    일부 자원(종합보고 등)은 **활성 워크스페이스 트리**로 스코프된다. MCP 는 등록
    시 고정한 X-Workspace-Slug 를 계속 보내므로, 그대로면 그 한 게시판 것만 보인다
    (개인공간으로 등록했다면 0건). 그래서 호출별로 게시판을 지정할 수 있게 한다 —
    권한은 서버가 그대로 확인하므로 아무 게시판이나 본다는 뜻이 아니다."""
    h = _forward_headers(ctx)
    if workspace:
        h["X-Workspace-Slug"] = workspace
    return h


async def _get(ctx, path, params=None, workspace: str | None = None):
    async with httpx.AsyncClient(base_url=API_BASE, timeout=60) as client:
        return _unwrap(
            await client.get(path, params=params, headers=_headers(ctx, workspace))
        )


async def _post(ctx, path, json_body, workspace: str | None = None):
    async with httpx.AsyncClient(base_url=API_BASE, timeout=120) as client:
        return _unwrap(
            await client.post(path, json=json_body, headers=_headers(ctx, workspace))
        )


async def _patch(ctx, path, json_body):
    async with httpx.AsyncClient(base_url=API_BASE, timeout=120) as client:
        return _unwrap(await client.patch(path, json=json_body, headers=_forward_headers(ctx)))


async def _post_multipart(ctx, path, *, filename, content, mime_type):
    """멀티파트로 바이너리를 백엔드 /api/files 에 그대로 흘려보낸다(기존 업로드
    경로·용량제한·소유권 재사용)."""
    async with httpx.AsyncClient(base_url=API_BASE, timeout=120) as client:
        return _unwrap(
            await client.post(
                path,
                files={"file": (filename, content, mime_type)},
                headers=_forward_headers(ctx),
            )
        )


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
async def describe_widgets(types: list, ctx: Context) -> dict:
    """주어진 위젯 타입들의 **상세 작성 룰**(content 형식·필수 키·자주 틀리는 형식·
    혼동되기 쉬운 위젯 쌍·흔한 환각 키 등)을 돌려준다. `extra_blocks` 로 위젯을 직접
    만들기 전에 쓸 위젯 타입을 넣어 룰을 받아 **그대로** 따르라(예: ["chart","table","pie"]).
    describe_template 응답의 widget_rules 와 같은 단일 소스다."""
    return await _get(ctx, "/api/widgets/authoring-rules", {"types": types})


@mcp.tool()
async def describe_metadata(ctx: Context) -> dict:
    """보고서 메타데이터에 쓸 수 있는 값들을 조회한다 — create_report_draft /
    update_report_draft 의 `report_type_id` · `entity_ids` 에 넣을 **유효한 id** 를
    여기서 골라 쓴다(이름을 임의로 만들어 넣지 말 것). 날짜(report_date)·자유
    태그(tags)는 조회 없이 바로 넣어도 된다.

    반환:
      - report_types: [{id, name, status}] — 보고서 유형(report_type_id 후보).
      - entity_axes:  [{type_id, slug, label, values: [{id, value, status}]}]
                      — 모델/단계/부품 등 '축'과 그 값들(entity_ids 후보)."""
    rt = await _get(ctx, "/api/report-types")
    if isinstance(rt, dict) and rt.get("error"):
        return rt
    et = await _get(ctx, "/api/entity-types")
    if isinstance(et, dict) and et.get("error"):
        return et
    ents = await _get(ctx, "/api/entities", {"limit": 500})
    if isinstance(ents, dict) and ents.get("error"):
        return ents
    report_types = [
        {"id": r.get("id"), "name": r.get("name"), "status": r.get("status")}
        for r in (rt.get("items") or [])
    ]
    by_type: dict = {}
    for e in ents.get("items") or []:
        by_type.setdefault(e.get("type_id"), []).append(
            {"id": e.get("id"), "value": e.get("value"), "status": e.get("status")}
        )
    entity_axes = [
        {
            "type_id": t.get("id"),
            "slug": t.get("slug"),
            "label": t.get("label"),
            "values": by_type.get(t.get("id"), []),
        }
        for t in (et.get("items") or [])
    ]
    return {"report_types": report_types, "entity_axes": entity_axes}


@mcp.tool()
async def search_reports(
    ctx: Context,
    query: str,
    limit: int = 8,
    last_days: int | None = None,
    period: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    report_type: str | None = None,
    author: str | None = None,
    phase: str | None = None,
    lifecycle: str | None = None,
    board: str | None = None,
    folder: str | None = None,
    include_descendants: bool = False,
    unfiled: bool = False,
    author_org: str | None = None,
) -> dict:
    """**본문 내용으로** 보고서를 찾는다(의미+키워드). 근거·참고 자료를 찾을 때.
    → 조건으로 목록을 뽑을 땐 `list_reports`, 개수만 필요하면 `aggregate_reports`.

    **하이브리드 검색**: 정확한 단어(키워드)뿐 아니라 *의미가 비슷한* 보고서도 찾는다
    (임베딩 기반). 예: "브래킷 응력"으로 검색하면 "브라켓 강도 검토"처럼 표현이 달라도
    뜻이 가까운 보고서가 함께 잡힌다. 각 결과에 report_id·title·snippet 이 있으니,
    필요하면 report_id 로 get_report 를 호출해 상세를 본다.

    필터로 좁힐 수 있다(이름은 그대로 넣으면 서버가 id 로 해석한다):
      - report_type: 종류 이름('주간보고') · author: 작성자 이름('홍길동')
      - phase: drafting|reviewing|finalized · lifecycle: single_shot|ongoing
      - 기간: last_days(최근 N일) · period(today|this_week|this_month|this_year) ·
        date_from/date_to(YYYY-MM-DD)
      - **board**: 게시판(조직) 이름/slug('dx'·'선행개발') — 그 게시판에 게시된 글만.
        include_descendants=True 면 하위 부서 게시판까지.
      - **folder**: board 안의 폴더 이름/id('진행 중'). unfiled=True 면 미분류만.
      - **author_org**: 작성자 소속 부서 — *그 부서 사람이 쓴* 글(게시 여부 무관).
        board(게시된 곳)와는 다른 축이니 의도에 맞는 쪽을 고른다.
    board/folder 이름을 모르면 `list_boards`·`list_folders` 로 먼저 확인하라 —
    못 찾은 이름은 조용히 무시하지 않고 **에러**로 돌려준다(전체 결과를 그 조직 것으로
    오해하는 사고 방지).

    ※ 이 도구는 근거 발췌용이라 **최대 25건**(기본 8)이다. 조건에 맞는 글을 **모아
    나열**하려면 `list_reports` 를 쓴다(요약 필드·최대 100건·페이지네이션).
    예: "낙하시험" + report_type='주간보고' + last_days=30."""
    args = {
        "query": query, "limit": limit, "last_days": last_days, "period": period,
        "date_from": date_from, "date_to": date_to, "report_type": report_type,
        "author": author, "phase": phase, "lifecycle": lifecycle,
        "board": board, "folder": folder, "author_org": author_org,
        "include_descendants": include_descendants or None,
        "unfiled": unfiled or None,
    }
    return await _ontology_tool(
        ctx, "search_reports", {k: v for k, v in args.items() if v is not None}
    )


@mcp.tool()
async def list_boards(ctx: Context) -> dict:
    """**게시판(조직) 목록** — 보고서가 게시되는 부서/TF 게시판의 slug·이름·상위부서.

    보고서 자체엔 조직 정보가 없다(작성자 개인공간에 저장된다). "어느 조직 글이냐"는
    **어느 게시판에 게시(mount)됐냐**로만 정해진다 — 그래서 조직 단위로 찾으려면
    먼저 여기서 게시판 어휘를 확인하고, 그 slug/이름을 `list_reports(board=...)` ·
    `search_reports(board=...)` 에 넣는다. 개인공간은 나오지 않는다.
    반환: {boards:[{slug,name,parent_slug,kind}], count}."""
    rows = await _get(ctx, "/api/workspaces")
    if isinstance(rows, dict):
        if rows.get("error"):
            return rows
        rows = rows.get("items") or []
    boards = [
        {
            "slug": w.get("slug"),
            "name": w.get("name"),
            "parent_slug": w.get("parent_slug"),
            "kind": w.get("kind"),
        }
        for w in rows
        if w.get("kind") not in ("personal", "virtual")
    ]
    return {"boards": boards, "count": len(boards)}


@mcp.tool()
async def list_folders(board: str, ctx: Context) -> dict:
    """게시판 안의 **폴더 목록**(id·이름·상위폴더·보고서수) + 미분류 건수.
    → `board` 는 `list_boards` 의 slug. 폴더로 글을 좁히려면 이걸 먼저 부른다.

    게시판은 폴더로 분류돼 있고(예: '진행 중'·'종결'·'Q2 핵심'), 한 보고서가 한
    게시판의 여러 폴더에 동시에 걸릴 수도 있다. 여기서 얻은 폴더 이름/id 를
    `list_reports(board=..., folder=...)` 에 넣어 그 폴더 글만 모아 본다.
    `board` 는 `list_boards` 의 slug(또는 부서 이름).
    반환: {board, folders:[{id,name,parent_id,report_count}], uncategorized_count}."""
    data = await _get(ctx, "/api/folders", {"workspace_slug": board})
    if isinstance(data, dict) and data.get("error"):
        return data
    items = (data or {}).get("items") or []
    return {
        "board": board,
        "folders": [
            {
                "id": f.get("id"),
                "name": f.get("name"),
                "parent_id": f.get("parent_id"),
                "report_count": f.get("report_count", 0),
            }
            for f in items
        ],
        "uncategorized_count": (data or {}).get("uncategorized_count", 0),
    }


@mcp.tool()
async def list_reports(
    ctx: Context,
    board: str | None = None,
    folder: str | None = None,
    query: str = "",
    limit: int = 30,
    offset: int = 0,
    include_descendants: bool = False,
    unfiled: bool = False,
    author: str | None = None,
    author_org: str | None = None,
    report_type: str | None = None,
    last_days: int | None = None,
    period: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    phase: str | None = None,
    lifecycle: str | None = None,
    tags: list | None = None,
    sort: str = "recent",
) -> dict:
    """**조건으로** 보고서 목록을 뽑는다(게시판·폴더·작성자·기간·종류).
    → 본문 내용으로 찾는 건 `search_reports`, 개수만 필요하면 `aggregate_reports`.
    "○○팀 게시판 글 보여줘",
    "'진행 중' 폴더에 뭐 있어?", "최근 한 달 주간보고 목록" 같은 요청용.

    `search_reports` 와의 차이 — 저쪽은 *의미 검색으로 근거 발췌*(최대 25건, 본문
    스니펫), 이쪽은 *조건으로 목록 뽑기*(최대 100건, offset 페이지네이션, 요약 필드).
    개수만 필요하면 `aggregate_reports` 를 쓴다.

    필터(전부 **이름 그대로** 넣으면 서버가 id 로 푼다):
      - board: 게시판(조직) 이름/slug. include_descendants=True 면 하위 부서까지.
      - folder: 그 게시판의 폴더 이름/id. unfiled=True 면 미분류만.
      - query: 제목·본문 부분일치(빈 값이면 조건에 맞는 전체를 최신순으로 브라우즈).
      - author: 작성자 이름 · author_org: 작성자 **소속 부서**(게시 여부 무관)
      - report_type: 종류 이름 · phase: drafting|reviewing|finalized ·
        lifecycle: single_shot|ongoing · tags: 자유 태그 목록
      - 기간: last_days · period(today|this_week|this_month|this_year) · date_from/to
      - sort: recent(기본)|oldest|relevance
    board/folder 이름을 모르면 `list_boards`·`list_folders` 로 먼저 확인한다. 못 찾은
    이름은 조용히 무시하지 않고 **에러**로 돌려준다(조건이 빠진 전체 결과를 그 조직
    것으로 오해하는 사고 방지).

    반환: {reports:[{report_id,title,report_date,author,phase,tags,boards,snippet,url}],
    total, limit, offset, has_more}. 상세는 report_id 로 `get_report`."""
    params: dict = {
        "q": query,
        "limit": max(1, min(limit, 100)),
        "offset": max(0, offset),
        "sort": sort if sort in ("recent", "oldest", "relevance") else "recent",
    }
    for key, val in (
        ("board", board), ("folder", folder), ("author", author),
        ("author_org", author_org), ("report_type", report_type),
        ("phase", phase), ("lifecycle", lifecycle), ("period", period),
        ("date_from", date_from), ("date_to", date_to),
    ):
        if val:
            params[key] = val
    if last_days is not None:
        params["last_days"] = last_days
    if include_descendants:
        params["include_descendants"] = "true"
    if unfiled:
        params["unfiled"] = "true"
    if tags:
        params["tags"] = tags
    return await _get(ctx, "/api/reports/browse", params)


@mcp.tool()
async def list_my_reports(ctx: Context, limit: int = 20, phase: str = "all") -> dict:
    """**내가 쓴** 보고서 목록 — 고칠 대상을 찾을 때. 남의 글·조건 검색은 `list_reports`.
    (최근 수정 순) — 이어서 수정(update_report_draft)할
    대상을 찾는 진입점.

    기본은 **전체 단계**다. 게시(mount)하면 단계가 자동으로 `reviewing` 으로 올라가서,
    예전처럼 `drafting` 만 보면 **이미 게시한 글은 찾지도 못한다**. `phase` 로
    좁힐 수 있다 — all(기본) | drafting(작성중) | reviewing(게시·리뷰중) | finalized(발행본).

    각 항목: report_id·title·template_id/version·page_count·phase·**editable**(내가
    AI 로 고칠 수 있는지) ·**mounted_to**(게시된 게시판·폴더) ·url.
    발행본은 editable=False — 사람이 '발행 취소' 한 뒤에야 고칠 수 있다."""
    return await _get(
        ctx, "/api/reports/my-drafts", {"limit": limit, "phase": phase}
    )


@mcp.tool()
async def get_report(report_id: int, ctx: Context) -> dict:
    """보고서 1건의 **본문 전체**. 내용을 실제로 읽거나 고칠 근거가 필요할 때만.
    → 구조·빈 블록만 보려면 `get_report_outline`(훨씬 가볍다).
    `mount_workspaces` 에 이 글이 게시된 게시판과
    그 게시판에서의 폴더 배치가 들어 있다(빈 리스트 = 아직 미게시)."""
    return await _get(ctx, f"/api/reports/{report_id}")


@mcp.tool()
async def get_report_outline(report_id: int, ctx: Context) -> dict:
    """보고서의 **구조만** — 페이지별 블록과 채워졌는지(본문은 안 옴).
    → 내용을 읽어야 하면 `get_report`. 작성·수정 후 자기 점검이 주 용도.

    너는 완성된 화면을 볼 수 없어서, 만든 보고서에 **빈 표나 데이터 없는 차트**가
    남아도 알아채지 못한다. `get_report` 로 본문을 통째로 읽으면 토큰을 크게 먹으니,
    작성·수정을 마친 뒤 **이 도구로 자기 점검**을 하라.

    `issues` 가 바로 손봐야 할 것이다(보이는데 빈 블록 등). 비어 있는 게 의도된
    경우도 있으니(파일 위젯 등 사람이 채울 것) 무조건 채우지 말고, **사용자에게
    "○쪽 △△가 비어 있습니다" 라고 알려라.**

    반환: {title, phase, page_count, pages:[{page, blocks:[{block_id, type, filled,
    rows?/items?/chars?}]}], issues, mounted_to}."""
    return await _get(ctx, f"/api/reports/{report_id}/outline")


# --------------------------------------------------------------------------- #
# 게시(mount) — 되돌리기 어려운 **바깥 방향** 행위라 2단계다.
# preview 로 어디에 얼마나 보이게 되는지 확인 → 사용자에게 확인받고 → publish.
# --------------------------------------------------------------------------- #
@mcp.tool()
async def preview_publish(report_id: int, boards: list, ctx: Context) -> dict:
    """게시하면 **무슨 일이 생기는지** 미리 본다(실제로 게시하지 않는다).

    `boards` 는 게시판 slug 목록(`list_boards` 참고). 반환의 각 대상에는
    이름·**audience(그 게시판과 하위에 소속된 사람 수)**·하위 게시판 수·이미
    게시됐는지·못 올리는 사유가 들어 있다.

    **반드시 이걸 먼저 부르고, 사용자에게 "○○ 게시판(N명)에 게시합니다" 라고
    확인받아라.** 그다음 여기서 받은 `confirm_token` 으로 `publish_report` 를 부른다.
    토큰 없이는 게시되지 않는다 — 게시는 조직 전체에 문서를 노출시키고, 내리려면
    게시판 매니저 승인이 필요해서 되돌리기가 쉽지 않기 때문이다."""
    return await _post(
        ctx, "/api/mounts/preview",
        {"report_id": report_id, "workspace_slugs": boards},
    )


@mcp.tool()
async def publish_report(
    report_id: int,
    boards: list,
    confirm_token: str,
    ctx: Context,
    note: str = "",
    folder_ids: list | None = None,
) -> dict:
    """보고서를 부서 게시판에 **게시**한다. `confirm_token` 은 `preview_publish` 가 준 값.

    토큰은 **(보고서, 게시판 집합)** 에 묶여 있어, 미리 본 것과 다른 대상으로는
    게시되지 않는다(대상을 바꾸려면 미리보기를 다시 받아라). 10분 지나면 만료된다.

    권한은 사용자 것 그대로다 — 본인이 쓴 보고서이거나, 이미 게시된 게시판의
    매니저여야 한다. 게시 이력에 **AI가 올렸다는 표식**이 남는다.

    게시 후 **어느 게시판에 올렸는지 사용자에게 알려라.** 잘못 올렸으면 작성자가
    웹에서 게시취소할 수 있지만, 매니저 승인이 필요한 경우도 있다."""
    body: dict = {
        "report_id": report_id,
        "workspace_slugs": boards,
        "confirm_token": confirm_token,
        "note": note,
    }
    if folder_ids:
        body["folder_ids"] = folder_ids
    return await _post(ctx, "/api/mounts", body)


# --------------------------------------------------------------------------- #
# 종합보고 — 여러 보고서를 안건으로 묶는 상위 산출물. AI 는 **제출 요청**까지만
# 하고 실제 반영은 사람(종합보고 담당자)이 승인한다.
# --------------------------------------------------------------------------- #
@mcp.tool()
async def list_composites(
    ctx: Context, board: str | None = None, limit: int = 20
) -> dict:
    """**종합보고** 목록(주간보고·월간보고처럼 여러 보고서를 안건으로 묶은 상위 문서).

    종합보고는 **게시판(부서)에 속한다.** `board` 로 어느 게시판 것을 볼지 지정하라
    (`list_boards` 의 slug). 생략하면 MCP 등록 시 정해진 부서 것만 나오는데, 개인
    공간으로 등록돼 있으면 **0건**이 나온다 — 그럴 땐 board 를 지정해야 한다.
    상세는 `get_composite`."""
    rows = await _get(ctx, "/api/composites", {"limit": limit}, workspace=board)
    if isinstance(rows, dict):
        if rows.get("error"):
            return rows
        rows = rows.get("items") or []
    return {"composites": rows, "count": len(rows)}


@mcp.tool()
async def get_composite(
    composite_id: int, ctx: Context, board: str | None = None
) -> dict:
    """종합보고 1건 상세 — 요약·안건 목록·그룹 구성.
    `board` 는 `list_composites` 에서 쓴 것과 같은 게시판(스코프가 다르면 안 보인다)."""
    return await _get(ctx, f"/api/composites/{composite_id}", workspace=board)


@mcp.tool()
async def request_composite_item(
    composite_id: int,
    report_id: int,
    ctx: Context,
    note: str = "",
    board: str | None = None,
) -> dict:
    """보고서를 종합보고에 **안건으로 제출 요청**한다.

    ※ 바로 반영되지 않는다 — **대기 목록에 쌓이고 담당자가 승인**해야 안건이 된다.
    그게 설계상 의도다(AI 가 상위 문서를 직접 바꾸지 않는다).

    어느 종합보고에 낼 수 있는지 모르면 `list_submittable_composites(report_id)` 로
    먼저 확인하라 — 이미 안건이거나 이미 제출 대기인지도 알려준다.
    `note` 에 왜 내는지 한 줄 적어두면 담당자가 판단하기 쉽다."""
    return await _post(
        ctx,
        f"/api/composites/{composite_id}/requests",
        {"ref_report_id": report_id, "note": note},
        workspace=board,
    )


@mcp.tool()
async def list_submittable_composites(report_id: int, ctx: Context) -> dict:
    """이 보고서를 **안건으로 낼 수 있는 종합보고** 목록. 이미 안건인지·이미 제출
    대기인지 상태도 함께 온다. `request_composite_item` 전에 확인용."""
    return await _get(ctx, f"/api/composites/submittable-for/{report_id}")


# --------------------------------------------------------------------------- #
# 협업 — 사람과 문서 안에서 주고받는다. 지시를 채팅으로 옮겨 적을 필요 없이
# "댓글 반영해줘" 가 되게 하는 축. 전부 사용자 권한 그대로 동작한다.
# --------------------------------------------------------------------------- #
@mcp.tool()
async def list_comments(
    report_id: int, ctx: Context, status: str | None = None
) -> dict:
    """보고서의 **댓글(리뷰 의견)** 을 읽는다. "댓글 반영해서 고쳐줘" 의 출발점.

    스레드 단위로 묶여 있고, 각 스레드는 보고서의 특정 **블록**에 달려 있다
    (`block_id`·`page` — 어느 부분에 대한 의견인지). `status` 로 'open'(미해결)만
    골라 볼 수 있다.

    각 댓글의 **`via`** 는 누가 썼는지 구분한다 — 'web'(사람이 직접) ·
    'mcp'(AI 가 이 사용자 권한으로). 내가 이전에 단 답글을 사람 의견으로
    착각하지 마라.

    반환: {threads:[{thread_id, status, page, block_id, comments:[
    {comment_id, author, via, text, created_at}]}], count}.
    고친 뒤에는 `reply_comment` 로 무엇을 했는지 남기고, 끝났으면 `resolve_thread`."""
    rows = await _get(ctx, f"/api/reports/{report_id}/threads")
    if isinstance(rows, dict):
        if rows.get("error"):
            return rows
        rows = rows.get("items") or []
    out = []
    for t in rows:
        if status and (t.get("status") or "") != status:
            continue
        out.append({
            "thread_id": t.get("id"),
            "status": t.get("status"),
            "page": t.get("page_index"),
            "block_id": t.get("block_id"),
            "comments": [
                {
                    "comment_id": c.get("id"),
                    "author": (c.get("author") or {}).get("name"),
                    "via": c.get("via", "web"),
                    "text": _doc_to_text(c.get("body")),
                    "created_at": c.get("created_at"),
                }
                for c in (t.get("comments") or [])
            ],
        })
    return {"threads": out, "count": len(out)}


@mcp.tool()
async def reply_comment(thread_id: int, text: str, ctx: Context) -> dict:
    """댓글 스레드에 **답글**을 단다. 보통 "고쳤습니다 + 무엇을 어떻게" 를 남긴다.

    ※ 이 답글은 **당신(사용자) 계정으로** 달리지만 `via='mcp'` 표식이 붙어,
    화면에서 'AI' 로 표시된다. 사람이 쓴 것처럼 위장하지 말고, 무엇을 했는지
    구체적으로 적어라(어느 블록을 어떻게 고쳤는지)."""
    return await _post(
        ctx,
        f"/api/threads/{thread_id}/comments",
        {"body": _text_to_doc(text)},
    )


@mcp.tool()
async def resolve_thread(thread_id: int, ctx: Context, reopen: bool = False) -> dict:
    """댓글 스레드를 **해결됨**으로 닫는다(`reopen=True` 면 다시 연다).

    스스로 닫지 마라 — 요청을 처리했더라도 **사람이 확인한 뒤** 닫는 게 원칙이다.
    사용자가 "닫아줘" 라고 할 때만 쓴다."""
    return await _patch(
        ctx,
        f"/api/threads/{thread_id}",
        {"status": "open" if reopen else "resolved"},
    )


@mcp.tool()
async def list_my_notifications(
    ctx: Context, unread_only: bool = True, limit: int = 20
) -> dict:
    """내게 온 **알림**. "나 뭐 할 거 있어?" 에 답할 때 쓴다.

    댓글·게시취소 요청·리뷰 요청·경보 등이 여기로 온다. 각 항목의 `ref` 로
    대상(보고서 등)을 알 수 있으니, 필요하면 `get_report` 로 이어서 본다."""
    params: dict = {"limit": max(1, min(limit, 100))}
    if unread_only:
        params["unread_only"] = "true"
    return await _get(ctx, "/api/notifications", params)


def _doc_to_text(doc) -> str:
    """tiptap 문서(JSON) → 평문. 댓글 본문은 리치 문서라 그대로 주면 모델이
    읽기 어렵고 토큰만 먹는다. 문단별로 텍스트만 뽑아 줄바꿈으로 잇는다."""
    if not isinstance(doc, dict):
        return str(doc or "")
    out: list[str] = []

    def walk(node, depth=0):
        if not isinstance(node, dict):
            return
        if node.get("type") == "text":
            out.append(node.get("text") or "")
            return
        for child in node.get("content") or []:
            walk(child, depth + 1)
        if node.get("type") in ("paragraph", "heading", "listItem"):
            out.append("\n")

    walk(doc)
    return "".join(out).strip()


def _text_to_doc(text: str) -> dict:
    """평문 → tiptap 문서(JSON). 댓글 API 가 받는 형식. 빈 줄로 문단을 나눈다."""
    paras = [p for p in (text or "").split("\n") if p.strip()] or [""]
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": ([{"type": "text", "text": p}] if p else [])}
            for p in paras
        ],
    }


# --------------------------------------------------------------------------- #
# 온톨로지 조사 — 객체/관계를 스스로 다단계로 파고든다(팔란티어식). 어휘가 확실치
# 않으면 먼저 list_object_types, 구조적 질문은 search_objects(추측 금지), 상세·관계는
# get_object, 관계를 여러 단계 타면 get_subgraph, 서술형은 search_reports,
# **개수는 aggregate_reports**(직접 세지 말 것). 세밀한 제어 없이 완결 답변만 원하면
# ask_ontology(서버 에이전트에 위임).
# --------------------------------------------------------------------------- #
async def _ontology_tool(ctx, name, args):
    return await _post(ctx, "/api/ai/ontology/tool", {"name": name, "args": args})


@mcp.tool()
async def list_object_types(ctx: Context) -> dict:
    """온톨로지 지도 — 검색 가능한 **객체 종류(타입)**와 각 타입의 속성 key·데이터타입
    (enum이면 허용값)·**관계 종류(relation slug)**를 돌려준다. search_objects/get_object
    로 쿼리를 만들기 전에 **먼저 호출**해 어휘(타입 slug·속성 key·관계 slug)를 확인하라.
    반환: {object_types:[{slug,label,kind,properties:[{key,label,data_type,enum_values?,
    ref_type?}]}], relation_types:[{slug,label,directed,src_types,dst_types}]}."""
    return await _ontology_tool(ctx, "list_object_types", {})


@mcp.tool()
async def search_objects(
    ctx: Context,
    type: str | None = None,
    q: str | None = None,
    props: list | None = None,
    relations: list | None = None,
    year: int | None = None,
    limit: int = 15,
) -> dict:
    """**기준정보 객체**(모델·부품·과제 등)를 타입+속성+관계로 찾는다. 보고서가 아니다.
    → 보고서를 찾으려면 `search_reports`/`list_reports`. 어휘를 모르면 먼저 `list_object_types`.
    "속성이
    조건에 맞는" / "특정 객체와 관계된" 같은 구조적 질문에 쓴다.
      - type: 객체 종류 slug (list_object_types 참고).
      - q: 이름/코드/설명 부분검색.
      - props: 속성 필터 [{key, op, value}] — op ∈ eq|gte|lte|between|contains.
      - relations: 관계 필터 [{relation, dst_id}] — 이 관계로 dst_id 객체와 연결된 것만.
      - year: 자료연도.
    반환: {items:[{id,value,type,properties}], total, shown, truncated}. 상세는 get_object."""
    args = {
        "type": type, "q": q, "props": props,
        "relations": relations, "year": year, "limit": limit,
    }
    return await _ontology_tool(
        ctx, "search_objects", {k: v for k, v in args.items() if v is not None}
    )


@mcp.tool()
async def get_object(type: str, id: str, ctx: Context) -> dict:
    """객체 하나의 프로필 — 속성, **연결된 객체(관계 방향·상대)**, 이 객체를 근거로
    하는 보고서(권한 내). type·id 로 지목한다(search_objects 결과의 type·id). 관계를
    타고 상대 객체를 get_object 로 이어 조사하면 그래프를 traversal 할 수 있다.
    반환: {type,id,label,kind,properties,relations:[{relation,direction,object}],reports}."""
    return await _ontology_tool(ctx, "get_object", {"type": type, "id": id})


@mcp.tool()
async def aggregate_reports(
    ctx: Context,
    filters: list | None = None,
    target: str = "report",
    year: int | None = None,
    last_days: int | None = None,
    period: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    report_type: str | None = None,
    author: str | None = None,
    phase: str | None = None,
    lifecycle: str | None = None,
) -> dict:
    """**개수만** 센다 — "몇 건이야?". SQL 로 세므로 정확하다.
    → 목록이 필요하면 `list_reports`, 본문 검색은 `search_reports`.
    직접 세지 마라(누락·환각).
    search_reports 결과를 직접 세지 마라(누락·환각). 볼 수 있는 보고서만 집계된다.
      - filters: 조건 값들(태깅) 예 ["낙하시험","실패"]. 서로 다른 축은 AND.
        날짜/작성자 조건만 쓸 거면 빈 배열 [].
      - target: 셀 대상 — 'report'(기본) 또는 축 slug(그 축의 값 개수).
      - year: 자료연도. last_days/period/date_from/date_to: 기간.
      - report_type: 종류 이름('주간보고'), author: 작성자 이름, phase: drafting|
        reviewing|finalized, lifecycle: single_shot|ongoing.
    반환: {count, unit, target_label, values, report_ids, filters, year}."""
    args = {
        "filters": filters if filters is not None else [],
        "target": target, "year": year, "last_days": last_days, "period": period,
        "date_from": date_from, "date_to": date_to, "report_type": report_type,
        "author": author, "phase": phase, "lifecycle": lifecycle,
    }
    return await _ontology_tool(
        ctx, "aggregate_reports", {k: v for k, v in args.items() if v is not None}
    )


@mcp.tool()
async def get_subgraph(
    entity_id: int, ctx: Context, relations: list | None = None, depth: int = 2
) -> dict:
    """엔티티 주변 **서브그래프(노드+엣지)** 를 한 번에 — 양방향 depth hop까지 재귀
    확장한다. 관계를 여러 단계 타고 넘어가는 "구조 조사"를 get_object 반복 없이 한 콜로
    끝낼 때 쓴다. relations 로 따라갈 관계 종류를 제한(미지정=전체). entity_id 는
    search_objects/get_object 가 준 정수 id. 반환: {nodes:[...], edges:[...]}."""
    params: dict = {"depth": depth}
    if relations:
        params["relations"] = relations
    return await _get(ctx, f"/api/entities/{entity_id}/graph", params)


@mcp.tool()
async def ask_ontology(query: str, ctx: Context, max_hops: int = 6) -> dict:
    """**질문을 통째로 위임**한다 — 서버가 온톨로지+보고서를 다단계 조사해 답한다.
    → 직접 단계별로 파고들 거면 `list_object_types`→`search_objects`→`get_object`.
    느리고 AI 권한이 필요하니, 스스로 조사할 수 있으면 그쪽이 낫다.
    근거와
    함께 답한다(위임). 세밀한 제어 없이 완결 답변이 필요할 때 쓴다 — 직접 단계별로
    조사하려면 list_object_types/search_objects/get_object 를 쓰라.
    반환: {answer, citations(보고서), objects(근거 객체), trace(추론과정), no_evidence}.
    주의: 서버 내부 LLM을 쓰며 다단계라 느릴 수 있고, 'rag_qa' AI 권한이 필요하다."""
    return await _post(ctx, "/api/ai/agent", {"query": query, "max_hops": max_hops})


# --------------------------------------------------------------------------- #
# 온톨로지 쓰기 — 기준정보(객체·별칭·관계)를 채운다. **시스템 관리자 전용.**
# 이 MCP 를 등록한 토큰이 시스템 관리자 계정의 것이어야 동작한다(그 외 403).
# 스키마(축·속성정의)는 못 바꾸고 인스턴스만 다룬다. 쓰기 전에 반드시 먼저
# list_object_types 로 축 slug·속성 key·관계 slug 를 확인하고, search_objects/
# get_object 로 이미 있는지·대상 id 를 확인하라(멱등이지만 중복 확인이 안전).
# --------------------------------------------------------------------------- #
async def _ontology_write(ctx, name, args):
    return await _post(ctx, "/api/ai/ontology/write", {"name": name, "args": args})


@mcp.tool()
async def create_object(
    ctx: Context,
    type_slug: str,
    value: str,
    code: str | None = None,
    description: str | None = None,
    properties: dict | None = None,
) -> dict:
    """**[시스템 관리자 전용]** 기준정보 객체(온톨로지 엔티티)를 만든다. 같은 이름/코드가
    이미 있으면 새로 만들지 않고 기존 객체를 돌려준다(멱등 upsert). closed 축·형식패턴·
    속성 스키마를 위반하면 error 로 알려주니 그에 맞춰 고쳐 다시 호출하라.
      - type_slug: 객체 종류(축) slug (list_object_types 참고).
      - value: 객체 이름(대표 표기). code: 안정 식별자(ERP 코드 등, 선택).
      - properties: 축 속성 {key: value} — 정의된 key·데이터타입만(list_object_types 확인).
    반환: {created(신규면 true), object:{id,value,type_slug,code,properties,...}} 또는 {error}."""
    args = {
        "type_slug": type_slug, "value": value, "code": code,
        "description": description, "properties": properties,
    }
    return await _ontology_write(
        ctx, "create_object", {k: v for k, v in args.items() if v is not None}
    )


@mcp.tool()
async def update_object(
    ctx: Context,
    object_id: int,
    value: str | None = None,
    code: str | None = None,
    description: str | None = None,
    properties: dict | None = None,
) -> dict:
    """**[시스템 관리자 전용]** 기존 기준정보 객체를 수정한다. 넘긴 필드만 바뀐다.
    properties 는 통째로 교체되니(부분병합 아님) 기존 값에 더하려면 get_object 로 현재
    속성을 읽어 합쳐서 보내라. object_id 는 search_objects/get_object 가 준 정수 id.
      - value: 이름 변경(같은 축 중복이면 error). code: 안정 식별자. properties: 축 속성 전체.
    반환: {updated:true, object:{...}} 또는 {error}."""
    args = {
        "object_id": object_id, "value": value, "code": code,
        "description": description, "properties": properties,
    }
    return await _ontology_write(
        ctx, "update_object", {k: v for k, v in args.items() if v is not None}
    )


@mcp.tool()
async def add_object_alias(ctx: Context, object_id: int, alias: str) -> dict:
    """**[시스템 관리자 전용]** 객체에 별칭(다른 표기)을 단다 — 이후 그 표기로 검색·매칭이
    같은 객체로 흡수된다(중복 예방). 같은 축의 다른 값과 충돌하면 error. object_id 는
    search_objects/get_object 가 준 정수 id. 반환: {ok:true, object_id, alias} 또는 {error}."""
    return await _ontology_write(
        ctx, "add_object_alias", {"object_id": object_id, "alias": alias}
    )


@mcp.tool()
async def link_objects(
    ctx: Context,
    src_id: int,
    dst_id: int,
    relation: str,
    properties: dict | None = None,
    evidence_report_id: int | None = None,
) -> dict:
    """**[시스템 관리자 전용]** 두 객체를 관계로 연결한다(src --relation--> dst). 같은 링크가
    있으면 멱등. 관계 종류·축 제약·순환 규칙을 위반하면 error(list_object_types 의
    relation_types 로 slug·허용 축 확인). src_id/dst_id 는 정수 객체 id.
      - relation: 관계 종류 slug (예: part_of). properties: 관계 속성(정의된 경우).
      - evidence_report_id: 이 관계의 근거 보고서 id(선택, provenance).
    반환: {ok:true, src_id, dst_id, relation} 또는 {error}."""
    args = {
        "src_id": src_id, "dst_id": dst_id, "relation": relation,
        "properties": properties, "evidence_report_id": evidence_report_id,
    }
    return await _ontology_write(
        ctx, "link_objects", {k: v for k, v in args.items() if v is not None}
    )


@mcp.tool()
async def upload_from_url(ctx: Context, url: str, filename: str | None = None) -> dict:
    """**웹 URL** 의 파일을 서버가 직접 받아 저장한다(권장 경로).
    → 로컬 파일은 `prepare_upload`, 작은 이미지만 최후수단으로 `upload_file`.
    **file_id** 를 돌려준다
    (바이트가 모델/클라이언트를 안 거쳐 크기·화질 제약 없음). 공개 http/https URL 만
    되고 사설·내부 주소는 차단된다. 받은 file_id 를 image / attachment / video / cad_3d
    위젯 content 에 넣어 파일 위젯을 만든다.

    반환: `{ id(=file_id), filename, mime_type, size, ... }`. 실패 시 `{error}`.
    예) 이미지 위젯: extra_blocks=[{"id":"img","type":"image","props":{"max_count":1},
        "content":{"files":[{"file_id":"<반환된 id>"}]}}]

    ※ **웹 URL 전용**입니다. 사용자 PC 의 로컬 파일은 이 도구로 못 올립니다 — 셸을
    쓸 수 있는 CLI(Claude Code 등)면 `prepare_upload` 로 직접 올리고, PPT 속 그림은
    올린 뒤 `extract_pptx_images` 로 분해하세요. 둘 다 안 되는 환경이면 사용자가 웹
    UI 에서 직접 추가."""
    body: dict = {"url": url}
    if filename:
        body["filename"] = filename
    return await _post(ctx, "/api/files/from-url", body)


@mcp.tool()
async def upload_file(
    ctx: Context, filename: str, data_base64: str, mime_type: str | None = None
) -> dict:
    """⚠️ **최후수단** — 로컬 **작은 이미지**를 base64 로 받아 저장하고 **file_id** 를
    돌려준다. base64 바이트가 **모델 출력 토큰을 그대로 소모**하고 ≈256KB 상한이 걸려
    있으므로, 로컬 파일이면 대부분 아래를 **먼저** 써라:
      - **셸(Bash)을 쓸 수 있으면(Claude Code 등) → `prepare_upload`** — 바이트가 모델을
        안 거쳐 토큰 소모·크기 제약이 없다. **로컬 파일 업로드의 기본 경로.**
      - 웹 URL 이면 → `upload_from_url`(서버가 직접 다운로드).
      - PPT 안의 그림들은 PPT 를 먼저 올린 뒤 → `extract_pptx_images`.
    이 도구는 **셸을 못 쓰는 클라이언트가 이미 소용량 이미지 바이트를 손에 쥔** 좁은
    경우에만 쓴다(예: filesystem MCP 로 읽은 작은 png). 그 외엔 위 경로가 항상 낫다.
    받은 file_id 는 image/attachment 위젯 content 에 넣는다.

    인자: filename(확장자 포함), data_base64(파일 바이트의 base64), mime_type(선택,
    미지정 시 서버가 확장자로 추정). 반환: `{ id(=file_id), filename, mime_type, size, ... }`.
    예) 이미지 위젯: extra_blocks=[{"id":"img","type":"image","props":{"max_count":1},
        "content":{"files":[{"file_id":"<반환된 id>"}]}}]"""
    try:
        raw = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError):
        return {"error": "data_base64 가 올바른 base64 가 아닙니다."}
    if not raw:
        return {"error": "빈 파일입니다."}
    if len(raw) > _UPLOAD_BASE64_MAX_BYTES:
        return {
            "error": (
                f"파일이 너무 큽니다({len(raw) // 1024}KB). base64 업로드는 "
                f"{_UPLOAD_BASE64_MAX_BYTES // 1024}KB 이하만 됩니다 — 로컬 파일은 "
                "prepare_upload(셸 curl), 웹 URL 은 upload_from_url, PPT 는 먼저 올린 뒤 "
                "extract_pptx_images 로 분해하세요."
            )
        }
    import mimetypes as _mt

    mime = mime_type or _mt.guess_type(filename)[0] or "application/octet-stream"
    return await _post_multipart(
        ctx, "/api/files", filename=filename, content=raw, mime_type=mime
    )


@mcp.tool()
async def download_file(ctx: Context, file_id: str) -> dict:
    """저장된 파일(이미지/첨부)의 **바이트를 base64 로 내려받는다**. 보고서를
    `get_report` 로 조회하면 이미지·첨부는 실제 바이트가 아니라 **file_id 참조**만
    들어 있는데, 그 file_id 를 이 도구에 넘기면 실제 내용을 받아 로컬에 저장하거나
    문서에 넣을 수 있다.

    반환(성공): `{ file_id, filename, mime_type, size, is_image, encoding:"base64",
    data_base64 }`. 로컬에 저장하려면 `data_base64` 를 디코드해 `filename` 으로
    쓴다(예: 파이썬 `open(filename,"wb").write(base64.b64decode(data_base64))`).

    ⚠️ base64 바이트가 **모델 입력 토큰을 그대로 소모**하므로 큰 파일은 막혀 있다
    (기본 ≈1MB 초과 시 바이트 없이 `{file_id, filename, mime_type, size, error}` 만
    반환). 큰 파일은 웹 UI 에서 직접 내려받아야 한다. 파일이 없거나 권한이 없으면
    `{error}`."""
    meta = await _get(ctx, f"/api/files/{file_id}/meta")
    if isinstance(meta, dict) and meta.get("error"):
        return meta
    filename = meta.get("filename") or file_id
    mime = meta.get("mime_type") or "application/octet-stream"
    size = meta.get("size")
    if isinstance(size, int) and size > _DOWNLOAD_BASE64_MAX_BYTES:
        return {
            "file_id": file_id,
            "filename": filename,
            "mime_type": mime,
            "size": size,
            "error": (
                f"파일이 너무 큽니다({size // 1024}KB). base64 다운로드는 "
                f"{_DOWNLOAD_BASE64_MAX_BYTES // 1024}KB 이하만 됩니다 — 큰 파일은 "
                "웹 UI 에서 직접 내려받으세요."
            ),
        }
    # 실제 바이트는 표준 envelope 이 아니라 FileResponse(raw) 로 오므로 _get(=_unwrap)
    # 를 못 쓴다. 원시 GET 으로 .content 를 받는다.
    async with httpx.AsyncClient(base_url=API_BASE, timeout=120) as client:
        r = await client.get(
            f"/api/files/{file_id}", headers=_forward_headers(ctx)
        )
    if r.status_code >= 400:
        try:
            body = r.json()
            msg = body.get("message") or f"HTTP {r.status_code}"
        except Exception:
            msg = f"HTTP {r.status_code}"
        return {"error": msg, "status": r.status_code}
    raw = r.content
    # 메타 size 를 못 믿는 경우(스트리밍 등) 대비해 실제 길이로 한 번 더 방어.
    if len(raw) > _DOWNLOAD_BASE64_MAX_BYTES:
        return {
            "file_id": file_id,
            "filename": filename,
            "mime_type": mime,
            "size": len(raw),
            "error": (
                f"파일이 너무 큽니다({len(raw) // 1024}KB). "
                f"{_DOWNLOAD_BASE64_MAX_BYTES // 1024}KB 이하만 base64 로 받을 수 있습니다."
            ),
        }
    return {
        "file_id": file_id,
        "filename": filename,
        "mime_type": mime,
        "size": len(raw),
        "is_image": bool(meta.get("is_image")),
        "encoding": "base64",
        "data_base64": base64.b64encode(raw).decode("ascii"),
    }


@mcp.tool()
async def extract_pptx_images(ctx: Context, file_id: str) -> dict:
    """이미 올린 **.pptx** 에서 슬라이드 속 그림들을 **각각 별도 이미지로 추출**해
    새 file_id 목록을 돌려준다. PPT 한 장을 통째 올린 뒤(예: `upload_from_url` 로
    웹의 pptx 를 받거나, 사용자가 올려둔 pptx 의 file_id) 그 안의 그림을 image
    위젯으로 붙일 때 쓴다. 서버가 zip 으로 풀어 처리하므로 바이트가 모델을 안 거친다.

    인자: file_id(올려둔 .pptx 의 id). 반환: `{ source_file_id, images:[{id,filename,
    mime_type,size,...}], extracted, skipped_oversize, skipped_over_limit }`.
    images 의 각 id 를 image 위젯 files 에 차례로 넣으면 된다."""
    return await _post(ctx, f"/api/files/{file_id}/extract-images", {})


@mcp.tool()
async def prepare_upload(ctx: Context, local_path: str | None = None) -> dict:
    """**로컬 파일을 셸에서 직접 업로드**할 준비물(업로드 URL + 단기 티켓)을 발급한다.
    Claude Code 처럼 셸(Bash)을 쓰는 CLI 에서 **PC 의 큰 파일·PPT** 를 올릴 때 쓴다 —
    base64 와 달리 **바이트가 모델을 안 거치므로** 크기 제약이 사실상 없다.

    흐름:
      1) 이 도구를 호출 → `{upload_url, ticket, curl, ...}` 를 받는다.
      2) 반환된 `curl` 명령(또는 아래 형식)을 **셸에서 실행**해 파일을 올린다:
         `curl -X POST '<upload_url>?filename=<파일명>' -H 'X-Upload-Ticket:<ticket>' --data-binary @<로컬경로>`
         → 성공 시 `{ id(=file_id), ... }` 가 출력된다.
      3) 그 file_id 를 image/attachment 위젯에 넣거나, .pptx 면 `extract_pptx_images`
         로 슬라이드 그림들을 분해한다.

    `local_path` 를 주면 그 경로를 채운 **바로 실행 가능한** curl 을 만들어 준다.
    티켓은 약 5분 후 만료된다(만료되면 다시 호출). 작은 이미지 한 장이면 이 절차
    없이 `upload_file`(base64)로 더 간단히 올릴 수도 있다."""
    res = await _post(ctx, "/api/files/upload-ticket", {})
    if isinstance(res, dict) and res.get("error"):
        return res
    ticket = res.get("ticket")
    base = _public_base(ctx)
    upload_url = f"{base}{_UPLOAD_ROUTE}"
    if local_path:
        from pathlib import PurePath

        fn = PurePath(local_path).name or "upload.bin"
        curl = (
            f"curl -sS -X POST '{upload_url}?filename={fn}' "
            f"-H 'X-Upload-Ticket: {ticket}' --data-binary @{local_path}"
        )
    else:
        curl = (
            f"curl -sS -X POST '{upload_url}?filename=<파일명>' "
            f"-H 'X-Upload-Ticket: {ticket}' --data-binary @<로컬경로>"
        )
    return {
        "upload_url": upload_url,
        "ticket": ticket,
        "expires_in_seconds": res.get("expires_in_seconds", 300),
        "curl": curl,
        "next": "위 curl 을 실행해 받은 file_id 를 위젯에 넣거나, .pptx 면 extract_pptx_images 에 전달.",
    }


@mcp.tool()
async def create_report_draft(
    template_id: str,
    template_version: int,
    title: str,
    blocks: dict,
    ctx: Context,
    extra_blocks: list | None = None,
    block_sections: dict | None = None,
    pages: list | None = None,
    report_date: str | None = None,
    tags: list | None = None,
    report_type_id: int | None = None,
    entity_ids: list | None = None,
) -> dict:
    """보고서를 **새로** 만든다(초안). 이미 있는 보고서 수정은 `update_report_draft`.
    → 먼저 `list_templates` → `describe_template` 로 채울 블록을 확인하라.
    `blocks` 는 block_id→내용(describe_template 참고).
    **AI 가 채운 위젯만** 보이고(빈 템플릿 블록은 자동 숨김), 레이아웃은 서버가 자동 배치한다.

    `extra_blocks`: 템플릿에 없는 위젯을 **직접 만들어** 추가할 때(특히 **빈 템플릿**으로
    처음부터 짤 때). 각 항목은 `{"id","type","props"?,"content"}`:
      - type: heading/rich_text/bulleted_list/key_value/table/chart/pie/progress_bar/
              milestone/flowchart/equation 등(content 형식은 describe_template/스킬 참고).
      - props: 표·차트처럼 열 정의가 필요한 위젯만(예 table: {"columns":[{key,label,type}]}).
      - content: 느슨하게 줘도 정규화됨.
    예: [{"id":"h","type":"heading","content":{"text":"제목"}},
         {"id":"t","type":"table","props":{"columns":[{"key":"a","label":"A","type":"text"}]},
          "content":[{"a":"값"}]}]

    `block_sections`: 단락 구분 — `{block_id: section_code}`. code 는 describe_template 의
    `section_taxonomy` 에 있는 값만 쓴다(라벨/한글 금지, 적절한 게 없으면 생략). 보고서에서
    블록마다 단락 색상 칩으로 표시된다.

    `pages`: 여러 페이지로 만들 때. 각 항목 `{"name"?, "blocks"?, "extra_blocks"?, "block_sections"?}`
    — 모두 같은 template 을 쓴다. `pages` 를 주면 위 `blocks`/`extra_blocks`/`block_sections` 는
    무시되고 페이지별로 채운다. 한 장이면 `pages` 없이 위 필드만 쓴다.

    메타데이터(선택): `report_date`(YYYY-MM-DD, 보고 일자 — 생략 시 오늘),
    `tags`(자유 문자열 태그 목록), `report_type_id`(보고서 유형 id), `entity_ids`(모델/
    단계/부품 등 축 태그 id 목록). 유효한 report_type_id / entity_ids 는
    `describe_metadata` 로 먼저 조회해 고른다(이름을 임의로 넣지 말 것).

    내용은 느슨하게 줘도 서버가 정규화·검증한다. 검증 실패 시 결과의 `error`/`warnings` 를
    보고 고쳐 다시 호출하라. 성공하면 `url` 로 사람이 검토."""
    body: dict = {
        "template_id": template_id,
        "template_version": template_version,
        "title": title,
        "blocks": blocks,
        "extra_blocks": extra_blocks or [],
        "block_sections": block_sections or {},
        "pages": pages or [],
    }
    if report_date is not None:
        body["report_date"] = report_date
    if tags is not None:
        body["tags"] = tags
    if report_type_id is not None:
        body["report_type_id"] = report_type_id
    if entity_ids is not None:
        body["entity_ids"] = entity_ids
    return await _post(ctx, "/api/reports/ai-draft", body)


@mcp.tool()
async def update_report_draft(
    report_id: int,
    ctx: Context,
    title: str | None = None,
    blocks: dict | None = None,
    extra_blocks: list | None = None,
    block_sections: dict | None = None,
    remove_blocks: list | None = None,
    page: int = 1,
    pages: list | None = None,
    report_date: str | None = None,
    tags: list | None = None,
    report_type_id: int | None = None,
    entity_ids: list | None = None,
    dry_run: bool = False,
) -> dict:
    """**기존 보고서를 이어서 수정**한다. 초안뿐 아니라 **이미 게시(mount)된 글도**
    고칠 수 있다 — 편집 권한이 있고 **발행(finalized) 전**이면 된다(웹 편집과 같은
    규칙). 발행본은 사람이 '발행 취소' 한 뒤에야 수정된다. report_id 를 모르면
    `list_my_reports` 로 찾는다(각 행의 `editable` 이 수정 가능 여부).

    ※ **게시된 글은 이미 남들이 보고 있다.** 응답의 `mounted_to`(게시판·폴더)가
    비어 있지 않으면, 어디에 게시된 글을 고쳤는지 **반드시 사용자에게 알려라**.

    ※ `dry_run=True` 면 **저장하지 않고** 무엇이 바뀔지만 돌려준다(페이지별 추가·
    변경·삭제될 block_id, 메타 변경, 경고, 게시 위치). 게시된 글이나 큰 수정 전에
    한 번 확인하고 적용하라. 잘못 고쳤으면 `list_versions` → `restore_version`.

    기본은 **병합(merge)** — 준 것만 바꾸고 나머지는 그대로 둔다:
      - `blocks`: 덮어쓸 block_id→내용(create 와 같은 느슨한 형식). 안 준 블록은 유지.
      - `extra_blocks`: 같은 id 면 교체, 새 id 면 추가([{id,type,props?,content}]).
      - `remove_blocks`: 제거할 block_id 목록.
      - `block_sections`: 단락 갱신({block_id: section_code}); 빈/null 이면 단락 해제.
      - `title`: 주면 제목 변경.
      - `page`: 멀티페이지에서 병합 대상 페이지(1-base, 기본 1).
        **`page`=마지막+1 이면 새 페이지를 추가**한다(기존 페이지·레이아웃은 그대로 두고
        `blocks`/`extra_blocks` 로 채운 새 쪽을 뒤에 붙임).
    안 건드린 블록과 사람이 화면에서 맞춘 레이아웃은 유지된다(블록 구성이 바뀐 경우에만
    자동 재배치).

    `pages` 를 주면 **전체 교체** — 보고서를 그 페이지 목록으로 통째 다시 만든다
    (create 의 pages 와 같은 형식). 이땐 위 병합 필드는 무시된다.

    내용은 느슨하게 줘도 서버가 정규화·검증한다. 실패 시 `error`/`warnings` 를 보고 고쳐
    다시 호출하라. 성공하면 `url` 로 사람이 검토한다.

    ※ 누군가(본인 다른 탭 포함) 그 보고서를 **편집 화면에서 열어 두면**(편집 락) 수정이
    거부된다(에러에 현재 편집자 표시) — 사용자에게 편집 화면을 닫고 다시 요청하라고 안내하라.

    메타데이터(선택, 준 것만 변경): `report_date`(YYYY-MM-DD), `tags`(전체 교체),
    `report_type_id`, `entity_ids`(전체 교체 — `[]` 면 모든 축 태그 제거). 유효한 id 는
    `describe_metadata` 로 조회. 내용 없이 메타만 줘도 메타만 수정된다."""
    body: dict = {"page": page}
    if title is not None:
        body["title"] = title
    if pages is not None:
        body["pages"] = pages
    else:
        body["blocks"] = blocks or {}
        body["extra_blocks"] = extra_blocks or []
        body["block_sections"] = block_sections or {}
        body["remove_blocks"] = remove_blocks or []
    if report_date is not None:
        body["report_date"] = report_date
    if tags is not None:
        body["tags"] = tags
    if report_type_id is not None:
        body["report_type_id"] = report_type_id
    if entity_ids is not None:
        body["entity_ids"] = entity_ids
    if dry_run:
        body["dry_run"] = True
    return await _patch(ctx, f"/api/reports/{report_id}/ai-draft", body)


@mcp.tool()
async def append_rows(
    report_id: int,
    block_id: str,
    rows: list,
    ctx: Context,
    page: int = 1,
    expected_revision: int | None = None,
    dry_run: bool = False,
) -> dict:
    """표·차트 같은 위젯에 **행을 추가**한다(끝에 붙임).

    `update_report_draft(blocks=...)` 는 그 블록을 **통째로 교체**하므로 한 줄을
    넣으려 해도 전체를 다시 보내야 한다 — 여기선 **서버가 현재 값에 덧붙인다**.
    표가 클수록 이득이 크고, 읽고 쓰는 사이 사람이 고친 내용을 덮어쓸 위험도 없다.

    `rows` 는 그 위젯이 받는 행 형식 그대로(예: 표라면 `[{"열키": "값"}]`).
    형식이 헷갈리면 `get_report` 로 기존 행을 한두 개 보고 흉내내라.
    `expected_revision` 을 주면 그 사이 남이 고쳤을 때 거부된다(다시 읽고 재시도)."""
    return await _rows_op(
        ctx, report_id, page,
        [{"block_id": block_id, "op": "append", "rows": rows}],
        expected_revision, dry_run,
    )


@mcp.tool()
async def patch_cells(
    report_id: int,
    block_id: str,
    patches: list,
    ctx: Context,
    page: int = 1,
    expected_revision: int | None = None,
    dry_run: bool = False,
) -> dict:
    """표 같은 위젯의 **특정 셀만** 고친다. 나머지 행·열은 건드리지 않는다.
    → 행 번호를 모르면 `get_report` 로 현재 행을 먼저 확인하라(틀리면 엉뚱한 칸이 바뀐다).

    `patches` 는 `[{"row": 0, "key": "열키", "value": "새 값"}]` — `row` 는 **0부터**
    세는 행 번호다. 지금 값을 모르면 `get_report` 로 먼저 확인하라(행 번호가 틀리면
    엉뚱한 칸이 바뀐다).

    "3행 상태를 완료로" 처럼 **한두 칸만** 바꿀 때 쓴다. 표를 통째로 다시 쓸 거면
    `update_report_draft` 가 낫다."""
    return await _rows_op(
        ctx, report_id, page,
        [{"block_id": block_id, "op": "patch", "patches": patches}],
        expected_revision, dry_run,
    )


@mcp.tool()
async def remove_rows(
    report_id: int,
    block_id: str,
    indexes: list,
    ctx: Context,
    page: int = 1,
    expected_revision: int | None = None,
    dry_run: bool = False,
) -> dict:
    """표 같은 위젯에서 **행을 지운다**. `indexes` 는 **0부터** 세는 행 번호 목록.

    되돌리기 어려우므로 지우기 전에 `get_report` 로 **어느 행인지 확인**하고,
    여러 행을 지울 땐 `dry_run=True` 로 몇 개가 남는지 먼저 보라.
    잘못 지웠으면 `list_versions` → `restore_version`."""
    return await _rows_op(
        ctx, report_id, page,
        [{"block_id": block_id, "op": "remove", "indexes": indexes}],
        expected_revision, dry_run,
    )


async def _rows_op(ctx, report_id, page, ops, expected_revision, dry_run):
    body: dict = {"page": page, "ops": ops}
    if expected_revision is not None:
        body["expected_revision"] = expected_revision
    if dry_run:
        body["dry_run"] = True
    return await _patch(ctx, f"/api/reports/{report_id}/ai-draft/rows", body)


@mcp.tool()
async def list_versions(report_id: int, ctx: Context, limit: int = 20) -> dict:
    """보고서의 **수정 이력**(최신순). 잘못 고쳤을 때 되돌릴 지점을 찾는 데 쓴다.

    각 항목: version_id·revision·created_at·author·source·크기.
    `source` 는 그 버전이 생긴 경위 — `save`(사람이 저장) · **`mcp`(AI 가 수정)** ·
    `restore`(되돌리기) · `publish`(발행). 되돌리려면 `restore_version`.

    ※ 스냅샷은 **본문(페이지·내용·레이아웃)만** 담는다. 태그·게시 상태 같은
    메타데이터는 되돌려도 복원되지 않는다."""
    rows = await _get(ctx, f"/api/reports/{report_id}/versions", {"limit": limit})
    if isinstance(rows, dict):
        if rows.get("error"):
            return rows
        rows = rows.get("items") or []
    # 백엔드는 `id` 로 주지만 restore_version 인자명은 version_id 다. 그대로
    # 흘리면 모델이 report id 와 헷갈리므로 여기서 이름을 맞춘다(+ 불필요 필드 제거).
    return {
        "versions": [
            {
                "version_id": r.get("id"),
                "seq": r.get("seq"),
                "revision": r.get("revision"),
                "source": r.get("source"),
                "author": r.get("author_name"),
                "created_at": r.get("created_at"),
                "label": r.get("label"),
                "pinned": r.get("is_pinned"),
            }
            for r in rows
        ],
        "count": len(rows),
    }


@mcp.tool()
async def restore_version(report_id: int, version_id: int, ctx: Context) -> dict:
    """보고서를 그 시점 버전으로 **되돌린다**. `version_id` 는 `list_versions` 가 준 값.

    되돌리기 자체도 새 버전으로 남으므로(source=`restore`) **되돌리기의 되돌리기**도
    된다 — 잘못 되돌렸으면 다시 `list_versions` 에서 직전 버전을 고르면 된다.

    권한은 편집과 같다(작성자 또는 편집 권한자, 발행본은 발행 취소 후).
    되돌리기 전에 사용자에게 **어느 시점으로 되돌리는지 확인**받아라 —
    그 사이 사람이 고친 내용이 있으면 함께 사라진다."""
    return await _post(
        ctx, f"/api/reports/{report_id}/versions/{version_id}/restore", {}
    )


# 아웃오브밴드 업로드 프록시 — CLI 가 curl 로 보낸 바이트를 메모리에서 한 번에
# 들고 백엔드로 넘기므로(스트리밍 아님) 메모리 보호용 상한을 둔다. PPT·이미지엔
# 충분하고, 더 큰 파일(영상 등)은 웹 UI 로 유도한다.
_PROXY_MAX_BYTES = 100 * 1024 * 1024  # 100 MB


@mcp.custom_route(_UPLOAD_ROUTE, methods=["POST"])
async def _files_upload(request):
    """클라이언트(CLI 셸)가 로컬 파일을 raw 바디로 올리는 무인증 라우트 — 인증은
    헤더의 단기 **업로드 티켓**으로만 한다(prepare_upload 가 발급). 받은 바이트를
    백엔드 /api/files/upload-with-ticket 로 멀티파트로 넘기고 결과(file_id)를 그대로
    돌려준다. 바이트가 MCP 프로토콜/모델을 거치지 않는다."""
    from starlette.responses import JSONResponse

    ticket = request.headers.get("x-upload-ticket")
    if not ticket:
        return JSONResponse(
            {"error": "X-Upload-Ticket 헤더가 필요합니다(prepare_upload 로 발급)."},
            status_code=401,
        )
    filename = request.query_params.get("filename") or "upload.bin"
    clen = request.headers.get("content-length")
    if clen and clen.isdigit() and int(clen) > _PROXY_MAX_BYTES:
        return JSONResponse(
            {"error": f"파일이 너무 큽니다(최대 {_PROXY_MAX_BYTES // (1024 * 1024)}MB). 웹 UI 를 쓰세요."},
            status_code=413,
        )
    body = await request.body()
    if not body:
        return JSONResponse(
            {"error": "빈 본문입니다. --data-binary @<파일> 로 보내세요."},
            status_code=400,
        )
    if len(body) > _PROXY_MAX_BYTES:
        return JSONResponse({"error": "파일이 너무 큽니다."}, status_code=413)

    import mimetypes as _mt

    mime = _mt.guess_type(filename)[0] or "application/octet-stream"
    async with httpx.AsyncClient(base_url=API_BASE, timeout=300) as client:
        r = await client.post(
            "/api/files/upload-with-ticket",
            files={"file": (filename, body, mime)},
            data={"ticket": ticket},
        )
    try:
        payload = r.json()
    except Exception:
        return JSONResponse(
            {"error": f"백엔드 응답 오류 HTTP {r.status_code}"}, status_code=502
        )
    # 백엔드 표준 envelope({success,data,message})에서 data 만 꺼내 평평하게 돌려준다.
    out = payload.get("data", payload) if isinstance(payload, dict) else payload
    return JSONResponse(out, status_code=r.status_code)


if __name__ == "__main__":
    host = os.environ.get("MCP_HOST", "127.0.0.1")
    mcp.settings.host = host
    mcp.settings.port = int(os.environ.get("MCP_PORT", "3002"))

    # FastMCP 는 생성 시점(host=127.0.0.1)에 DNS rebinding 보호를 켜고
    # allowed_hosts 를 localhost(127.0.0.1:* / localhost:* / [::1]:*)로 고정한다.
    # 위에서 host 를 0.0.0.0 등으로 바꿔도 그 설정은 그대로라, 서버 IP·도메인으로
    # 들어온 Host 헤더가 거부돼 421 "Invalid Host header" 가 난다(외부 노출 시).
    # 비-localhost 바인딩이면 여기서 transport_security 를 다시 설정한다.
    if host not in ("127.0.0.1", "localhost", "::1"):
        from mcp.server.transport_security import TransportSecuritySettings

        allowed = [
            h.strip()
            for h in os.environ.get("MCP_ALLOWED_HOSTS", "").split(",")
            if h.strip()
        ]
        if allowed:
            # 권장: 허용할 Host 만 명시. 포트 와일드카드 가능.
            #   MCP_ALLOWED_HOSTS="mcp.example.com,mcp.example.com:*,10.0.0.5:3002"
            # nginx 리버스프록시면 proxy_set_header Host 로 넘어오는 값(도메인)을 넣는다.
            mcp.settings.transport_security = TransportSecuritySettings(
                enable_dns_rebinding_protection=True,
                allowed_hosts=allowed,
                allowed_origins=[],
            )
        else:
            # 미지정이면 보호를 끈다 — 인증은 PAT(백엔드가 검증), 망 보호는
            # nginx/방화벽에 맡기는 사내망 노출 시나리오. 외부망 노출 시엔
            # MCP_ALLOWED_HOSTS 를 지정해 보호를 유지하길 권장.
            mcp.settings.transport_security = TransportSecuritySettings(
                enable_dns_rebinding_protection=False,
            )

    mcp.run(transport="streamable-http")
