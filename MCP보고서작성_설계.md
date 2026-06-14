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
[MCP 서버] 도구(8): list_templates / describe_template / describe_widgets / search_reports /
                     list_my_drafts / get_report / create_report_draft / update_report_draft
   │ ② 내부 호출(같은 사용자 권한)
   ▼
[ReportArchive 서비스/REST API]  validate_report_content → create_report
```

## 1. 핵심 설계 결정
- **권한·인증**: 각 사용자가 **자기 JWT**로 MCP 서버에 연결 → 서버가 그 사용자로 동작 → 기존 부서/작성권한 그대로. 만능 토큰 금지.
- **항상 초안(draft)**: AI 생성은 `phase=drafting` 으로만. 사람이 보고서 화면에서 검토·게시. (안전장치)
- **범위(현행)**: 템플릿 기존 블록 채움 **+ `extra_blocks` 로 위젯 직접 생성**(빈 템플릿으로 처음부터 짜기 가능),
  **멀티페이지(`pages`)**, **단락 구분(`block_sections`)** 지원. 정규화 위젯 11종
  (heading / rich_text / bulleted_list / key_value / table / chart / pie / progress_bar / milestone / flowchart / equation).
  파일 기반(image/attachment/CAD)·고급차트는 빈칸(작성자가 채움). *(초기 v1 은 텍스트 5종·extra_blocks 미사용이었음 — 확장됨.)*
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

`describe_template(template_id)` 가 각 블록의 id·type·라벨·필수여부 + 표/선택지의 **열키·라벨·옵션** + 위젯 상세 룰(`widget_rules`)·블록별 `example`·`section_taxonomy` 를 알려줘서, AI 가 무엇을 채울지 알게 한다.

> **확장 입력(현행)**: 위 `blocks`(기존 블록 채움) 외에 `create_report_draft` 는 다음을 받는다 —
> - `extra_blocks: [{id,type,props?,content}]` — 템플릿에 없는 위젯 직접 생성(빈 템플릿 작성). 룰은 `describe_widgets(types)`.
> - `block_sections: {block_id: section_code}` — 단락 구분(코드는 `section_taxonomy` 값만).
> - `pages: [{name?,blocks?,extra_blocks?,block_sections?}]` — 멀티페이지(주면 상단 단일 필드는 무시).

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
      "MCP 토큰" 카드(1회 노출·복사·바로 쓰는 `claude mcp add` 명령·목록·취소).
      통합테스트 2개 통과 + 라이브 서버 확인.
      → 접근성 개선: 카드를 프로필에서 **공통 · AI 설정 → "MCP 토큰" 탭**(`ai_settings/McpTab.jsx`)으로 이전.
        탭은 `useAuth()` 로 접속 본인 토큰만 노출(개인 단위 유지).
- [x] **위젯 타입 확대** — chart(막대/꺾은선)·pie·progress_bar·milestone·flowchart·equation 6종 정규화 추가
      (`ai_authoring.py`: chart 는 table 식 열매핑+숫자 강제, pie/progress 는 `{라벨:값}`·배열 둘 다, 한·영 키 별칭).
      파일 기반(image/attachment/cad)·고급차트(scatter/heatmap 등)는 폴백 유지(작성자가 채움). 단위테스트 +5 통과.
- [x] **예시(few-shot) 자동 생성** — `_example_for`/`build_example_input`: 템플릿의 실제 라벨·열키·옵션으로 블록별
      `example` + 전체 `example_input` 생성 → authoring-guide 응답·describe_template 로 노출. "예시는 검증 통과" 테스트로 보증.
- [x] **위젯 직접 생성(extra_blocks)** — `ai_authoring.normalize_extra_blocks`: 템플릿에 없는 위젯을 `{id,type,props?,content}`
      로 직접 정의해 추가(특히 **빈 템플릿**으로 처음부터 작성). ai-draft 가 정규화·검증해 본문에 합침.
- [x] **위젯 룰 단일소스 + `describe_widgets` 도구** — `/api/widgets/authoring-rules`(authoring_rules.json) 를 MCP 도구로 노출.
      describe_template 응답의 `widget_rules` 와 동일 소스. extra_blocks 로 만들 위젯 타입을 넣어 상세 룰을 받아 따름.
- [x] **AI 초안 자동 레이아웃 + 채운 위젯만 표시** — `ai_authoring.auto_layout`: 빈 템플릿 블록은 숨기고(blocks_order),
      채운 블록만 자동 배치(layout_overrides). AI 는 위치를 신경 쓰지 않아도 됨.
- [x] **멀티페이지(`pages`) + 단락 구분(`block_sections`)** — `pages=[{name?,blocks?,extra_blocks?,block_sections?}]` 로 여러 쪽,
      `block_sections={block_id:section_code}` 로 단락 색상 칩. code 는 `section_taxonomy`(taxonomy_for_ai) 의 값만 허용·검증.

### Phase 4 — 이어쓰기(편집) ✅
- [x] **`update_report_draft`(기존 초안 수정)** — `PATCH /api/reports/{id}/ai-draft`(`AiDraftUpdate`) + MCP 도구.
      **본인이 만든 `drafting` 상태만** 대상(소유자·단계 가드), 편집 락 없이(`require_lock=False`) 저장하고 버전 이력 남김.
      기본은 **병합** — `blocks`(덮어쓰기)·`extra_blocks`(id 교체/추가)·`remove_blocks`(제거)·`block_sections`(갱신/해제)·`title`·`page`(1-base).
      **`page`=마지막+1 이면 새 페이지 추가**(기존 페이지·레이아웃 그대로 두고 뒤에 붙임 — 실사용 중 발견한 갭 보완).
      안 건드린 블록과 수동 레이아웃 유지(블록 구성이 바뀐 경우에만 auto_layout 재배치). `pages` 주면 **전체 교체**.
      create 와 페이지 빌더(`_build_ai_page`) 공유 + 병합 전용 `_merge_ai_page`. 통합테스트 `test_ai_draft_update.py` 통과.
- [x] **`list_my_drafts`(내 초안 목록)** — `GET /api/reports/my-drafts` + MCP 도구. 내 `drafting` 보고서 최근 수정 순
      (report_id·title·template·page_count·url), 휴지통 제외. update 와 짝 — AI 가 이어 수정할 초안을 찾는 진입점.

### Phase 4 — 남은 항목
- [ ] **요청/길이 제한** — ai-draft 에 본문 크기·블록 수·페이지 수 상한 + 초과 시 명확한 400.
- [ ] **감사 표식/로그** — MCP 경유 생성·수정 식별(예: `created_via='mcp'`).
- [ ] (후순위) image 등 **파일 기반 위젯** — MCP 업로드는 난도 높음. 당장은 warnings 안내로 충분.

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
- **Phase 4 일부 완료** — 내 MCP 토큰 발급(p39 + pat.py + auth 분기 + /api/me/mcp-tokens + 카드). 통합테스트 2 통과·라이브 확인.
  토큰 카드는 접근성 위해 프로필 → 공통·AI 설정의 "MCP 토큰" 탭으로 이전(개인 단위 유지).
- **Phase 4 위젯 확대·few-shot 완료** — 차트/파이/진행률/마일스톤/순서도/수식 정규화 + 템플릿 맞춤 예시 자동생성
  (describe_template 에 `example`·`example_input` 노출). 변환기 테스트 10개 통과.
- **Phase 4 확장(v0.32~v0.36)** — 설계서 초안 범위를 넘어 실제로 더 나아감:
  - PAT(개인 액세스 토큰) 발급·MCP 토큰 탭(v0.32.1).
  - **AI 초안 자동 레이아웃 + 채운 위젯만 표시**, 위젯 정규화 확장(v0.33.0).
  - 외부 노출 시 Invalid Host header 수정(allowed_hosts/transport_security)(v0.34.1).
  - **`extra_blocks`(위젯 직접 생성) + `describe_widgets`(위젯 룰 단일소스) 도구**(v0.35.0) → MCP 도구 6개.
  - **멀티페이지(`pages`) + 단락 구분(`block_sections`)**(v0.36.0).
- **Phase 4 이어쓰기 완료** — `update_report_draft`(병합/추가/제거/전체교체) + `list_my_drafts`. 본인 `drafting` 만,
  편집 락 없이 저장·버전 이력 남김. 안 건드린 블록·수동 레이아웃 유지(구성 변화 시에만 재배치).
  create 와 `_build_ai_page` 공유 + `_merge_ai_page`. `test_ai_draft_update.py`(생성→목록→병합/추가/제거/단락/전체교체/가드) 통과.
  SKILL.md 도구 목록·이어쓰기 워크플로 보강.
- **현재 MCP 도구(8)**: list_templates / describe_template / describe_widgets / search_reports /
  **list_my_drafts** / get_report / create_report_draft / **update_report_draft**.
- 남은(선택): 요청/길이 제한, 감사 표식(`created_via`), image 등 파일 기반 위젯(후순위).
