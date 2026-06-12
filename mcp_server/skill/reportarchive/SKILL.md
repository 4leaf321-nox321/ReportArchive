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
- `mcp__reportarchive__search_reports` — 기존 보고서 전문검색(참고용)
- `mcp__reportarchive__get_report` — 보고서 1건 조회
- `mcp__reportarchive__create_report_draft` — 초안 생성

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

그 외 타입(이미지·첨부·CAD 등 파일 기반, scatter·heatmap 등 고급 차트)은 **비워 둔다**(작성자가 채움).

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
