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

## 작성 스킬 설치 (선택, 품질↑)
`skill/reportarchive/` 는 Claude 가 보고서를 **잘** 작성하게 돕는 Agent Skill 이다(블록 형식·
워크플로·에러 재시도 노하우). 각자 Claude Code 에 설치:
```bash
mkdir -p ~/.claude/skills
cp -r skill/reportarchive ~/.claude/skills/reportarchive
```
설치하면 "보고서 써줘" 류 요청에 자동 활성화되고, `/reportarchive` 로 직접 호출도 된다.
(스킬 없이도 MCP 도구만으로 동작은 하지만, 스킬이 있으면 형식 실수·재시도가 줄어든다.)

## 도구
- `list_templates` / `describe_template(template_id, version)`
- `search_reports(q)` / `get_report(report_id)`
- `download_file(file_id)` — 파일 바이트를 base64 로(get_report 의 이미지·첨부 로컬 저장, ≈1MB 이하)
- `create_report_draft(template_id, version, title, blocks)`  ← 핵심(초안 생성)
