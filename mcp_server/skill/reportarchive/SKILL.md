---
name: ReportArchive 보고서 작성
description: ReportArchive 시스템에 보고서를 초안으로 작성한다. 사용자가 "보고서 써줘", "초안 만들어줘", "주간보고 작성", "리스크 보고 작성" 등 ReportArchive 보고서 생성을 요청할 때 사용. reportarchive MCP 서버 도구로 템플릿을 고르고 내용을 채워 초안을 만든다.
allowed-tools: mcp__reportarchive__*
---

# ReportArchive 보고서 작성

`reportarchive` MCP 서버로 보고서를 **초안(draft)** 으로 만든다.
**생성물은 항상 초안**이며, 게시·발행은 사람이 시스템 화면에서 한다.

## 도구
- `mcp__reportarchive__list_templates` — 템플릿 목록(template_id, version, name)
- `mcp__reportarchive__describe_template` — 템플릿의 블록(채울 항목)과 형식 안내
- `mcp__reportarchive__describe_widgets` — 위젯 타입별 상세 작성 룰(특히 `extra_blocks` 로 위젯 직접 만들 때)
- `mcp__reportarchive__search_reports` — 기존 보고서 전문검색(참고용)
- `mcp__reportarchive__list_my_drafts` — 내가 만든 작성 중 초안 목록(이어서 수정할 때)
- `mcp__reportarchive__get_report` — 보고서 1건 조회
- `mcp__reportarchive__create_report_draft` — 초안 생성
- `mcp__reportarchive__update_report_draft` — 기존 초안 이어서 수정(병합/추가/제거/전체교체)

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

그 외 타입(이미지·첨부·CAD 등 파일 기반)은 **비워 둔다**(작성자가 채움).

## 원칙
- **항상 초안.** 게시·발행은 사람이 한다.
- 채울 수 없는 블록은 **비운다**(부분 초안 허용). **추측으로 채우지 말 것** — 모르는 값은 사용자에게 묻는다.
- **누락은 투명하게.** 요청했는데 못 채운 블록(`warnings`/검증 탈락)은 조용히 넘기지 말고 사용자에게 보고한다.
- 표/선택지는 `describe_template` 의 `key`·`options` 를 정확히 따른다.
- 내용은 간결하고 사실 위주로.

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

## 기존 초안 이어서 수정 (update_report_draft)
방금/예전에 만든 **내 작성 중(drafting) 초안**을 고칠 때 새로 만들지 말고 `update_report_draft`
로 이어서 수정한다. **본인이 만든 drafting 상태만** 대상(리뷰/발행 단계·남의 보고서는 거부).

- `report_id` 를 모르면 먼저 `list_my_drafts` 로 찾는다(최근 수정 순, report_id·title·url 포함).
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
1. list_my_drafts() → 해당 초안 report_id 확인
2. update_report_draft(report_id, blocks={"summary":"수정된 요약"},
     extra_blocks=[{"id":"risk","type":"table",
       "props":{"columns":[{"key":"item","label":"항목","type":"text"}]},
       "content":[{"item":"일정 지연"}]}])
3. 응답 url 안내
```
