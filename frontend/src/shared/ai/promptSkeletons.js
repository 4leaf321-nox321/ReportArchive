/**
 * Skeleton prompt bodies + form-state assembler for the Easy builder
 * in PromptEditDialog.
 *
 * Why this file exists:
 * - First-time prompt authors shouldn't face an 80-line raw textarea.
 *   The Easy tab gives them a small form (mode + purpose + extra rules
 *   + extra don'ts + curated widgets) and assembles the final body from
 *   one of three skeletons.
 * - The assembled body matches the same shape the migration-seeded v1/v2
 *   official prompts use, so runtime (renderPrompt, AiPromptDialog,
 *   backend derived_widget_types) needs zero changes — it still sees
 *   the same `{{widget_catalog}}` / `{{widget_examples}}` / `{{template_blocks}}`
 *   tokens at the same positions.
 * - The form state is persisted to `settings.builder` so re-opening the
 *   prompt restores the form. Users who switch to Advanced (raw) and
 *   hand-edit the body intentionally orphan the builder state — next
 *   open shows Advanced.
 *
 * Rules/don'ts structure:
 * - Each mode = MODE_CONTRACT (the "what this mode IS") + COMMON_RULES
 *   (universal boilerplate constraints) + user extra_rules. Same shape
 *   for don'ts (MODE_DONTS + COMMON_DONTS + extra_donts). The split
 *   means a fix to a universal constraint touches one array, not three.
 */

/** Form-state shape stored under settings.builder. Keep stable — bumping
 *  schema would require migration of all Easy-mode prompts. */
export const DEFAULT_BUILDER_STATE = Object.freeze({
  mode: 'new_report',
  purpose: '',
  extra_rules: [],
  extra_donts: [],
  widgets: [],
})

/** UI metadata for each mode — used by the starting-point picker and
 *  the Easy form's mode selector. */
export const BUILDER_MODES = [
  {
    key: 'new_report',
    label: '새 보고서 작성',
    hint: '추천: 자유로운 보고서 생성',
    desc:
      '템플릿이 비어 있거나 사용자 입력만 보고 처음부터 보고서를 만드는 형태. 전체 위젯 카탈로그를 AI 에게 보여주고 자유롭게 조합하게 합니다. 사용자 다이얼로그에서 위젯 체크 해제 가능.',
  },
  {
    key: 'fill_template',
    label: '기존 템플릿 채우기',
    hint: '추천: 정해진 양식 채우기',
    desc:
      '현재 페이지에 이미 배치된 블록 id 들을 박아 넣고, 사용자 입력을 그 블록 content 에 채워 넣게 합니다. 사전 양식에 데이터를 붓는 데 적합.',
  },
  {
    key: 'curated',
    label: '위젯 큐레이션',
    hint: '고급 — 특정 위젯만 사용',
    desc:
      '본문에 {{widget:foo}} 로 박힌 위젯들로만 한정합니다. 사용자는 다이얼로그에서 줄일 수 없습니다 (의도적 잠금). 양식이 굳어진 반복 보고서에 적합.',
  },
]

// ─────────────────────────────────────────────────────────────────────
// SHARED CONSTRAINTS — apply to every mode. Edit here once and all 3
// skeletons get the fix. Order is informational: AI scans top-down so
// mode-specific contract rules come *before* these in the rendered
// body, since the contract is what differentiates the modes.
// ─────────────────────────────────────────────────────────────────────

const COMMON_RULES = [
  '`block_id` 는 정규식 `^[a-z][a-z0-9_]{0,63}$` 를 만족해야 합니다. 영문 소문자로 시작, 숫자·언더스코어 가능, 페이지 내 유일.',
  '각 페이지의 `template_id` / `template_version` 은 위 골격에 채워둔 값을 그대로 유지하세요 (직접 수정 금지).',
  '주제가 길거나 분리된다면 `pages` 에 페이지를 추가해도 됩니다. 같은 template_id / version 을 그대로 복사해 사용하세요.',
  '`layout_overrides`, `props_overrides`, `blocks_order` 는 비워두는 것이 안전합니다. (`null` / `[]` 그대로)',
  '`block_sections` 은 선택 사항입니다. 단락 구분이 분명한 블록만 아래 "단락 구분 (block_sections)" 절을 참고해 채우세요. 비울 때는 `{}`.',
  '모르는 값은 생략하거나 빈 문자열 `""` 로 두세요. 임의의 값(placeholder)을 지어내지 마세요.',
  '`image` / `attachment` / `cad_3d` / `html_embed` / `video` 위젯은 시스템에 업로드된 파일을 가리키는 `file_id` 가 필요하므로 절대 만들지 마세요. 필요하다는 메모만 rich_text 로 남기세요.',
]

const COMMON_DONTS = [
  'bulleted_list 의 items 를 `[{text, depth}, ...]` 객체 배열로 만들기 → 반드시 `["문자열", ...]`',
  'key_value 의 content 를 `{values: {...}}` 로 감싸기 → 키를 top-level 에 그대로 펼치기',
  'milestone 의 status 에 `planned` / `in_progress` 사용 → `pending` / `done` / `delayed` 만 허용',
  'flowchart 를 `nodes` / `edges` 그래프로 표현 → `items: [{label, description?}]` 순차 리스트만 지원',
  'image / attachment / cad_3d / html_embed / video 위젯 생성 → 불가능 (file_id 필요). `models` / `files` 같은 다른 키로 우회도 금지.',
  'network 에 `links` 키 (sankey 의 키) 쓰기 → network 는 **`edges`**, sankey 는 **`links`**',
  'radar 의 series[] 안에 `values` / `name` 넣기 → series 는 **`label`, `color` 만**, values 는 **root 의 2D 배열**',
  'quadrant 에 `points` / `items` / `dots` 키 만들기 → mode 에 따라 **`bucket_items` 또는 `plot_items` 만**',
  'comparison rows[] 에 `key` 또는 `kind` 빠뜨리기 → 둘 다 **필수**. rows.key 는 행 식별자 (cases.key 와 별개)',
  'mind_map 에 `orientation` / `direction` / `align` 키 추가 → 좌우/방사 전환은 **`layout`** 으로만',
  'network nodes[] 에 `id` 빠뜨리기 → `id` 는 **필수** (label 과 별개)',
  'top-level `_type` 키를 `*type` 으로 출력 → underscore 를 markdown italic 으로 해석하지 마세요. 정확히 `"_type": "report_archive_draft_v1"` (underscore 그대로).',
  'props 에 widget 의 props_schema 에 없는 키 추가 (`additionalProperties: false`)',
  '`block_sections` 값에 한글 라벨/카테고리 이름 넣기 → 반드시 `code` 문자열',
  '위 taxonomy 에 없는 임의의 code 만들기 → 적절한 항목이 없으면 그 블록 항목을 생략',
]

// ─────────────────────────────────────────────────────────────────────
// MODE CONTRACTS — what this mode *is* about. Goes first in the body's
// rules/donts list because it frames everything else the AI reads.
// ─────────────────────────────────────────────────────────────────────

const MODE_NEW_REPORT_RULES = [
  '데이터 성격에 맞춰 다양한 위젯을 자유롭게 조합하세요. (제목 → heading, 줄글 → rich_text, 수치 카드 → key_value, 항목 나열 → bulleted_list, 표 데이터 → table, 시계열/추세 → chart 등)',
  '위젯 블록은 모두 `extra_blocks` 에 정의합니다. 같은 `id` 가 `extra_blocks` 와 `content` 양쪽에 존재해야 합니다. (블록 선언 ↔ 데이터 매핑)',
]

const MODE_NEW_REPORT_DONTS = []

const MODE_FILL_TEMPLATE_RULES = [
  '`content` 의 키는 (a) 위 "템플릿에 이미 배치된 위젯" 의 id, 또는 (b) 본인이 `extra_blocks` 에 새로 선언한 id 둘 중 하나여야 합니다.',
]

const MODE_FILL_TEMPLATE_DONTS = [
  '템플릿 블록의 id 를 바꾸거나 새로운 id 로 대체하기 → 위 "템플릿에 이미 배치된 위젯" 의 id 를 **그대로** 사용',
  '템플릿 블록을 `extra_blocks` 에 중복으로 다시 선언하기 → 템플릿 블록은 이미 있으므로 `content` 만 채움',
]

const MODE_CURATED_RULES = [
  '**반드시 아래 "허용 위젯" 섹션에 있는 type 만 사용**하세요. 그 외 위젯 type 으로 `extra_blocks` 를 만들면 거절됩니다.',
]

const MODE_CURATED_DONTS = [
  '허용 위젯 목록에 없는 type 으로 `extra_blocks` 만들기 → 거절',
]

// ─────────────────────────────────────────────────────────────────────
// Shared text fragments that appear in multiple skeletons. Keeping
// them as constants (rather than inline string-templating each time)
// makes drift between modes impossible — the JSON shell header, the
// block_sections explainer, the closing user-input marker.
// ─────────────────────────────────────────────────────────────────────

// "Full processing" directive that fronts every skeleton intro. Two
// real-world failure modes it counters:
//   (a) "Lost in the middle" — well-documented LLM attention bias where
//       long inputs get partly skipped, especially the middle section.
//   (b) Chat UIs that auto-collapse pasted long prompts into a "file"
//       preview; some models then only process the visible head. The
//       wording explicitly names the last section ("사용자 입력") and
//       asks for a loud failure when the AI can't see the tail —
//       hallucinating from a partial prompt is worse than refusing.
const _COMPLETENESS_DIRECTIVE = `\
★ 처리 보장 — 이 프롬프트는 깁니다. 위젯 카탈로그·예시·"절대 하지 말 것"·맨 끝의 "== 사용자 입력 ==" 섹션까지 **전부** 읽고 참조하세요. 사용자 입력은 가장 마지막 섹션에 옵니다. 중간만 보고 출력을 만들지 마세요. 만약 프롬프트가 잘려 사용자 입력 섹션이 끝까지 보이지 않거나 텍스트가 잘려 있다면, 답을 추측하지 말고 응답 첫 줄에 \`"_ERROR": "prompt_truncated"\` 만 출력 후 멈추세요.`

const _INTRO = `\
당신은 ReportArchive 보고서 작성 도우미입니다.
사용자 입력(자유 텍스트, 메모, 표 등)을 분석해, 아래 위젯들을 자유롭게 조합한 JSON 한 덩어리만 출력합니다.
JSON 외의 설명·주석·마크다운 코드펜스(\`\`\`)는 일체 출력하지 마세요. 응답은 반드시 \`{\` 로 시작해 \`}\` 로 끝나야 합니다.

${_COMPLETENESS_DIRECTIVE}`

const _INTRO_CURATED = `\
당신은 ReportArchive 보고서 작성 도우미입니다.
사용자 입력(자유 텍스트, 메모, 표 등)을 분석해, **아래 명시된 위젯들만** 조합한 JSON 한 덩어리만 출력합니다.
JSON 외의 설명·주석·마크다운 코드펜스(\`\`\`)는 일체 출력하지 마세요. 응답은 반드시 \`{\` 로 시작해 \`}\` 로 끝나야 합니다.

${_COMPLETENESS_DIRECTIVE}`

const _BLOCK_SECTIONS_INTRO = `\
\`pages[].block_sections\` 는 \`{ "block_id": "item_code" }\` 형식의 맵입니다. 각 블록에 "이 블록이 어느 단락(섹션)에 속하는지" 표시하는 메타데이터로, 보고서 화면에서 색상 칩으로 표시됩니다.
- 키 = 같은 페이지 안에 존재하는 블록 id
- 값 = 아래 taxonomy 의 \`code\` 문자열 (정확히 일치해야 함, label/한글이름 사용 금지)
- 모든 블록에 달 필요 없음. 단락 구분이 분명한 블록만 태깅.
- 같은 code 를 여러 블록에 사용 가능 (한 단락에 여러 위젯).
- 아래 taxonomy 에 없는 code 는 사용 금지. 적절한 항목이 없으면 그 블록은 그냥 생략.

아래는 현재 워크스페이스에 등록된 단락 구분 taxonomy 입니다 (카테고리별 그룹).

{{section_taxonomy}}`

const _USER_INPUT_MARKER = `\
== 사용자 입력 ==
<<여기에 보고서로 만들고 싶은 내용을 붙여 넣으세요>>`

// ─────────────────────────────────────────────────────────────────────
// SKELETONS — assembled via _renderRules / _renderDonts so the rule
// numbering and bullet style stays consistent.
// ─────────────────────────────────────────────────────────────────────

function _skeletonNewReport(purpose, extraRules, extraDonts) {
  return `\
${_INTRO}
${_purposeBlock(purpose)}
== 출력 JSON 전체 구조 ==
top-level 형식은 아래와 같습니다. \`pages\` 배열에 페이지를 1개 이상 만들고, 각 페이지 안에서는 위젯 블록을 \`extra_blocks\` 에 선언하고, 같은 \`id\` 를 키로 \`content\` 에 데이터를 넣으세요.
{
  "_type": "report_archive_draft_v1",
  "title": "<보고서 제목>",
  "report_date": "<YYYY-MM-DD>",
  "tags": [],
  "pages": [
    {
      "template_id": "{{template_id}}",
      "template_version": {{template_version}},
      "name": null,
      "extra_blocks": [
        { "id": "<block_id_1>", "type": "<widget_type>", "props": { /* 위젯 props */ } },
        { "id": "<block_id_2>", "type": "<widget_type>", "props": { /* 위젯 props */ } }
      ],
      "content": {
        "<block_id_1>": { /* 해당 위젯의 content 형식 */ },
        "<block_id_2>": { /* 해당 위젯의 content 형식 */ }
      },
      "layout_overrides": null,
      "props_overrides": null,
      "blocks_order": [],
      "block_sections": {
        "<block_id_1>": "<단락 구분 item code>"
      }
    }
  ]
}

== 작성 규칙 ==
${_renderRules(MODE_NEW_REPORT_RULES, COMMON_RULES, extraRules)}

== 단락 구분 (block_sections) ==
${_BLOCK_SECTIONS_INTRO}

== 절대 하지 말 것 (체크리스트) ==
${_renderDonts(MODE_NEW_REPORT_DONTS, COMMON_DONTS, extraDonts)}

== 위젯 카탈로그 (전체 목록 / props_schema 원본) ==
{{widget_catalog}}

== 위젯별 props / content 예시 ==
{{widget_examples}}

== 작성 흐름 ==
① 사용자 입력을 훑어 섹션/표/리스트/수치 등을 식별 → ② 각 조각을 어떤 위젯으로 표현할지 결정 → ③ extra_blocks 에 블록을 선언하고 같은 id 로 content 채움 → ④ 단락 구분이 분명한 블록은 block_sections 에 태깅 → ⑤ JSON 만 출력.

${_USER_INPUT_MARKER}
`
}

function _skeletonFillTemplate(purpose, extraRules, extraDonts) {
  return `\
${_INTRO}
${_purposeBlock(purpose)}
== 출력 JSON 전체 구조 ==
top-level 형식은 아래와 같습니다. \`pages[0].content\` 의 키는 아래 "템플릿에 이미 배치된 위젯" 섹션의 id 와 1:1 로 대응합니다. 부족할 때만 \`extra_blocks\` 에 새 위젯을 추가하고, 같은 id 를 \`content\` 에도 넣으세요.
{
  "_type": "report_archive_draft_v1",
  "title": "<보고서 제목>",
  "report_date": "<YYYY-MM-DD>",
  "tags": [],
  "pages": [
    {
      "template_id": "{{template_id}}",
      "template_version": {{template_version}},
      "name": null,
      "extra_blocks": [],
      "content": { /* 아래 템플릿 블록 id 들을 키로 채우세요 */ },
      "layout_overrides": null,
      "props_overrides": null,
      "blocks_order": [],
      "block_sections": { "<block_id>": "<단락 구분 item code>" }
    }
  ]
}

== 템플릿에 이미 배치된 위젯 (★ 우선 사용 ★) ==
아래 블록들은 현재 페이지 템플릿에 이미 배치되어 있습니다. **반드시 이 id 들을 그대로 사용해 \`content[id]\` 를 채우세요.**
- props 는 템플릿이 정한 값이며, 절대 수정하지 마세요. (\`props_overrides\` 도 비워두세요.)
- 사용자 입력의 각 조각을 보고, 의미가 맞는 블록의 content 를 채웁니다.
- 대응하는 블록이 정말 없을 때만 \`extra_blocks\` 에 새 위젯을 추가하세요.
- 이 목록에 있는 블록은 절대 삭제·이름변경하지 마세요. (사용할 내용이 없으면 content 에서 그 id 만 비워 두면 됩니다.)

{{template_blocks}}

== 부족한 위젯을 추가하는 방법 (extra_blocks) ==
템플릿에 없는 위젯이 필요하면 \`extra_blocks\` 에 \`{ id, type, props }\` 형식으로 새 블록을 선언하고, 같은 id 를 키로 \`content[id]\` 에 데이터를 넣으세요.
- \`id\` 는 정규식 \`^[a-z][a-z0-9_]{0,63}$\` 를 만족해야 하며, 위 템플릿 블록 id 와 충돌하지 않아야 합니다.
- 새 블록의 \`props\` 는 아래 "위젯 카탈로그"의 \`props_schema\` 와 정확히 일치해야 합니다 (\`additionalProperties: false\`).
- 꼭 필요한 위젯만 추가하세요. 무리하게 만들지 말 것.

== 작성 규칙 ==
${_renderRules(MODE_FILL_TEMPLATE_RULES, COMMON_RULES, extraRules)}

== 단락 구분 (block_sections) ==
${_BLOCK_SECTIONS_INTRO}

== 절대 하지 말 것 (체크리스트) ==
${_renderDonts(MODE_FILL_TEMPLATE_DONTS, COMMON_DONTS, extraDonts)}

== 위젯별 props / content 예시 ==
{{widget_examples}}

== 작성 흐름 ==
① 사용자 입력을 훑어 섹션/표/리스트/수치 등을 식별 → ② 위 "템플릿에 이미 배치된 위젯" 목록을 보고 각 조각을 어느 블록 id 에 채울지 결정 → ③ 빠진 위젯이 있을 때만 \`extra_blocks\` 에 새 블록을 선언 → ④ 단락 구분이 분명한 블록은 block_sections 에 태깅 → ⑤ JSON 만 출력.

${_USER_INPUT_MARKER}
`
}

function _skeletonCurated(purpose, extraRules, extraDonts, widgets) {
  const widgetTokens =
    widgets.length === 0
      ? '(위젯이 선택되지 않았습니다. Easy 폼에서 최소 1개 이상 선택하세요.)'
      : widgets.map((w) => `{{widget:${w}}}`).join('\n\n')
  return `\
${_INTRO_CURATED}
${_purposeBlock(purpose)}
== 출력 JSON 전체 구조 ==
{
  "_type": "report_archive_draft_v1",
  "title": "<보고서 제목>",
  "report_date": "<YYYY-MM-DD>",
  "tags": [],
  "pages": [
    {
      "template_id": "{{template_id}}",
      "template_version": {{template_version}},
      "name": null,
      "extra_blocks": [
        { "id": "<block_id>", "type": "<허용 위젯 type 중 하나>", "props": { /* 위젯 props */ } }
      ],
      "content": {
        "<block_id>": { /* 해당 위젯의 content 형식 */ }
      },
      "layout_overrides": null,
      "props_overrides": null,
      "blocks_order": [],
      "block_sections": { "<block_id>": "<단락 구분 item code>" }
    }
  ]
}

== 작성 규칙 ==
${_renderRules(MODE_CURATED_RULES, COMMON_RULES, extraRules)}

== 단락 구분 (block_sections) ==
${_BLOCK_SECTIONS_INTRO}

== 절대 하지 말 것 (체크리스트) ==
${_renderDonts(MODE_CURATED_DONTS, COMMON_DONTS, extraDonts)}

== 허용 위젯 (이 목록 외 사용 금지) ==
${widgetTokens}

== 작성 흐름 ==
① 사용자 입력을 훑어 → ② 허용 위젯 중 어느 것으로 표현할지 결정 → ③ extra_blocks 에 선언 + content 채움 → ④ 단락 구분이 분명한 블록은 block_sections 에 태깅 → ⑤ JSON 만 출력.

${_USER_INPUT_MARKER}
`
}

// ─────────────────────────────────────────────────────────────────────
// Inline-block helpers
// ─────────────────────────────────────────────────────────────────────

function _purposeBlock(purpose) {
  const trimmed = (purpose ?? '').trim()
  if (!trimmed) return ''
  return `\n== 이 프롬프트의 용도 ==\n${trimmed}\n`
}

/** Render the rules list as a numbered Markdown list. Mode-contract
 *  rules come first, then COMMON_RULES, then the user's extra_rules.
 *  Numbering is continuous across all three groups so a single fixed
 *  numbering reads naturally in the body. */
function _renderRules(modeRules, commonRules, extraRules) {
  const cleanExtras = (extraRules ?? [])
    .map((r) => (r ?? '').trim())
    .filter(Boolean)
  const all = [...modeRules, ...commonRules, ...cleanExtras]
  return all.map((r, i) => `${i + 1}. ${r}`).join('\n')
}

/** Render the don'ts list as a `- ` bullet list. Same ordering rationale
 *  as _renderRules: mode contract → common → user extras. */
function _renderDonts(modeDonts, commonDonts, extraDonts) {
  const cleanExtras = (extraDonts ?? [])
    .map((d) => (d ?? '').trim())
    .filter(Boolean)
  const all = [...modeDonts, ...commonDonts, ...cleanExtras]
  return all.map((d) => `- ${d}`).join('\n')
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/** Normalize a possibly-partial builder state from settings.builder into
 *  the full shape the form code expects. Tolerant of legacy/missing
 *  fields so we never throw on load. */
export function normalizeBuilderState(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BUILDER_STATE }
  const mode = BUILDER_MODES.some((m) => m.key === raw.mode)
    ? raw.mode
    : DEFAULT_BUILDER_STATE.mode
  return {
    mode,
    purpose: typeof raw.purpose === 'string' ? raw.purpose : '',
    extra_rules: Array.isArray(raw.extra_rules)
      ? raw.extra_rules.filter((x) => typeof x === 'string')
      : [],
    extra_donts: Array.isArray(raw.extra_donts)
      ? raw.extra_donts.filter((x) => typeof x === 'string')
      : [],
    widgets: Array.isArray(raw.widgets)
      ? raw.widgets.filter((x) => typeof x === 'string')
      : [],
  }
}

/** Render the prompt body from a (normalized) Easy-form state. */
export function assemblePromptBody(state) {
  const s = normalizeBuilderState(state)
  if (s.mode === 'fill_template') {
    return _skeletonFillTemplate(s.purpose, s.extra_rules, s.extra_donts)
  }
  if (s.mode === 'curated') {
    return _skeletonCurated(s.purpose, s.extra_rules, s.extra_donts, s.widgets)
  }
  return _skeletonNewReport(s.purpose, s.extra_rules, s.extra_donts)
}
