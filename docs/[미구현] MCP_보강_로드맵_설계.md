# MCP(AI 연결) 보강 로드맵 — 설계

> 상태: **Phase A·B·C 구현 완료 (2026-08-21) · D 미구현** · 2026-08-21 작성
> 관련: `[완료] MCP보고서작성_설계.md`(본체·Phase 1~6), `[완료] MCP온톨로지조사_설계.md`,
> `[미구현] 헤드리스_내보내기_설계.md`, `[완료] 버전관리_설계.md`, `[완료] 협업개선_설계.md`

---

## 0. 한 줄 요약

MCP 도구는 27개로 **찾기·읽기·쓰기·온톨로지·파일**까지 섰다. 남은 공백은 기능 목록이
아니라 **"AI가 사람처럼 일하려면 있어야 하는데 없는 것"** 이다 — ① 되돌릴 수단 ②
사람과 주고받을 통로 ③ 한 줄만 고치는 능력 ④ 자기 결과물을 확인할 눈.
**새 엔진은 만들지 않는다. 네 갈래 모두 백엔드 API가 이미 있고, MCP 노출과 얇은
어댑터가 대부분이다.**

---

## 1. 왜 지금인가 — 오늘 생긴 비대칭

Phase 6(2026-08-21)에서 **게시된 글도 AI가 고칠 수 있게** 열었다. 운영 기준 살아있는
보고서의 76%가 게시 상태이므로, AI의 수정 사정거리가 23% → 100% 로 넓어졌다.

그런데 **되돌릴 수단은 주지 않았다.** 버전 이력은 쌓이지만 MCP 에 목록·복원 도구가
없어, AI 가 잘못 고치면 사람이 웹에 들어가 복구해야 한다. 게다가 `report_versions.source`
는 `save|restore|publish` 뿐이라 **AI 가 고친 건지 사람이 고친 건지 구분도 안 된다.**

⇒ **권한을 넓혔으면 안전망이 먼저다.** 이 로드맵이 Phase A 를 안전망으로 시작하는 이유.

---

## 2. 설계 원칙

- **재사용 우선** — 신규 백엔드 엔진 0. 댓글·알림·버전·종합보고 API 는 **전부 이미 있다**.
  MCP 는 호출만 하고, 스마트 로직이 필요하면 백엔드에 얇은 전용 엔드포인트를 둔다
  (`/api/reports/browse` 가 그 선례).
- **사용자 권한 그대로** — MCP 는 호출자의 토큰을 전달한다. 새 도구도 만능 토큰을 만들지
  않는다. 댓글·알림은 그 사용자가 볼 수 있는 것만 보인다.
- **모르면 멈춘다** — 이름을 못 풀거나 대상이 모호하면 **조용히 넓히지 말고 에러**.
  (Phase 6 의 board/folder 이름 해석 원칙과 동일 — 조건이 빠진 전체 결과를 그 조직 것으로
  오해하는 사고를 막는다.)
- **토큰 예산 의식** — 도구 반환은 모델 입력 토큰을 먹는다. 열거는 요약 필드,
  본문 왕복은 최소화(Phase C 의 존재 이유), 큰 바이트는 out-of-band.
- **파괴적 동작엔 미리보기** — 되돌리기 어려운 조작은 `dry_run` 을 먼저 제공한다.

---

## 3. 지금 도구 지도와 빠진 축

| 축 | 있는 것 | 빠진 것 |
|---|---|---|
| 작성 가이드 | list_templates·describe_template·describe_widgets·describe_metadata | — |
| 찾기 | search_reports·list_reports·list_boards·list_folders·aggregate_reports·get_report·list_my_reports | 대화형 후속질문 |
| 온톨로지 | list_object_types·search_objects·get_object·get_subgraph·ask_ontology·(쓰기 4종) | — |
| 파일 | upload_from_url·upload_file·download_file·extract_pptx_images·prepare_upload | 완성본(export) 파일 |
| 쓰기 | create_report_draft·update_report_draft | **부분 수정·되돌리기·미리보기** |
| **협업** | **없음** | **댓글·알림·종합보고** |
| **자기 점검** | **없음** | **렌더 결과 확인** |

---

## Phase A — 안전망 (권한을 넓혔으니 먼저)

> 목표: AI 가 잘못 고쳐도 **AI 스스로 되돌릴 수 있고**, 나중에 **누가 고쳤는지 추적**된다.

- [x] **`list_versions(report_id, limit)`** — `GET /api/reports/{id}/versions` 노출.
      반환: `[{version_id, revision, created_at, author, source, size}]`. 백엔드 작업 0.
- [x] **`restore_version(report_id, version_id)`** — `POST .../versions/{vid}/restore` 노출.
      복원도 새 버전을 남기므로(source='restore') 되돌리기의 되돌리기도 된다.
- [x] **감사 표식 `source='mcp'`** — `report_versions.source` 는 `String(16)` 자유값이라
      **마이그레이션 불필요**. `_apply_ai_draft` 가 스냅샷을 만들 때 `mcp` 로 표시.
      웹 버전 이력 UI 에 "AI 수정" 배지. ※ 사람이 웹에서 고친 것과 구분되는 게 핵심.
- [x] **`update_report_draft(dry_run=True)`** — 적용하지 않고 **무엇이 바뀔지 요약**만
      반환(블록별 추가/교체/삭제, 검증 경고, 영향 페이지). 게시된 글 수정 시 특히 필요.
- [x] 도구 docstring·SKILL 에 "고치기 전 dry_run, 잘못되면 restore_version" 습관 명시.

**예상 규모**: 백엔드 소, MCP 소. **가장 싸고 가장 급하다.**

> ✅ **구현 완료 (2026-08-21)**. 마이그레이션 없음 — `report_versions.source` 가 자유
> 문자열이라 `'mcp'` 를 그냥 넣었다. 다만 `prune_versions` 가 `source != 'save'` 를
> **영구 보존**하고 있어, 그대로 두면 AI 수정분이 계속 쌓인다 → `ORDINARY_SOURCES =
> ('save','mcp')` 로 넓혀 일상 저장처럼 프루닝되게 했다(`'mcp'` 는 마일스톤이 아니라
> **누가 고쳤나** 표식이므로). `list_versions` 는 백엔드 `id` 를 `version_id` 로 바꿔
> 돌려준다 — 그대로 흘리면 모델이 report id 와 헷갈린다.

---

## Phase B — 사람과 주고받는 통로 (일하는 방식이 바뀌는 부분)

> 목표: 지시를 채팅으로 옮겨 적지 않는다. **문서 안에서 대화가 끝난다.**

```
사람: 보고서 3장에 댓글 — "결론이 약함, 시험 데이터 근거 추가"
AI:   list_comments → 읽고 → search_reports 로 근거 찾고 → 본문 수정 → reply_comment
사람: 확인 후 스레드 종료
```

- [x] **`list_comments(report_id, status?)`** — `GET /api/comments/reports/{id}/threads`.
      스레드+댓글을 AI 가 읽기 좋은 평평한 형태로(작성자·시각·본문·연결된 블록·상태).
- [x] **`reply_comment(thread_id, text)`** — `POST /api/comments/threads/{tid}/comments`.
- [x] **`resolve_thread(thread_id)`** — `PATCH /api/comments/threads/{tid}` (status).
- [x] **`list_my_notifications(unread_only?, limit)`** — `GET /api/notifications`.
      "나 뭐 할 거 있어?" 에 답하게 한다. 게시취소 요청·리뷰·경보가 여기로 온다.
- [x] **AI 발화 표식** — §6-1 의 (a) 채택: `comments.via` 컬럼(p90) + UI 배지.
      **서버가 요청 헤더 `X-Client: mcp` 를 보고 채운다**(클라이언트 입력 불신).

**예상 규모**: 백엔드 0(전부 존재), MCP 중. **투입 대비 효과가 가장 크다.**

> ✅ **구현 완료 (2026-08-21)**. 마이그레이션 **p90**(`comments.via`). 실제 경로는
> `/api/reports/{id}/threads` · `/api/threads/{tid}/comments` 였다(`/api/comments/...`
> 아님 — comments 라우터가 `/api` 에 마운트된다). 댓글 본문이 tiptap 문서 JSON 이라
> MCP 가 평문↔문서로 변환한다(`_doc_to_text`/`_text_to_doc`) — 리치 JSON 을 그대로
> 주면 모델이 읽기 어렵고 토큰만 먹는다.

---

## Phase C — 세밀 편집 (체감 최대, 설계 필요)

> 목표: 표에 한 줄 넣으려고 표 전체를 왕복하지 않는다.

현재는 `blocks` 를 주면 그 블록 content 가 **통째로 교체**된다. 그래서 AI 는
`get_report` 로 전체를 읽어 **전부 다시 보낸다** — 토큰 낭비이자, 읽고 쓰는 사이 사람이
고친 내용을 조용히 덮어쓰는 **lost update** 위험이다.

- [x] **`append_rows(report_id, block_id, rows, page?)`** — 표/차트류에 행 추가.
- [x] **`patch_cells(report_id, block_id, patches, page?)`** — `[{row, key, value}]` 로 셀만.
- [x] **`remove_rows(report_id, block_id, row_indexes, page?)`**
- [x] **낙관적 동시성** — `ReportUpdate.expected_revision` 이 **이미 있다**. 세밀 연산에
      `expected_revision` 을 노출해, 그 사이 남이 고쳤으면 409 로 거부하고 AI 가 다시 읽게.
- [x] 대상 위젯 범위 결정: table·chart·pie·progress_bar·milestone 등 **행 개념이 있는 것**만.
      rich_text 같은 건 별도(문단 단위 patch 는 후속).

**예상 규모**: 백엔드 중(정규화·검증 재사용), MCP 소.

> ✅ **구현 완료 (2026-08-21)**. `PATCH /api/reports/{id}/ai-draft/rows`, 마이그레이션 없음.
> **발견**: 행 개념이 있는 위젯은 대부분 `content.rows`(객체 리스트) 규약을 공유한다
> (table·chart·pie·box·waffle·packing·treemap·tree·mind_map·raci·comparison·scatter3d…).
> 그래서 위젯별 분기 없이 **하나의 일반 연산**으로 덮인다. 고친 블록은 원래 작성 경로와
> 같은 정규화(`ai_authoring`)에 다시 태워 숫자 강제·라벨키 매핑을 그대로 받는다.
> `ops` 를 리스트로 받아 여러 연산이 **한 번만 저장**된다(버전·revision 도 1회).
> 없는 block_id 면 **그 페이지에서 가능한 블록 목록**을 알려준다(이름만 틀린 경우가 흔하다).

---

## Phase D — 자기 점검과 산출물 흐름

> 목표: AI 가 자기 결과물을 확인하고, 최종 산출물(종합보고)까지 잇는다.

### D-1 자기 점검
- [ ] **`get_report_outline(report_id)`** — 페이지별 블록 순서·타입·**채움 여부**·검증 경고
      요약. "3쪽 표가 비어 있음", "2쪽 차트에 데이터 없음" 을 AI 가 스스로 잡게 한다.
      **완성본을 못 보는 문제의 저비용 대체재.**
- [ ] (후속) **렌더 확인** — 진짜 완성본은 `[미구현] 헤드리스_내보내기_설계.md` 가 서야
      가능하다. 그게 서면 `export_report(format)` → 파일을 MCP 로 받아 확인.

### D-2 산출물 흐름
- [ ] **`list_composites(...)` / `get_composite(id)`** — 종합보고 조회(현재 MCP 도구 0개).
- [ ] **`request_composite_item(composite_id, report_id, note)`** — `POST /{id}/requests`.
      **사람이 승인하는 요청 큐**라 안전 모델과 잘 맞는다(AI 가 직접 꽂지 않는다).
- [ ] **게시(mount) 경계 정리(미결정 — §6)** — "게시는 사람이" 원칙이 Phase 6 으로 흐려졌다.

**예상 규모**: D-1 소, D-2 중.

---

## 4. 순서와 근거

| 순서 | Phase | 왜 이 순서인가 |
|---|---|---|
| 1 | **A 안전망** | 게시글 수정을 열었는데 되돌릴 수단이 없다. **빚부터 갚는다.** 가장 싸다 |
| 2 | **B 협업 통로** | 백엔드 0. 일하는 방식이 바뀌는 유일한 갈래 |
| 3 | **C 세밀 편집** | 체감 최대지만 설계가 필요. A 의 dry_run·복원이 전제 |
| 4 | **D 자기 점검·산출물** | 위 셋이 서면 자연스럽게 필요해진다 |

A·B 는 **묶어서 진행 가능**하다(둘 다 백엔드 부담이 거의 없다).

---

## 5. 공통 작업 (Phase 무관)

- [ ] **요청 크기 상한** — ai-draft·세밀연산에 본문 크기·블록 수·행 수 상한 + 초과 시 400.
      (`[완료] MCP보고서작성_설계.md` Phase 4 남은 항목에서 이월)
- [ ] **SKILL.md 갱신** — 새 도구의 사용 습관(고치기 전 dry_run, 댓글 먼저 읽기 등).
- [ ] **MCP 서버 재시작 안내** — 도구를 추가하면 사용자가 MCP 서버를 다시 띄워야 목록에
      반영된다(운영 배포 `deploy.sh` 는 자동, 개발자 로컬은 수동).

---

## 6. 미결정 — 착수 전 결정 필요

1. **AI 가 단 댓글을 어떻게 표시할 것인가.** MCP 는 사용자 토큰으로 동작하므로 AI 의 답글이
   **그 사람이 쓴 것처럼** 보인다. 선택지:
   (a) 댓글 모델에 `via` 컬럼 추가 + UI 배지 (정공법, 마이그레이션 1개)
   (b) 본문에 접두사 규약(`[AI]`) — 싸지만 위조·검색 오염 가능
   (c) 그냥 둔다 — 비추천. 협업 신뢰가 깨진다
2. **게시(mount)를 AI 에게 열 것인가.** 현재 원칙은 "생성물은 항상 초안, 게시는 사람이".
   Phase 6 이 *수정* 은 열었으므로 경계를 다시 그어야 한다. 최소안은 `request_publish`
   (요청만, 사람이 승인) — 종합보고 요청 큐와 같은 패턴.
3. ~~**세밀 편집의 충돌 정책.**~~ → **(a) 409 후 AI 재시도 채택** (2026-08-21 구현).
   자동 병합은 조용한 덮어쓰기를 부른다.

---

## 7. 주의

- **도구 수 증가 자체가 비용이다.** 지금 27개인데 여기 다 더하면 43개 안팎이 된다.
  도구 목록·설명은 매 요청의 모델 입력 토큰을 먹는다. 설명을 짧게 유지하고, 서로 겹치는
  도구는 만들지 않는다(예: `list_comments` 와 별도 `get_thread` 를 둘 다 두지 않는다).
- **Phase C 는 위젯 내부 포맷에 의존한다.** widget-v1 정규화 규칙이 바뀌면 같이 깨진다.
  `ai_authoring.py` 의 정규화를 재사용하고 새로 짜지 않는다.
- **되돌리기는 만능이 아니다.** 버전 스냅샷은 본문(pages/content/layout)만 담는다.
  태그·게시 상태·메타데이터는 복원되지 않는다.
