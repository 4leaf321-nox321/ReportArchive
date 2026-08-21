# ReportArchive MCP 서버

Claude(Claude Code/Desktop)에서 보고서를 검색·조회·작성(초안)하게 하는 MCP 서버.
백엔드와 의존성이 충돌해 **별도 venv·프로세스**로 돌리고, REST API 로 통신한다.

## 설치·실행
```bash
cd mcp_server
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
REPORTARCHIVE_API_BASE=http://localhost:3000 ./venv/bin/python server.py
# → streamable-http, 기본 http://127.0.0.1:3002/mcp
```

## Claude Code 등록 (사용자별 토큰)
```bash
claude mcp add --transport http reportarchive http://<host>:3002/mcp \
  --header "Authorization: Bearer <내 토큰>" \
  --header "X-Workspace-Slug: <부서slug>"
```
이후 Claude 에게 "리스크 보고서 초안 써줘" 라고 하면 `describe_template`→`create_report_draft`
로 시스템에 **초안**이 생성된다(사람이 검토 후 게시).

> **토큰 얻는 법**: 웹에 로그인한 뒤 개발자도구 → Application/Storage 의 JWT, 또는 관리자가 발급.
> (Phase 4 에서 "MCP용 개인 토큰 발급" 화면을 붙이면 더 편함.)

## 사용 안내는 서버가 준다 — 설치할 것 없음

MCP 를 등록했으면 끝이다. 사용 안내(도구 선택 표·각 절차·블록 형식)는 **서버가 쥐고**
(`guide/GUIDE.md`) `get_guide()` 도구로 내려준다. 이 도구의 설명 자체가 "작업 시작 전에
먼저 부르라"고 되어 있고, **도구 설명은 항상 모델에게 보이므로 아무것도 안 깔아도 된다.**

예전엔 안내 본문이 로컬 스킬 파일에 있어서 릴리스마다 각자 다시 복사해야 했다.
도구가 27→43개로 늘고 안내가 162줄 바뀐 릴리스에서 **복사 안 한 사람에겐 개선이
전혀 전달되지 않는** 문제가 드러나 본문을 서버로 옮겼다.

> 안내를 고칠 땐 저장소의 `mcp_server/guide/GUIDE.md` 를 고친다 — 배포하면 모두에게
> 즉시 반영된다. 서버가 매 호출마다 읽으므로 재시작도 필요 없다.

### (선택) 스킬 스텁

`skill/reportarchive/` 는 43줄짜리 **스텁**이다. 깔면 "보고서 관련 요청"에 Claude Code 가
이걸 먼저 띄워 `get_guide()` 호출을 한 번 더 밀어준다. **안 깔아도 동작한다** — 넛지가
조금 약해질 뿐이다.

```bash
mkdir -p ~/.claude/skills
cp -r skill/reportarchive ~/.claude/skills/reportarchive   # 선택. 한 번만.
```

스텁엔 안내 본문이 없으므로 **한 번 깔면 다시 복사할 일이 없다.**

## 도구
- **`get_guide(topic?)`** — 사용 안내(서버 최신본). 작업 시작 전에 먼저 부른다
- `list_templates` / `describe_template(template_id, version)`
- **찾기**: `search_reports(query, board?, folder?, …)` — 의미+키워드 검색(근거 발췌) /
  `list_reports(board?, folder?, author?, …)` — 조건으로 모아서 나열(최대 100건) /
  `aggregate_reports` — 개수
- **조직 어휘**: `list_boards()` — 게시판(조직) 목록 / `list_folders(board)` — 그 게시판 폴더
- `get_report(report_id)` — 상세(`mount_workspaces` 에 게시된 게시판·폴더)
- `list_my_reports(phase?)` — 내가 쓴 보고서(게시된 글 포함, `editable` 플래그)
- `download_file(file_id)` — 파일 바이트를 base64 로(get_report 의 이미지·첨부 로컬 저장, ≈1MB 이하)
- `create_report_draft(template_id, version, title, blocks)`  ← 핵심(초안 생성)
