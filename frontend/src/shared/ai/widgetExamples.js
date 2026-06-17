/**
 * Per-widget AI-prompt example snippets + cross-widget rules preamble.
 *
 * ⚠️ **단일 소스 = 백엔드 `backend/app/widgets/authoring_rules.json`** ⚠️
 * 이 모듈은 그 json 을 빌드 시 주입받은(`__WIDGET_AUTHORING_RULES__`, vite.config
 * 의 define) 값을 그대로 노출만 한다. MCP(describe_template / describe_widgets)도
 * **같은 json** 을 런타임에 읽으므로, 프런트 '복사용 프롬프트'와 MCP 작성이 항상
 * 동일한 위젯 룰을 쓴다. 위젯/룰을 추가·수정하려면 그 json 한 곳만 고치면 양쪽이
 * 함께 갱신된다. (json 은 과거 이 파일에 하드코딩돼 있던 내용을 그대로 추출 +
 * round-trip 검증해 이전한 것.)
 *
 * 노출 (기존과 동일):
 *   - WIDGET_PROMPT_EXAMPLES : [{ types: string[], body: string }]
 *   - WIDGET_EXAMPLES_TEXT   : preamble + 전체 위젯 예제 (joined)
 *   - renderWidgetExamplesText(excludedTypes) : 일부 위젯 제외 버전
 *   - PROMPT_COVERED_WIDGETS  : 예제가 있는 위젯 타입 Set
 *   - getWidgetExampleBody(type) : 단일 위젯 예제 본문
 */
/* eslint-disable no-undef */
// vite.config 의 define 으로 빌드 시 인라인됨 ({ preamble, examples }).
const _RULES = __WIDGET_AUTHORING_RULES__
/* eslint-enable no-undef */

/** [{ types: string[], body: string }] — 위젯별(또는 위젯 묶음별) ### 예제 블록. */
export const WIDGET_PROMPT_EXAMPLES = _RULES.examples

// 위젯 무관 전역 주의사항 (스키마 규칙 · 환각 키 · 혼동 위젯 쌍 · 값 타입).
export const WIDGET_RULES_PREAMBLE = _RULES.preamble

export const WIDGET_EXAMPLES_TEXT = [
  WIDGET_RULES_PREAMBLE,
  ...WIDGET_PROMPT_EXAMPLES.map((e) => e.body),
].join('\n\n')

/** Same as WIDGET_EXAMPLES_TEXT but with example blocks for widgets in
 *  `excludedTypes` removed. A block is dropped only when *all* of its
 *  `types` are excluded — multi-type entries (e.g. the image/attachment/
 *  cad_3d "don't generate" warning) stay as long as at least one of
 *  their types is still selected, so authors don't accidentally lose
 *  the warning by unchecking just one of the bundled widgets.
 *
 *  The rules preamble (additionalProperties, cross-widget cheat sheet)
 *  is preserved verbatim — it's not widget-specific, and the cheat
 *  sheet still helps even when the AI only sees a subset of widgets.
 *
 *  Pass null/undefined/empty-set to short-circuit and return the
 *  static WIDGET_EXAMPLES_TEXT directly (cheaper, identity-equal). */
export function renderWidgetExamplesText(excludedTypes) {
  if (!excludedTypes || excludedTypes.size === 0) {
    return WIDGET_EXAMPLES_TEXT
  }
  const filtered = WIDGET_PROMPT_EXAMPLES.filter((entry) =>
    entry.types.some((t) => !excludedTypes.has(t)),
  )
  return [WIDGET_RULES_PREAMBLE, ...filtered.map((e) => e.body)].join('\n\n')
}

/** Set of widget `type` strings that have at least one example block. */
export const PROMPT_COVERED_WIDGETS = new Set(
  WIDGET_PROMPT_EXAMPLES.flatMap((e) => e.types),
)

// Index by single widget type → example body, so {{widget:foo}} can
// pull the exact section in O(1). Multi-type entries register the same
// body under each type they cover.
const _BY_TYPE = (() => {
  const map = new Map()
  for (const entry of WIDGET_PROMPT_EXAMPLES) {
    for (const t of entry.types) map.set(t, entry.body)
  }
  return map
})()

/** Body text for a single widget type, or `null` if no example exists.
 *  Caller decides how to surface the gap (e.g. inline a fallback string,
 *  or warn the user). */
export function getWidgetExampleBody(type) {
  return _BY_TYPE.get(type) ?? null
}
