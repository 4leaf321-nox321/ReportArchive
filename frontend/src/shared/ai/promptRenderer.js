/**
 * Client-side prompt body renderer. Takes a prompt's stored `body`
 * (with `{{…}}` placeholder tokens) plus a `context` object carrying
 * the dynamic bits, and returns the fully-expanded text the user
 * eventually copies / sends to an AI.
 *
 * Token vocabulary (mirrored in app/modules/prompts/rendering.py for the
 * widget extraction half — full rendering lives client-side because the
 * source data — widgetCatalog, section taxonomy, examples — already
 * sits on the frontend):
 *
 *   {{template_id}}        — context.templateId  (string, "TEMPLATE_ID_HERE" fallback)
 *   {{template_version}}   — context.templateVersion (integer, 1 fallback)
 *   {{section_taxonomy}}   — context.sectionTaxonomyText
 *   {{widget_catalog}}     — context.widgetCatalogText
 *   {{widget_examples}}    — context.widgetExamplesText
 *   {{template_blocks}}    — context.templateBlocksText
 *   {{widget:foo}}         — inline body of getWidgetExampleBody('foo')
 *
 * Unknown tokens are left intact so they're visible in the rendered
 * output (= author can tell a placeholder is wrong without silent
 * data loss). Same approach the v1/v2 manual builders used.
 */
import {
  getWidgetExampleBody,
  renderWidgetExamplesText,
} from './widgetExamples'
import { renderSectionTaxonomy } from './sectionTaxonomy'

/** Indent every line of `s` by `n` spaces. Used by the catalog/template
 *  block renderers so JSON sections nest cleanly under bullet headers. */
export function indent(s, n) {
  const pad = ' '.repeat(n)
  return s.split('\n').map((line) => pad + line).join('\n')
}

/** Render the widget catalog (all entries) as the same plain-text block
 *  the v1 prompt used to inline. `widgets` is `widgetCatalog?.widgets`. */
export function renderWidgetCatalogText(widgets) {
  if (!Array.isArray(widgets) || widgets.length === 0) {
    return '(위젯 카탈로그를 아직 불러오지 못했습니다. 잠시 후 다시 열어보세요.)'
  }
  return widgets
    .map((w) => {
      const schemaStr = JSON.stringify(w.props_schema ?? {}, null, 2)
      return `### ${w.type} — ${w.label}\n${w.description}\nprops_schema:\n${indent(schemaStr, 2)}`
    })
    .join('\n\n')
}

/** Render the current page's template block list — the v2 "이미 배치된
 *  위젯" block. `blocks` is `template.schema.blocks` from useTemplate.
 *
 *  `excluded` (optional Set<string>) drops blocks whose widget type is
 *  excluded — same set used to filter the catalog/examples blocks, so
 *  the AI never sees those types anywhere in the prompt and won't try
 *  to fill content for them. */
export function renderTemplateBlocksText(blocks, excluded) {
  const all = Array.isArray(blocks) ? blocks : []
  const list =
    excluded && excluded.size > 0
      ? all.filter((b) => !excluded.has(b.type))
      : all
  if (list.length === 0) {
    if (all.length > 0) {
      return '(현재 페이지의 모든 블록이 제외된 위젯 타입이라 목록이 비어 있습니다. 사이드바에서 사용할 위젯 타입을 다시 선택하세요.)'
    }
    return '(현재 페이지에 바인딩된 템플릿을 아직 불러오지 못했거나 비어 있습니다. 잠시 후 다시 열어보세요. 그동안에는 모든 위젯을 `extra_blocks` 에 직접 선언하셔도 됩니다.)'
  }
  return list
    .map((b, i) => {
      const propsStr = JSON.stringify(b.props ?? {}, null, 2)
      return `### [${i + 1}] id="${b.id}"  type=${b.type}\nprops (수정 금지 — 참고용):\n${indent(propsStr, 2)}`
    })
    .join('\n\n')
}

/**
 * Full render entry-point. Returns the prompt text with every token
 * expanded — or with the original token left in place if the context
 * doesn't carry a value for it (visible failure rather than silent
 * empty string).
 *
 * `context` keys are all optional. Convenience wrapper buildContext()
 * below packs the common chunks the report editor already has.
 */
export function renderPrompt(body, context = {}) {
  if (!body) return ''
  let out = body

  // Simple variable substitutions. The token is only replaced if the
  // matching context key is a non-empty string (so an absent template
  // id leaves "{{template_id}}" visible in the output).
  const simple = {
    template_id: context.templateId,
    template_version:
      context.templateVersion != null
        ? String(context.templateVersion)
        : undefined,
    section_taxonomy: context.sectionTaxonomyText,
    widget_catalog: context.widgetCatalogText,
    widget_examples: context.widgetExamplesText,
    template_blocks: context.templateBlocksText,
  }
  for (const [name, value] of Object.entries(simple)) {
    if (value == null || value === '') continue
    out = out.replace(
      new RegExp(`{{\\s*${name}\\s*}}`, 'g'),
      // Escape `$` so JS doesn't interpret `$&`, `$1` etc. as match refs.
      () => String(value),
    )
  }

  // Single-widget inlines. Catalog entries with no example body get
  // replaced by a small inline marker so the author sees the gap
  // immediately (mirrors the "미등록" sidebar chip).
  out = out.replace(
    /{{\s*widget\s*:\s*([a-z][a-z0-9_]*)\s*}}/g,
    (_match, type) => {
      const example = getWidgetExampleBody(type)
      if (example != null) return example
      return `### ${type}  (※ 등록된 example 이 없습니다 — shared/ai/widgetExamples.js 보강 필요)`
    },
  )

  return out
}

/**
 * Pack the chunks the report editor already has into the context shape
 * `renderPrompt` expects. Keeps callers free of the {{widget_*}} naming
 * convention so adding a new token only touches this file.
 *
 *   widgetCatalog        — useWidgetCatalog().catalog (object with .widgets)
 *   sectionCategories    — useSectionTaxonomy() result
 *   templateBlocks       — currentTemplate?.schema?.blocks
 *   templateId/version   — page header values
 *   excludedWidgetTypes  — optional Set<string>. When the prompt body
 *                          uses wildcard tokens ({{widget_catalog}} /
 *                          {{widget_examples}}) the picker dialog lets
 *                          the user uncheck widgets to shrink the
 *                          rendered prompt. Excluded types are dropped
 *                          from the catalog, examples, AND the
 *                          {{template_blocks}} listing — so a page-
 *                          context prompt won't quietly leak unselected
 *                          types back in through the "이미 배치된 위젯"
 *                          section (the AI would otherwise fill content
 *                          for those blocks too). Individual
 *                          {{widget:foo}} tokens are NOT touched —
 *                          they're an explicit author choice we honor
 *                          regardless of exclusion.
 */
export function buildPromptContext({
  widgetCatalog,
  sectionCategories,
  templateBlocks,
  templateId,
  templateVersion,
  excludedWidgetTypes,
} = {}) {
  const excluded = excludedWidgetTypes ?? null
  const allWidgets = widgetCatalog?.widgets ?? []
  const filteredWidgets =
    excluded && excluded.size > 0
      ? allWidgets.filter((w) => !excluded.has(w.type))
      : allWidgets
  return {
    templateId: templateId || 'TEMPLATE_ID_HERE',
    templateVersion: templateVersion ?? 1,
    sectionTaxonomyText: renderSectionTaxonomy(sectionCategories),
    widgetCatalogText: renderWidgetCatalogText(filteredWidgets),
    widgetExamplesText: renderWidgetExamplesText(excluded),
    templateBlocksText: renderTemplateBlocksText(templateBlocks, excluded),
  }
}
