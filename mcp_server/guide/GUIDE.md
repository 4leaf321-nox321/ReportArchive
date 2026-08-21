<!-- ReportArchive MCP 사용 가이드 — **서버가 쥔다.**

로컬 스킬(~/.claude/skills)에 본문을 두면 사람마다 복사 시점이 달라 낡는다.
실제로 v0.147.0 에서 안내가 162줄 바뀌었는데, 복사 안 한 사람에겐 전달되지
않았다. 그래서 본문을 서버로 옮기고 로컬엔 짧은 스텁만 남겼다.
`get_guide(topic)` 이 여기서 읽어 준다. 이 파일만 고치면 모두에게 즉시 반영된다.

주제 구분자: `<!--@ 주제이름 -->`. 순서는 상관없다. -->
GUIDE_VERSION: 2026-08-21e

<!--@ overview -->
## 무엇을 하려는가 → 어떤 도구

| 하려는 일 | 도구 | 헷갈리는 짝 |
|---|---|---|
| **본문 내용**으로 찾기 | `search_reports` | 조건 나열은 ↓ |
| **조건**으로 목록 뽑기(게시판·폴더·작성자·기간) | `list_reports` | 내용 검색은 ↑ |
| **개수만** 세기 | `aggregate_reports` | 직접 세지 말 것 |
| 내가 쓴 글 찾기(고치려고) | `list_my_reports` | 기간·게시판 조건이 붙으면 ↓ |
| **내가** 지난주/특정 게시판에 쓴 글 | `list_reports(mine=True, ...)` | 너는 사용자 이름을 모른다 |
| 누가 언제 고쳤는지 | `list_versions` | 되돌리기도 여기서 |
| 본문을 **읽어야** 함 | `get_report` | 구조만이면 ↓ |
| 빈 블록·구조만 확인(자기 점검) | `get_report_outline` | 본문 필요하면 ↑ |
| 게시판·폴더 **이름을 모름** | `list_boards` → `list_folders` | — |
| 기준정보(모델·부품·과제) 찾기 | `search_objects` | 보고서는 위쪽 |
| 답을 통째로 위임 | `ask_ontology` | 느림. 직접 조사 가능하면 안 씀 |
| 새로 쓰기 | `list_templates`→`describe_template`→`create_report_draft` | — |
| 있는 걸 고치기 | `update_report_draft` | 표 한 줄이면 ↓ |
| 표에 줄 추가/셀 수정/줄 삭제 | `append_rows`/`patch_cells`/`remove_rows` | 통째로면 ↑ |
| 잘못 만든 초안 치우기 | `trash_report` | 게시된 글은 불가 |
| 리뷰 의견 처리 | `list_comments`→(수정)→`reply_comment` | — |
| 잘못 고침 | `list_versions`→`restore_version` | — |
| 게시판에 올리기 | `preview_publish`→(확인)→`publish_report` | **2단계 필수** |
| 종합보고에 안건 내기 | `list_submittable_composites`→`request_composite_item` | — |

**기본 습관 셋**
1. **이름을 모르면 먼저 목록을 부른다** — 게시판·폴더·템플릿·종합보고 모두. 추측하지 않는다.
2. **되돌리기 어려운 일은 미리보기부터** — 큰 수정은 `dry_run`, 게시는 `preview_publish`.
3. **본문을 통째로 읽지 않는다** — 구조만 필요하면 `get_report_outline`, 표 한 줄이면 행 단위 도구.
## 도구
- `mcp__reportarchive__list_templates` — 템플릿 목록(template_id, version, name)
- `mcp__reportarchive__describe_template` — 템플릿의 블록(채울 항목)과 형식 안내
- `mcp__reportarchive__describe_widgets` — 위젯 타입별 상세 작성 룰(특히 `extra_blocks` 로 위젯 직접 만들 때)
- `mcp__reportarchive__search_reports` — 기존 보고서 **의미+키워드 검색**(근거 발췌, 최대 25건)
- `mcp__reportarchive__list_reports` — 조건으로 보고서 **모아서 나열**(게시판·폴더·작성자·기간, 최대 100건)
- `mcp__reportarchive__list_boards` — 게시판(조직) 목록 — 조직 단위로 찾기 전에 먼저
- `mcp__reportarchive__list_folders` — 게시판 안 폴더 목록(이름·id·건수)
- `mcp__reportarchive__aggregate_reports` — 개수 세기(직접 세지 말 것)
- `mcp__reportarchive__list_my_reports` — 내가 쓴 보고서 목록(이어서 수정할 때. 게시된 글 포함)
- `mcp__reportarchive__append_rows` / `patch_cells` / `remove_rows` — 표·차트를 **행 단위로** 수정
- `mcp__reportarchive__get_report_outline` — 내가 만든 보고서 **자기 점검**(빈 블록 찾기)
- `mcp__reportarchive__preview_publish` / `publish_report` — 게시(**2단계 필수**)
- `mcp__reportarchive__list_composites` / `get_composite` / `list_submittable_composites` / `request_composite_item` — 종합보고
- `mcp__reportarchive__list_versions` / `restore_version` — 수정 이력 보기 · 되돌리기
- `mcp__reportarchive__trash_report` — 내가 쓴 **미게시 초안**을 휴지통으로(복구 가능)
- `mcp__reportarchive__list_comments` / `reply_comment` / `resolve_thread` — 리뷰 의견 읽기·답글·종료
- `mcp__reportarchive__list_my_notifications` — 내게 온 알림("나 뭐 할 거 있어?")
- `mcp__reportarchive__get_report` — 보고서 1건 조회(이미지·첨부는 file_id 참조만)
- `mcp__reportarchive__download_file` — file_id 로 파일 바이트를 base64 로 내려받기(get_report 의 이미지·첨부를 로컬 저장/재사용할 때, ≈1MB 이하)
- `mcp__reportarchive__create_report_draft` — 초안 생성
- `mcp__reportarchive__update_report_draft` — 기존 초안 이어서 수정(병합/추가/제거/전체교체)
## 원칙
- **생성물은 항상 초안.** 발행(finalize)은 사람이 한다.
- **게시는 확인받고 2단계로.** 사용자가 요청하면 게시할 수 있지만, `preview_publish`
  로 대상과 노출 범위를 보여주고 **확인받은 뒤에만** 실행한다.
- **수정은 게시된 글도 가능** — 편집 권한이 있고 발행(finalized) 전이면 된다. 단 게시된 글을
  고쳤으면(응답 `mounted_to` 가 비어 있지 않으면) **어디에 게시된 글인지 사용자에게 알린다.**
- **고치기 전에 `dry_run`.** 게시된 글이거나 여러 블록을 한 번에 바꿀 때는
  `update_report_draft(..., dry_run=True)` 로 **무엇이 바뀔지 먼저 확인**하고 적용한다.
  (저장하지 않고 페이지별 추가·변경·삭제될 block_id 와 경고만 돌려준다.)
- **잘못 고쳤으면 되돌린다.** `list_versions` 로 시점을 찾아
  `restore_version(..., dry_run=True)` 로 **먼저 무엇이 되감기는지 확인**하고,
  사용자에게 알린 뒤 적용한다. 되돌리기도 버전으로 남아 다시 되돌릴 수 있다.
  미리보기가 준 `current_revision` 을 실제 호출에 `expected_revision` 으로 그대로
  넘겨라 — 그 사이 남이 고쳤으면 거부된다(미리 본 것과 다른 상태를 되감지 않게).
  ※ 스냅샷은 **본문만** 담는다(태그·게시 상태는 복원되지 않음).
- **처음 쓰는 템플릿·직접 만든 위젯은 `create_report_draft(dry_run=True)` 로 먼저.**
  형식이 틀리면 블록이 **조용히 버려지는데**, 만들고 나서 알면 치우기가 번거롭다
  (AI 가 지울 수 있는 건 본인 미게시 초안뿐이다).
- **잘못 만들었으면 `trash_report` 로 치운다.** 지우기 전에 무엇을 지우는지
  사용자에게 확인받아라. 게시된 글·리뷰 단계 문서는 거절되고 사람이 웹에서 처리한다.
- **긴 글은 통째로 읽지 마라.** `get_report_outline` 으로 어느 쪽인지 먼저 잡고
  `get_report(report_id, page=N)` 로 그 쪽만 받는다(실측 9쪽짜리에서 절반 이하).
- 채울 수 없는 블록은 **비운다**(부분 초안 허용). **추측으로 채우지 말 것** — 모르는 값은 사용자에게 묻는다.
- **누락은 투명하게.** 요청했는데 못 채운 블록(`warnings`/검증 탈락)은 조용히 넘기지 말고 사용자에게 보고한다.
- 표/선택지는 `describe_template` 의 `key`·`options` 를 정확히 따른다.
- 내용은 간결하고 사실 위주로.

<!--@ write -->
## 워크플로
1. 템플릿이 안 정해졌으면 `list_templates` 로 보여주고 고르게 한다.
2. `describe_template(template_id, template_version)` 로 **각 블록(block_id)** 과 채울 형식을
   파악한다 — 표의 열 키(`columns[].key`)·선택지(`options`), key_value 필드(`fields[].key`),
   필수 여부(`required`)를 확인.
3. 사용자에게 필요한 내용을 묻거나, 주어진 자료로 각 블록 내용을 구성한다.
4. `create_report_draft(template_id, template_version, title, blocks)` 호출.
5. 결과에 **`error`** 가 있으면 블록별 메시지를 읽고 `blocks` 를 고쳐 **다시 호출**한다.
6. 성공하면 `url` 을 사용자에게 알린다. 이때 **`warnings`(무시된 필드/블록)가 있으면
   반드시 함께 보고**한다 — 예: "○○ 블록은 형식을 맞추지 못해 비워 두었습니다." 요청한 블록이
   초안에 안 들어갔으면(빈 채로 생성됐으면) **숨기지 말고 알려서** 사용자가 검토 화면에서
   직접 채우거나 다시 요청하게 한다.
## blocks 작성 형식 (느슨하게 줘도 서버가 정규화)
`blocks` 는 `{ block_id: 내용 }`. block_id 는 `describe_template` 가 알려준 값만 사용한다.
위젯 타입별:

| 타입 | 주는 형식 | 예시 |
|---|---|---|
| heading | 문자열 | `"2026 2분기 리스크 보고"` |
| rich_text(긴 글) | 문단 문자열 / 문단 배열 / `[{text, depth}]`(depth 0~5 들여쓰기) | `["요약 첫 문단", "둘째 문단"]` |
| bulleted_list | 문자열 배열 | `["항목 A", "항목 B"]` |
| key_value | `{필드키: 값}` (라벨로 줘도 매핑되지만 key 가 안전) | `{"period": "2026 Q2", "owner": "홍길동"}` |
| table | 행 배열, 각 행은 `{열키: 값}`. select 열은 options 중 하나 | `[{"issue": "원자재 상승", "severity": "높음"}]` |
| chart(막대/꺾은선) | 행 배열. x축 열 + 숫자 계열 열을 columns 의 key(또는 label)로. 숫자는 숫자로 | `[{"month": "1월", "sales": 1200}, {"month": "2월", "sales": 1500}]` |
| pie(파이/도넛) | `{항목: 값}` 또는 `[{label, value}]` | `{"서버": 40, "DB": 35, "네트워크": 25}` |
| progress_bar(진행률) | `[{label, value, max?}]` 또는 `{작업: 값}`. 기본 목표 100 | `[{"label": "설계", "value": 100}, {"label": "구현", "value": 60}]` |
| milestone(타임라인) | `[{date: "YYYY-MM-DD", label, status?}]` | `[{"date": "2026-01-15", "label": "킥오프"}]` |
| flowchart(순서도) | 단계 문자열 배열 또는 `[{label, description}]` | `["접수", "검토", "승인", "완료"]` |
| equation(수식) | LaTeX 문자열 | `"E = mc^2"` |

`describe_template` 응답은 각 블록에 **`example`**(이 템플릿에 맞춘 견본)과 전체 **`example_input`**
을 포함한다 — 그 형태를 그대로 흉내내면 안전하다.

### 위젯 상세 룰 — 반드시 참고
`describe_template` 응답의 **`widget_rules`** 에 그 템플릿이 쓰는 위젯들의 **상세 작성 룰**
(content 형식·필수 키·★ 자주 틀리는 형식 ★·혼동되기 쉬운 위젯 쌍·다른 라이브러리에서 흔히
가져오는 환각 키 등)이 담겨 있다. **위젯 content 를 채우기 전 이 룰을 읽고 그대로 따르라.**
`extra_blocks` 로 템플릿에 없는 위젯을 직접 만들 때는, 만들 위젯 타입을
**`describe_widgets(["chart","table",…])`** 로 넘겨 같은 룰을 받아 따른다.
(예: box 는 `rows:[{group,value}]`·density 는 `groups:[{name,values}]`; radar 의 `values` 는
series 안이 아니라 root 의 2D 배열; network 는 `edges`·sankey 는 `links` 등 — 룰에 다 있다.)

scatter·heatmap·radar·network·sankey·box·density·tree·mind_map·treemap·comparison·raci_matrix 등
**고급 위젯도 채울 수 있다** — `describe_widgets` 룰을 따르되, 형식이 조금 어긋나도 서버가 흔한 실수를
자동 교정한다(배열만 줘도 래핑, 숫자 문자열→숫자, `name→label`·`links↔edges`·`categories→axis_labels`·
`type→kind`·`task→label` 등). 그래도 **룰대로 주는 게 가장 안전**하다.

이미지·첨부·CAD·동영상 등 **파일 기반** 위젯은 MCP 로 못 채우므로 **비워 둔다**(작성자가 화면에서 채움).
## 빈 템플릿에서 위젯 직접 만들기 (extra_blocks)
적합한 템플릿이 없거나 **빈 템플릿**으로 처음부터 짤 때, `create_report_draft` 의
`extra_blocks` 로 위젯을 직접 정의해 추가한다. 각 항목 `{id, type, props?, content}`:
- `type`: heading/rich_text/bulleted_list/key_value/table/chart/pie/progress_bar/
  milestone/flowchart/equation (content 형식은 위 표와 동일).
- `props`: 열 정의가 필요한 위젯만 — 예 `table`/`chart`: `{"columns":[{key,label,type}]}`,
  `chart` 는 `{"chart_type":"bar","x_column_key":"x","columns":[...]}`.
- `content`: 느슨하게 줘도 정규화됨.

예:
```
create_report_draft("<빈템플릿id>", 1, "분기 리뷰", {}, extra_blocks=[
  {"id":"h","type":"heading","content":{"text":"3분기 리뷰"}},
  {"id":"kv","type":"key_value","content":{"기간":"3분기","담당":"개발팀"}},
  {"id":"tbl","type":"table","props":{"columns":[{"key":"item","label":"항목","type":"text"},
     {"key":"val","label":"값","type":"number"}]},"content":[{"item":"매출","val":120}]}
])
```

**참고:** 보고서엔 **AI 가 채운 위젯만** 보인다(템플릿의 빈 블록은 자동 숨김). 레이아웃은
서버가 자동 배치하므로 위치는 신경 쓰지 않아도 된다.
## 단락 구분(block_sections) · 여러 페이지(pages)
- **단락 구분**: `block_sections = {block_id: section_code}`. 보고서에서 블록마다 단락 색상 칩으로
  표시된다. `section_code` 는 반드시 `describe_template` 응답의 **`section_taxonomy`** 에 있는
  `code` 값만 쓴다(라벨/한글 금지). 단락이 분명한 블록만 태깅하고, 적절한 코드가 없으면 생략.
  taxonomy 에 없는 코드·그 페이지에 없는 블록은 서버가 무시하고 `warnings` 로 알린다.
- **여러 페이지**: `pages = [{name?, blocks?, extra_blocks?, block_sections?}, …]`. 주제가 길거나
  나뉘면 페이지를 늘린다(모두 같은 template 사용). `pages` 를 주면 상단의
  `blocks`/`extra_blocks`/`block_sections` 는 무시되고 페이지별로 채운다. 한 장이면 `pages` 없이
  상단 필드만 쓴다.
## 예시
사용자: "주간 개발 보고 초안 써줘. 이번 주 요약은 인증 모듈 완료, 이슈는 DB 지연(높음)."

1. `list_templates` → `weekly-dev` 선택
2. `describe_template("weekly-dev", 1)` →
   blocks: `summary`(rich_text), `progress`(bulleted_list),
   `issues`(table: `issue`, `severity`[낮음/보통/높음])
3. ```
   create_report_draft("weekly-dev", 1, "주간 개발 보고", {
     "summary": ["인증 모듈 구현 완료"],
     "issues": [{"issue": "DB 응답 지연", "severity": "높음"}]
   })
   ```
4. 응답의 `url` 을 안내: "초안을 만들었습니다 → <url> 에서 검토·게시하세요."

<!--@ find -->
## 조직·폴더로 찾기 (특정 부서 글 모아보기)
보고서는 작성자 개인공간에 저장되고, **어느 조직 글이냐는 어느 게시판에 게시(mount)됐냐로만**
정해진다. 그래서 "○○팀 보고서 보여줘" 는 이렇게 푼다:

1. `list_boards()` → 게시판 slug·이름 확인(개인공간은 안 나온다).
2. 폴더까지 좁힐 거면 `list_folders(board)` → 폴더 이름·id·건수.
3. `list_reports(board="dx", folder="진행 중", last_days=30)` → 목록.
   - `include_descendants=True` 면 하위 부서 게시판까지, `unfiled=True` 면 미분류만.
   - 개수만 필요하면 `aggregate_reports(filters=[], board="dx")`.
   - 본문 내용으로 찾는 거면 `search_reports(query, board="dx")`.

**board(게시된 곳) vs author_org(작성자 소속)** 은 다른 축이다 — "DX 부문 게시판에 올라온 글"은
`board`, "DX 부문 사람이 쓴 글(게시 여부 무관)"은 `author_org`. 요청이 모호하면 사용자에게 묻는다.

이름을 못 찾으면 도구가 **에러**를 돌려준다(전체 결과를 그 조직 것으로 오해하지 않게).
그때는 `list_boards`/`list_folders` 로 정확한 이름을 확인하고 다시 부른다.

<!--@ edit -->
## 기존 보고서 이어서 수정 (update_report_draft)
이미 있는 보고서를 고칠 땐 새로 만들지 말고 `update_report_draft` 로 이어서 수정한다.
**초안뿐 아니라 이미 게시(mount)된 글도 수정된다** — 편집 권한이 있고 **발행(finalized) 전**이면
된다(웹 편집과 같은 규칙). 발행본은 사람이 '발행 취소' 를 해야 고칠 수 있다.

- `report_id` 를 모르면 먼저 `list_my_reports` 로 찾는다(최근 수정 순). 각 행의
  **`editable`** 이 지금 AI 로 고칠 수 있는지, **`mounted_to`** 가 게시된 게시판·폴더다.
  게시한 글은 단계가 `reviewing` 이라 `phase="drafting"` 으로 좁히면 **안 보인다**(기본 all 유지).
- **게시된 글을 고쳤으면 사용자에게 알린다** — 응답 `mounted_to` 에 게시판·폴더가 온다.
  이미 남들이 보고 있는 문서이므로 조용히 바꾸지 않는다.
- **기본은 병합(merge)** — 준 것만 바꾸고 나머지는 둔다:
  | 인자 | 동작 |
  |---|---|
  | `blocks` | 그 block_id 내용만 덮어쓰기(안 준 블록은 유지) |
  | `extra_blocks` | 같은 id 는 교체, 새 id 는 추가 |
  | `remove_blocks` | 그 block_id 들을 보고서에서 제거 |
  | `block_sections` | 단락 갱신. `null`/빈값이면 그 블록 단락 **해제** |
  | `title` | 주면 제목 변경 |
  | `page` | 수정할 페이지(1-base, 기본 1). **`마지막+1` 이면 새 페이지 추가**(기존 쪽 보존, `blocks`/`extra_blocks` 로 채움) |
- 안 건드린 블록과 **사람이 화면에서 맞춘 레이아웃은 유지**된다(블록 구성이 바뀐 경우에만 자동 재배치).
- **페이지 추가**는 `page=<현재 페이지수+1>` + 그 페이지 내용(`blocks`/`extra_blocks`)으로 호출하면 된다(전체 교체보다 안전 — 기존 페이지 레이아웃 보존).
- **편집 충돌**: 누군가(본인 다른 탭 포함) 그 보고서를 편집 화면에서 열어 두면(편집 락) 수정이 **거부**된다(에러에 현재 편집자 표시). 사용자에게 **편집 화면을 닫고 다시 요청**하라고 안내한다.
- `pages` 를 주면 **전체 교체**(보고서를 그 페이지 목록으로 다시 만듦) — 이땐 병합 인자는 무시된다.
- 검증 실패 시 `error`/`warnings` 를 읽고 고쳐 재호출. 끝나면 `url` 안내.

예: "방금 만든 초안에 리스크 표 한 줄 추가하고 요약 고쳐줘"
```
1. list_my_reports() → 해당 보고서 report_id 확인(editable 확인)
2. update_report_draft(report_id, blocks={"summary":"수정된 요약"},
     extra_blocks=[{"id":"risk","type":"table",
       "props":{"columns":[{"key":"item","label":"항목","type":"text"}]},
       "content":[{"item":"일정 지연"}]}])
3. 응답 url 안내
```
## 표에 한 줄만 고치기
`update_report_draft(blocks=...)` 는 그 블록을 **통째로 교체**한다. 표에 한 줄을 넣으려고
전체를 다시 보내면 토큰이 낭비되고, 읽고 쓰는 사이 사람이 고친 내용을 덮어쓸 수 있다.
**행 단위 도구를 쓰라:**

| 하려는 일 | 도구 |
|---|---|
| 표에 줄 추가 | `append_rows(report_id, block_id, rows)` |
| 특정 칸만 수정 | `patch_cells(report_id, block_id, [{row, key, value}])` — row 는 **0부터** |
| 줄 삭제 | `remove_rows(report_id, block_id, indexes)` — indexes 는 **0부터** |

- 행 번호가 헷갈리면 **먼저 `get_report`** 로 현재 행을 확인한다(번호가 틀리면 엉뚱한 칸이 바뀐다).
- 여러 행을 지울 땐 `dry_run=True` 로 몇 개가 남는지 먼저 본다.
- 남이 고칠 수 있는 문서면 `get_report` 의 `revision` 을 `expected_revision` 으로 넘긴다.
  그 사이 바뀌었으면 거부되니, **다시 읽고 재시도**한다(자동으로 덮어쓰지 않는다).
- 표를 통째로 새로 쓸 거라면 그땐 `update_report_draft` 가 낫다.
- **결과를 확인하고 보고하라.** 응답의 `applied[].count` 는 요청한 수가 아니라
  **실제로 반영된 수**이고, `row_counts` 는 반영 후 행 수다. 행은 `{"열키": 값}`
  객체여야 하며(문자열·숫자는 버려진다) 모자라면 `warnings` 에 이유가 온다 —
  그대로 사용자에게 전하라. "추가했습니다" 라고만 말하지 마라.

<!--@ comments -->
## 댓글 반영해서 고치기
"이 보고서 댓글 반영해줘" 는 이렇게 푼다 — 지시를 채팅으로 옮겨 적을 필요가 없다.

1. `list_comments(report_id, status="open")` — 미해결 의견만 읽는다. 각 스레드의
   `block_id`·`page` 가 **어느 부분에 대한 의견인지** 알려준다.
2. 필요하면 `search_reports` 등으로 근거를 찾는다.
3. `update_report_draft(..., dry_run=True)` 로 확인 후 적용한다.
4. `reply_comment(thread_id, "...")` — **무엇을 어떻게 고쳤는지** 구체적으로 남긴다.
5. **스레드는 스스로 닫지 않는다.** 사람이 확인한 뒤 닫는 게 원칙이라, 사용자가
   "닫아줘" 라고 할 때만 `resolve_thread`.

각 댓글의 **`via`** 가 작성 경로다 — `web`(사람이 직접) · `mcp`(AI 가 이 사용자
권한으로). **내가 이전에 단 답글을 사람 의견으로 착각하지 마라.**
내 답글은 화면에서 **AI 배지**로 표시되므로 사람이 쓴 것처럼 위장할 필요도 없다.

<!--@ publish -->
## 게시하기 — 반드시 2단계
게시(부서 게시판에 올리기)는 **되돌리기 어려운 바깥 방향 행위**다. 문서가 조직에
보이고, 내리려면 게시판 매니저 승인이 필요할 수 있다. 그래서 **한 번에 올리지 못하게**
막혀 있다.

1. `preview_publish(report_id, boards)` — 어디에 얼마나 보이게 되는지 확인.
   반환의 `audience` 는 **그 게시판과 하위에 소속된 사람 수**다.
2. 사용자에게 **"○○ 게시판(N명)에 게시합니다. 진행할까요?"** 라고 확인받는다.
3. `publish_report(report_id, boards, confirm_token)` — 1번이 준 토큰으로 실행.

- 토큰은 **(보고서, 게시판 집합)** 에 묶여 있다. 대상을 바꾸려면 **미리보기를 다시** 받아라.
- 게시판 이름이 헷갈리면 `list_boards` 로 확인한다. **상위 부문 게시판에 잘못 올리면
  훨씬 많은 사람에게 노출된다** — `audience` 숫자를 사용자에게 꼭 보여줘라.
- 게시 후 **어느 게시판에 올렸는지 알린다.** 게시 이력에 AI 표식이 남는다.

<!--@ check -->
## 다 만들면 자기 점검
너는 완성된 화면을 볼 수 없다. 그래서 **빈 표나 데이터 없는 차트가 남아도 모른다.**
작성·수정을 마치면 `get_report_outline(report_id)` 로 확인하라 — 본문 대신
"무엇이 있고 무엇이 비었나"만 오므로 토큰 부담이 작다.

- `issues` 에 뜬 건 **사용자에게 알린다**("3쪽 표가 비어 있습니다").
- **무조건 채우지 마라.** 파일 위젯(이미지·첨부·CAD·동영상)처럼 **사람이 채울** 것도 있다.

<!--@ composites -->
> `list_composites` · `list_submittable_composites` 는 후보가 1,000건을 넘을 수 있어
> **앞쪽 일부만** 온다(`total`·`truncated` 로 알려준다). 특정 종합보고를 찾는 거라면
> `board` 로 게시판을 좁히고, 그래도 많으면 사용자에게 어느 것인지 물어라.

## 종합보고에 안건 내기
`list_submittable_composites(report_id)` 로 낼 수 있는 곳을 확인하고,
`request_composite_item(composite_id, report_id, note)` 로 **제출 요청**한다.
바로 반영되지 않고 **담당자가 승인**해야 안건이 된다(의도된 설계 — AI 가 상위
문서를 직접 바꾸지 않는다). 요청에는 **"AI" 표식**이 붙어 승인 화면에 그대로 보인다
(댓글·게시와 같은 규약) — 그러니 `note` 에 왜 내는지 한 줄 적어두면 판단이 쉬워진다.

※ 종합보고는 **게시판(부서)에 속한다.** `list_composites` 는 `board` 를 지정해야
그 게시판 것이 보인다(생략하면 MCP 등록 부서 기준이라 개인공간이면 0건).
