/**
 * widget-v1 builder — converts between the editor's working draft shape
 * and the on-the-wire schema document.
 *
 * Draft shape (state held in TemplateEditorPage):
 *   { name, description, category, owner_workspace_slug,
 *     blocks: [{ id, type, props, layout: {row, col_span, row_span} }] }
 *
 * Schema shape (sent to backend, stored in templates.schema):
 *   { version: 'widget-v1', blocks: [...] }
 *
 * Layout is always present in the draft (the editor needs it to render
 * the grid). On legacy templates without per-block layout, schemaToDraft
 * synthesizes one (each block on its own full-width row).
 */

export const SCHEMA_VERSION = 'widget-v1'
export const GRID_COLS = 12

const ID_RE = /^[a-z][a-z0-9_]{0,63}$/

/** Per-widget initial sizing for the editor's grid. row_span is editor-only
 *  visual fidelity; the rendered report sizes itself from content. */
const DEFAULT_BLOCK_SIZE = {
  heading: { col_span: 12, row_span: 1 },
  rich_text: { col_span: 12, row_span: 4 },
  key_value: { col_span: 12, row_span: 3 },
  bulleted_list: { col_span: 12, row_span: 3 },
  table: { col_span: 12, row_span: 4 },
  image: { col_span: 6, row_span: 4 },
  attachment: { col_span: 12, row_span: 3 },
  chart: { col_span: 6, row_span: 6 },
}

function defaultSize(type) {
  return DEFAULT_BLOCK_SIZE[type] ?? { col_span: 12, row_span: 2 }
}

export function generateBlockId(type, existingIds) {
  const base = type.replace(/[^a-z0-9_]/g, '_')
  let candidate = base
  let n = 2
  while (existingIds.has(candidate)) {
    candidate = `${base}_${n}`
    n += 1
  }
  return candidate
}

export function isValidBlockId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

/**
 * Builds a fresh block instance from a widget catalog entry. The new
 * block is placed on its own row at the bottom of the canvas with the
 * widget's default col_span. Same row packing happens via drag in the editor.
 */
export function newBlock(widgetDescriptor, existingBlocks = []) {
  const existingIds = new Set(existingBlocks.map((b) => b.id))
  const nextRow =
    existingBlocks.length === 0
      ? 1
      : Math.max(...existingBlocks.map((b) => b.layout?.row ?? 1)) + 1
  const size = defaultSize(widgetDescriptor.type)
  return {
    id: generateBlockId(widgetDescriptor.type, existingIds),
    type: widgetDescriptor.type,
    props: structuredClone(widgetDescriptor.default_props ?? {}),
    layout: { row: nextRow, col_span: size.col_span, row_span: size.row_span },
  }
}

export function newEmptyDraft() {
  return {
    name: '',
    description: '',
    category: 'misc',
    // null = global. otherwise array of workspace slugs.
    owner_workspace_slugs: null,
    blocks: [],
  }
}

/** Draft → wire schema document. */
export function draftToSchema(draft) {
  return {
    version: SCHEMA_VERSION,
    blocks: draft.blocks.map((b) => {
      const out = {
        id: b.id,
        type: b.type,
        props: b.props ?? {},
      }
      if (b.layout) {
        out.layout = {
          row: b.layout.row,
          col_span: b.layout.col_span,
          ...(b.layout.row_span ? { row_span: b.layout.row_span } : {}),
        }
      }
      // Optional ontology / aggregation hints — only emit when non-empty
      // so legacy templates without meta stay byte-identical.
      if (b.meta && Object.keys(b.meta).length > 0) {
        out.meta = b.meta
      }
      return out
    }),
  }
}

/**
 * Wire template (TemplateRead) → editor draft. Synthesizes a layout for
 * any block missing one so the editor always has something to position.
 */
export function schemaToDraft(template) {
  const schema = template?.schema ?? {}
  const blocks = Array.isArray(schema.blocks) ? schema.blocks : []
  let synthRow = 0
  return {
    name: template?.name ?? '',
    description: template?.description ?? '',
    category: template?.category ?? 'misc',
    owner_workspace_slugs: template?.owner_workspace_slugs ?? null,
    blocks: blocks.map((b, idx) => {
      let layout = b.layout
      if (!layout) {
        synthRow = (idx === 0 ? 1 : Math.max(synthRow + 1, idx + 1))
        const size = defaultSize(b.type)
        layout = {
          row: synthRow,
          col_span: GRID_COLS,
          row_span: size.row_span,
        }
      } else {
        synthRow = Math.max(synthRow, layout.row)
        layout = {
          row: layout.row,
          col_span: layout.col_span,
          row_span: layout.row_span ?? defaultSize(b.type).row_span,
        }
      }
      return {
        id: b.id,
        type: b.type,
        props: structuredClone(b.props ?? {}),
        layout,
        meta: b.meta ? structuredClone(b.meta) : undefined,
      }
    }),
  }
}

/**
 * Lightweight client-side checks before POST — backend has authoritative
 * validation but catching the obvious problems here gives faster feedback.
 */
export function preflightDraft(draft) {
  const errors = []
  if (!draft.name?.trim()) errors.push('템플릿 이름을 입력하세요.')
  if (draft.blocks.length === 0) errors.push('블록을 최소 1개 추가하세요.')

  const seen = new Set()
  const sumByRow = new Map()
  for (const b of draft.blocks) {
    if (!isValidBlockId(b.id)) {
      errors.push(`블록 id가 유효하지 않습니다: "${b.id}"`)
    }
    if (seen.has(b.id)) errors.push(`중복된 블록 id: "${b.id}"`)
    seen.add(b.id)

    if (b.layout) {
      const row = b.layout.row
      const cs = b.layout.col_span
      if (!Number.isInteger(row) || row < 1) {
        errors.push(`"${b.id}": layout.row 잘못됨`)
      }
      if (!Number.isInteger(cs) || cs < 1 || cs > GRID_COLS) {
        errors.push(`"${b.id}": layout.col_span은 1~${GRID_COLS}`)
      }
      sumByRow.set(row, (sumByRow.get(row) ?? 0) + cs)
    }
  }
  for (const [row, total] of sumByRow) {
    if (total > GRID_COLS) {
      errors.push(`행 ${row}: col_span 합 ${total} (>${GRID_COLS})`)
    }
  }
  return errors
}
