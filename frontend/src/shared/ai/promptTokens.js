/**
 * Client-side mirror of backend's `prompts/rendering.py` token utilities.
 * Keeps the picker preview + edit-form live "위젯 칩" panel free of an
 * extra server roundtrip on every keystroke.
 *
 * The token vocabulary is intentionally tiny — anything more elaborate
 * (loops, conditionals) belongs in a real template engine, which is
 * heavier than the use case warrants.
 *
 *   {{template_id}}, {{template_version}}    — current page context
 *   {{template_blocks}}                       — current page block list
 *   {{section_taxonomy}}                      — admin-managed taxonomy
 *   {{widget_catalog}}                        — full catalog (wildcard)
 *   {{widget_examples}}                       — full examples (wildcard)
 *   {{widget:foo}}                            — inline single-widget block
 */

const WIDGET_TOKEN_RE = /{{\s*widget\s*:\s*([a-z][a-z0-9_]*)\s*}}/g
const WILDCARD_RE = /{{\s*(widget_catalog|widget_examples)\s*}}/

/** Return widget types referenced by `{{widget:foo}}` tokens, in
 *  document order, deduplicated. */
export function extractWidgetTypes(body) {
  if (!body) return []
  const out = new Set()
  for (const m of body.matchAll(WIDGET_TOKEN_RE)) out.add(m[1])
  return [...out]
}

/** True iff the body contains a wildcard token (effectively covers the
 *  entire widget catalog). */
export function hasWildcard(body) {
  if (!body) return false
  return WILDCARD_RE.test(body)
}

export function detectWidgetCoverage(body) {
  return {
    widgetTypes: extractWidgetTypes(body),
    wildcardAll: hasWildcard(body),
  }
}
