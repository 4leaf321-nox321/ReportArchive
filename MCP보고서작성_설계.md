# Claude로 보고서 직접 작성 (MCP 서버 + AI 작성 포맷) · 진행 체크리스트

목표: 사용자가 **Claude(Claude Code/Desktop/claude.ai)** 에서 자연어로 요청하면 보고서가
**시스템에 바로(초안으로) 작성**되게 한다. 지금의 "프롬프트 복사→AI→결과 붙여넣기"를 직접
호출로 대체.

> 진행하며 체크박스 갱신. `[ ]` 미완 · `[x]` 완료 · `[~]` 진행중.

---

## 0. 메커니즘 정리 (오해 방지)
- **MCP 서버 = 연결**: 우리 REST API 를 도구(`create_report` 등)로 노출. Claude 가 이걸 호출해 시스템에 씀.
- **스킬 = 노하우**(선택): "어떤 템플릿으로, 이 형식으로 써라" 지식. 스킬 단독으론 외부 쓰기 불가 → MCP 도구를 씀.
- **AI 작성 포맷/변환기 = 핵심 난관**: 보고서 content 는 엄격한 widget-v1(템플릿이 블록·검증 잠금)이라,
  AI 가 임의 JSON 을 만들면 검증에서 떨어짐. **AI 의 느슨한 입력 → 정규화 → 검증 → 에러시 재시도**가 성패를 가름.

```
[사용자] Claude Code/Desktop/claude.ai
   │ ① MCP(claude mcp add, 사용자별 토큰)
   ▼
[MCP 서버] 도구: list_templates / describe_template / search_reports / get_report / create_report_draft
   │ ② 내부 호출(같은 사용자 권한)
   ▼
[ReportArchive 서비스/REST API]  validate_report_content → create_report
```

## 1. 핵심 설계 결정
- **권한·인증**: 각 사용자가 **자기 JWT**로 MCP 서버에 연결 → 서버가 그 사용자로 동작 → 기존 부서/작성권한 그대로. 만능 토큰 금지.
- **항상 초안(draft)**: AI 생성은 `phase=drafting` 으로만. 사람이 보고서 화면에서 검토·게시. (안전장치)
- **v1 범위**: 템플릿의 *기존 블록만* 채움(extra_blocks 미사용). 텍스트 위젯 5종 우선:
  heading / rich_text / bulleted_list / key_value / table. 차트·이미지 등은 빈칸(작성자가 채움).
- **느슨한 입력 → 정규화**: AI 가 문자열/라벨키 등으로 줘도 서버가 widget-v1 으로 변환. 그래도 안 맞으면
  `validate_report_content` 가 블록별 에러를 돌려 → Claude 가 고쳐 재호출.

## 2. AI 작성 입력 포맷 (변환기가 받는 형태)
```jsonc
{
  "title": "2026 2분기 리스크 보고",
  "blocks": {
    "<block_id>": <간이 콘텐츠>     // block_id 는 describe_template 가 알려준 값
  }
}
```
위젯별 간이 콘텐츠(관대하게 허용 → 정규화):
| 위젯 | AI 가 주는 형태(여러 형태 허용) | widget-v1 로 정규화 |
|---|---|---|
| heading | `"제목"` 또는 `{text}` | `{text}` |
| rich_text | `"문단"` / `["문단1","문단2"]` / `[{text,depth?}]` / `{items}` | `{items:[{depth,text}]}` |
| bulleted_list | `["항목1","항목2"]` / 줄바꿈 문자열 / `{items}` | `{items:[...]}` |
| key_value | `{필드키 또는 라벨: 값}` | 라벨→키 매핑 후 `{key: value}` |
| table | `[{열키 또는 라벨: 값}]` / `{rows}` | 라벨→열키 매핑 후 `{rows:[{col_key: value}]}` |

`describe_template(template_id)` 가 각 블록의 id·type·라벨·필수여부 + 표/선택지의 **열키·라벨·옵션**을 알려줘서, AI 가 무엇을 채울지 알게 한다.

---

## Phase 1 — 백엔드: AI 작성 변환기 (의존성 0, 테스트 가능) ✅
- [x] `app/modules/reports/ai_authoring.py`
  - [x] `build_authoring_guide(template_schema)` — 블록별 작성 안내(id·type·label·required + 표 columns/선택지 options·key_value fields)
  - [x] `normalize_content(template_schema, blocks_input) -> (content, warnings)` — 5종 위젯 정규화
        (heading 문자열, rich_text 문자열/배열/depth, bulleted 배열, key_value·table **라벨→키 매핑**),
        그 외 타입은 dict 그대로 통과, 못 맞춘 건 warnings
- [x] 단위 테스트 `tests/test_ai_authoring.py` **5개 통과** — 느슨한 AI 입력 → 정규화 → `validate_report_content` 통과,
      라벨↔키 혼용·미지정 필드/블록 무시(경고)·부분 draft 확인

## Phase 2 — MCP 서버 ✅
> ⚠ **발견:** 공식 `mcp` SDK 가 starlette 1.3/pydantic 2.13 으로 올려 **FastAPI 0.115 와 충돌**
> (같은 venv 불가). → MCP 서버를 **별도 프로세스·별도 venv**로 두고 백엔드와 **REST API** 통신.
> 스마트 로직은 백엔드 엔드포인트에 두고 MCP 서버는 얇은 프록시. (백엔드 venv 원복 완료)

- **2a 백엔드 엔드포인트(의존성 0):** ✅
  - [x] `GET /api/reports/authoring-guide?template_id=&template_version=` → `build_authoring_guide`
  - [x] `POST /api/reports/ai-draft` → `normalize_content` → `create_report`(검증 포함, **drafting**),
        실패 시 블록별 에러 400(AI 재시도용), 성공 시 report + warnings + url. (`AiDraftCreate` 스키마)
  - [x] TestClient 검증: authoring-guide 200, ai-draft 201 초안 생성·정리. 기존 테스트 회귀 없음.
- **2b MCP 서버(`mcp_server/`, 격리 venv):** ✅
  - [x] `server.py` (FastMCP) 도구 5개: `list_templates`/`describe_template`/`search_reports`/
        `get_report`/`create_report_draft`
  - [x] 인증: 들어온 `Authorization`/`X-Workspace-Slug` 헤더를 `ctx.request_context.request` 에서 읽어
        백엔드로 **그대로 전달**(사용자별 권한). `ctx` 는 도구 입력 스키마에서 자동 제외.
  - [x] `requirements.txt`(mcp+httpx) + `README.md`(설치·`claude mcp add` 등록법). venv gitignore 추가.
  - [x] 도구 등록·스키마 확인(격리 venv). 전 구간 런타임(Claude Code→MCP→백엔드)은 사용자가 두 서버 띄워 확인.

## Phase 2.5 — 운영 배포 통합 (A안) ✅
- [x] `deploy/reportarchive-mcp.service.template` — MCP systemd 유닛(@@USER@@/@@INSTALL_DIR@@/@@API_BASE@@/@@MCP_HOST@@/@@MCP_PORT@@)
- [x] `deploy.sh` — `setup_mcp()`(소스 배치 + venv 생성 + **오프라인 휠 설치** + 유닛 기동), `install`/`update` 에 연결,
      `prepare` 에 `python3-venv python3-pip` 추가. 전부 **비치명적**(실패해도 백엔드 배포 무관). `MCP_ENABLED/HOST/PORT/API_BASE` env 로 제어.
- [x] `build_bundle.sh` — 번들에 `mcp_server/` + **vendored wheels**(`pip download --only-binary`) 동봉 → airgap 운영서버도 설치 가능
- [x] 검증: bash 문법 OK + 빌드머신에서 휠 29개 동봉 + 격리 venv **오프라인 설치/import 성공**
- [x] `README_OPERATOR.md` MCP 운영 섹션(상태·끄기·노출·사용자 등록)
- ⇒ **`sudo ./deploy.sh update` 한 번으로 MCP venv 생성·pip 설치·서비스 갱신까지 자동.**

## Phase 3 — 스킬 + 클라이언트 가이드 ✅
- [x] `mcp_server/skill/reportarchive/SKILL.md` — Agent Skill. `description`(한글 트리거로 자동활성)
      + `allowed-tools: mcp__reportarchive__*`. 워크플로(list→describe→draft→에러 재시도→url),
      **blocks 작성 형식표**(위젯별 느슨한 입력), 원칙(항상 초안·추측 금지·부분초안), 예시.
- [x] 사용자 설치 안내(`~/.claude/skills/` 복사) + `claude mcp add` 등록 + 토큰 얻는 법 → `mcp_server/README.md`
- [x] `build_bundle.sh` 가 스킬도 번들에 동봉
- [x] 검증: SKILL.md frontmatter YAML 파싱·필드 OK, 도구 5개 `mcp__reportarchive__*` 정확 참조, 디렉터리=`/reportarchive`

## Phase 4 — 하드닝
- [x] **내 MCP 토큰 발급 화면** — 개인 액세스 토큰(`rat_…`, sha256 해시 저장, 취소·만료 가능).
      마이그레이션 p39 + `PersonalAccessToken` 모델 + `users/pat.py`(발급/검증/취소) +
      auth `_resolve_user_from_token` 에 PAT 분기(접두사로 JWT 와 구분) + `/api/me/mcp-tokens`(GET/POST/DELETE) +
      ProfilePage "MCP 토큰" 카드(1회 노출·복사·바로 쓰는 `claude mcp add` 명령·목록·취소).
      통합테스트 2개 통과 + 라이브 서버 확인.
- [ ] 위젯 타입 확대(차트/이미지 일부), `update_report_draft`(기존 보고서 수정)
- [ ] 예시(few-shot) 자동 생성, 길이/요청 제한, 감사 로그

## 3. 주의 (정직하게)
- **유효 content 생성**이 진짜 난관 → 정규화 + 검증 + 재시도 루프로 흡수(Phase 1·2).
- **인증/권한**: 사용자별 토큰, 기존 권한 적용.
- **망 도달성**: claude.ai 웹은 인터넷 도달 필요. 사내 방화벽이면 Claude Code/Desktop + 사내 MCP 서버.
- 메모리의 "AI-friendly report JSON 포맷 보류"가 바로 이 작업 — 여기서 구체화.

---

## 진행 로그
- (작성) 설계 확정.
- **Phase 1 완료** — AI 작성 변환기(`ai_authoring.py`) + 테스트 5개 통과. 핵심 난관(느슨한 AI 입력 →
  유효 widget-v1)을 해결. 이 변환기는 MCP·Agent SDK·기존 프롬프트 어디서든 재사용 가능.
- **Phase 2 완료** — (2a) 백엔드 endpoint 2개(authoring-guide, ai-draft) + (2b) 격리 venv MCP 서버 5도구.
  핵심 교훈: mcp SDK ↔ FastAPI 의존성 충돌 → **별도 프로세스 + REST 통신** 구조로 해결(백엔드 venv 원복).
- **Phase 2.5 완료** — 운영 배포 통합(deploy.sh setup_mcp + 오프라인 휠 + systemd). `deploy.sh update` 가 MCP 까지 자동.
- **Phase 3 완료** — 작성 스킬(SKILL.md) + 사용자 설치/등록 가이드 + 번들 동봉.
- **E2E 확인됨** — 사용자가 프로필에서 토큰 셀프발급 → Claude Code 등록 → `list_templates`(부서 스코프 적용) 성공.
- **Phase 4 일부 완료** — 내 MCP 토큰 발급(p39 + pat.py + auth 분기 + /api/me/mcp-tokens + 프로필 카드). 통합테스트 2 통과·라이브 확인.
- 남은(선택): 쓰기 경로(create_report_draft) 사용자 직접 확인, `update_report_draft`(기존 보고서 수정), 위젯 확대, 감사로그.
