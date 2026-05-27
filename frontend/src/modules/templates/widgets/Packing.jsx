/**
 * Circle Packing widget.
 *
 * Same long-form `{label, parent, value, color}` data model as Treemap
 * — what differs is the rendering: instead of squarified rectangles we
 * lay out nested circles with d3-hierarchy's pack layout, then render
 * them as plain SVG. Plotly has no built-in trace for circle packing
 * so we draw the geometry ourselves; bonus is exact control over
 * grouping colors + hover behavior that doesn't fight Plotly.
 *
 * The editor surface mirrors Treemap's (50/50 chart + table + toolbar
 * with paste support) so authors switch between the two without
 * relearning the data entry.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { hierarchy as d3Hierarchy, pack as d3Pack } from 'd3-hierarchy'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  CaptionInput,
  DataTableActions,
  LabelField,
  PreviewLabel,
  captionSkipProps,
  toTsv,
} from './_shared'

const COLORSCALE_OPTIONS = [
  { value: '', label: '(자동 — 최상위 그룹별 색상)' },
  { value: 'Viridis', label: '비리디스 (보라→노랑)' },
  { value: 'Plasma', label: '플라즈마 (보라→노랑)' },
  { value: 'Cividis', label: '시비디스 (색약 친화)' },
  { value: 'Hot', label: '핫 (검정→빨강→노랑)' },
  { value: 'RdBu', label: '빨강↔파랑' },
  { value: 'Bluered', label: '파랑→흰→빨강' },
  { value: 'Portland', label: '포틀랜드' },
  { value: 'Jet', label: '제트 (무지개, 레거시)' },
]

const TEXT_INFO_OPTIONS = [
  { value: 'label', label: '라벨만' },
  { value: 'label+value', label: '라벨 + 값' },
  { value: 'label+value+percent', label: '라벨 + 값 + 부모 대비 %' },
  { value: 'value', label: '값만' },
  { value: 'none', label: '표시 안 함' },
]

// Group palette — same family as Treemap's so the two widgets feel
// like siblings.
const PACKING_GROUP_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

// Sampleable colorscale stops — copied from Pie.jsx so packing's
// numeric coloring matches what other widgets produce.
const COLORSCALE_PRESETS = {
  Viridis: [
    '#440154', '#482878', '#3e4989', '#31688e', '#26828e',
    '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725',
  ],
  Plasma: [
    '#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786',
    '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921',
  ],
  Cividis: [
    '#00204c', '#002767', '#1d3463', '#39446b', '#4e556a',
    '#62656b', '#777868', '#8e8c5e', '#a8a04d', '#c7b94e',
    '#e7d56a', '#fdea45',
  ],
  Hot: ['#000000', '#700000', '#e00000', '#ff7f00', '#ffff00', '#ffff7f', '#ffffff'],
  RdBu: [
    '#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0',
    '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f',
  ],
  Bluered: ['#0000ff', '#5050ff', '#a0a0ff', '#ffffff', '#ffa0a0', '#ff5050', '#ff0000'],
  Portland: ['#0c3383', '#0a88ba', '#f2d338', '#f28f38', '#d91e1e'],
  Jet: ['#000080', '#0000ff', '#00ffff', '#80ff80', '#ffff00', '#ff8000', '#800000'],
}

function lerpHex(a, b, t) {
  const ah = a.replace('#', '')
  const bh = b.replace('#', '')
  const ar = parseInt(ah.slice(0, 2), 16)
  const ag = parseInt(ah.slice(2, 4), 16)
  const ab = parseInt(ah.slice(4, 6), 16)
  const br = parseInt(bh.slice(0, 2), 16)
  const bg = parseInt(bh.slice(2, 4), 16)
  const bb = parseInt(bh.slice(4, 6), 16)
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bc = Math.round(ab + (bb - ab) * t)
  return `#${[r, g, bc].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

function colorAt(scaleName, t, reverse = false) {
  const stops = COLORSCALE_PRESETS[scaleName] ?? COLORSCALE_PRESETS.Viridis
  const clamped = Math.max(0, Math.min(1, reverse ? 1 - t : t))
  const pos = clamped * (stops.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(stops.length - 1, lo + 1)
  return lerpHex(stops[lo], stops[hi], pos - lo)
}

// Default starter — single root with three children so a freshly
// inserted widget renders something meaningful.
const DEFAULT_ROWS = [
  { label: '전체', parent: '', value: null },
  { label: 'A', parent: '전체', value: 30 },
  { label: 'B', parent: '전체', value: 20 },
  { label: 'C', parent: '전체', value: 15 },
]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function PackingPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="비용 분해"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function PackingPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="원 패킹 차트">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 60 40" className="w-20 h-14">
          <circle cx="30" cy="20" r="19" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
          <circle cx="22" cy="18" r="10" fill="#6366f1" />
          <circle cx="40" cy="14" r="7" fill="#10b981" />
          <circle cx="40" cy="28" r="6" fill="#f59e0b" />
          <circle cx="22" cy="18" r="4" fill="#a5b4fc" />
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function PackingEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const rows = useMemo(
    () =>
      Array.isArray(content?.rows) && content.rows.length > 0
        ? content.rows
        : DEFAULT_ROWS,
    [content?.rows],
  )
  const colorscale = content?.colorscale ?? ''
  const reverseScale = content?.reverse_scale ?? false
  const textInfo = content?.text_info ?? 'label+value+percent'
  const padding = Number.isFinite(content?.padding) ? content.padding : 4
  const unit = content?.unit ?? ''

  // Aggregate (used both for the rendered chart and the "parent is a
  // computed sum" affordance in the rows table).
  const computedValues = useMemo(() => aggregateRowValues(rows), [rows])
  const labelsWithChildren = useMemo(() => {
    const set = new Set()
    for (const r of rows) {
      const p = (r?.parent ?? '').trim()
      if (p) set.add(p)
    }
    return set
  }, [rows])

  function patch(next) {
    const merged = { ...(content ?? {}), rows, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.unit) delete merged.unit
    if (!merged.colorscale) delete merged.colorscale
    if (!merged.reverse_scale) delete merged.reverse_scale
    if (!merged.text_info || merged.text_info === 'label+value+percent') {
      delete merged.text_info
    }
    if (merged.padding == null || merged.padding === 4) delete merged.padding
    if (Array.isArray(merged.rows) && merged.rows.length === 0) delete merged.rows
    onChange(merged)
  }

  function setCell(idx, field, value) {
    const next = rows.map((r, i) => {
      if (i !== idx) return r
      if (field === 'value') {
        const n = value === '' || value == null ? null : Number(value)
        return { ...r, value: Number.isFinite(n) ? n : null }
      }
      return { ...r, [field]: value }
    })
    patch({ rows: next })
  }
  function addRow() {
    patch({ rows: [...rows, { label: '', parent: '', value: null }] })
  }
  function removeRow(idx) {
    if (rows.length <= 1) return
    patch({ rows: rows.filter((_, i) => i !== idx) })
  }

  function pasteAtTable(startRowIdx, startField, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    let body = grid
    const firstLower = (grid[0] || []).map((s) =>
      String(s ?? '').trim().toLowerCase(),
    )
    const headerHit = firstLower.some((s) =>
      ['label', 'parent', 'value', 'color', '이름', '부모', '값', '색상'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['label', 'parent', 'value', 'color']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...rows]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ label: '', parent: '', value: null })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = {
        ...(nextRows[startRowIdx + r] ?? { label: '', parent: '', value: null }),
      }
      for (let c = 0; c < body[r].length; c += 1) {
        const fieldIdx = startFieldIdx + c
        if (fieldIdx >= fieldOrder.length) break
        const field = fieldOrder[fieldIdx]
        const raw = body[r][c]
        if (field === 'value') {
          target.value = coerceNumOrNull(raw)
        } else {
          target[field] = String(raw ?? '').trim()
        }
      }
      nextRows[startRowIdx + r] = target
    }
    patch({ rows: nextRows })
  }

  if (readOnly) {
    return (
      <div className={autoFit ? 'space-y-2' : 'flex flex-col h-full gap-2 min-h-0'}>
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
        />
        <div className={autoFit ? '' : 'flex-1 min-h-0'}>
          <PackingCanvas
            rows={rows}
            colorscale={colorscale}
            reverseScale={reverseScale}
            textInfo={textInfo}
            padding={padding}
            unit={unit}
            autoFit={autoFit}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full gap-3 min-h-0">
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
        {...captionSkipProps({ content, patch })}
      />

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">색상:</span>
          <select
            value={colorscale}
            onChange={(e) => patch({ colorscale: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {COLORSCALE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {colorscale && (
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={reverseScale}
              onChange={(e) => patch({ reverse_scale: e.target.checked })}
            />
            <span className="text-muted-foreground">색 반전</span>
          </label>
        )}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">표시:</span>
          <select
            value={textInfo}
            onChange={(e) => patch({ text_info: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {TEXT_INFO_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">간격:</span>
          <Input
            type="number"
            min={0}
            max={20}
            value={padding}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ padding: Number.isFinite(v) ? v : 4 })
            }}
            className="h-7 w-16 text-xs"
          />
        </div>
        <div
          className="flex items-center gap-1"
          title="값 옆에 붙는 단위 (예: 억원, 건)"
        >
          <span className="text-muted-foreground">단위:</span>
          <Input
            value={unit}
            onChange={(e) => patch({ unit: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-20 text-xs"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          <PackingCanvas
            rows={rows}
            colorscale={colorscale}
            reverseScale={reverseScale}
            textInfo={textInfo}
            padding={padding}
            unit={unit}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="패킹 데이터"
              onCopy={() => {
                const header = ['label', 'parent', 'value', 'color']
                const body = rows.map((r) => [
                  r?.label ?? '',
                  r?.parent ?? '',
                  r?.value ?? '',
                  r?.color ?? '',
                ])
                return toTsv([header, ...body])
              }}
              onClear={() => patch({ rows: [] })}
            />
          </div>
          <PackingRowsTable
            rows={rows}
            onCellChange={setCell}
            onAdd={addRow}
            onRemove={removeRow}
            onMultiPaste={pasteAtTable}
            labelsWithChildren={labelsWithChildren}
            computedValues={computedValues}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            `parent` 는 다른 row 의 `label` 과 일치해야 하며 비워두면 루트. 자식이 있는 row 의 value 는 자동으로 자식 합. color 는 hex/CSS (선택).
          </p>
        </div>
      </div>
    </div>
  )
}

function PackingRowsTable({
  rows,
  onCellChange,
  onAdd,
  onRemove,
  onMultiPaste,
  labelsWithChildren,
  computedValues,
}) {
  function handlePaste(e, ri, field) {
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onMultiPaste?.(ri, field, text)
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">label</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">parent</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">value</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">color</th>
            <th className="border border-muted bg-muted/30 w-7" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const isAuto = labelsWithChildren?.has(row?.label)
            return (
              <tr key={ri}>
                <td className="border border-muted p-0">
                  <Input
                    value={row?.label ?? ''}
                    onChange={(e) => onCellChange(ri, 'label', e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, 'label')}
                    className="h-7 w-full text-[11px] border-0"
                  />
                </td>
                <td className="border border-muted p-0">
                  <Input
                    value={row?.parent ?? ''}
                    onChange={(e) => onCellChange(ri, 'parent', e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, 'parent')}
                    className="h-7 w-full text-[11px] border-0"
                    placeholder="(루트면 비움)"
                  />
                </td>
                <td className="border border-muted p-0">
                  {isAuto ? (
                    <Input
                      type="text"
                      disabled
                      readOnly
                      value={
                        Number.isFinite(computedValues?.[ri])
                          ? `Σ ${computedValues[ri]}`
                          : 'Σ ?'
                      }
                      className="h-7 w-full text-[11px] text-center border-0 bg-muted/40 text-muted-foreground italic"
                      title="자식 합으로 자동 계산"
                    />
                  ) : (
                    <Input
                      type="number"
                      value={row?.value === null || row?.value === undefined ? '' : row.value}
                      onChange={(e) => onCellChange(ri, 'value', e.target.value)}
                      onPaste={(e) => handlePaste(e, ri, 'value')}
                      className="h-7 w-full text-[11px] text-center border-0"
                    />
                  )}
                </td>
                <td className="border border-muted p-0">
                  <Input
                    value={row?.color ?? ''}
                    onChange={(e) => onCellChange(ri, 'color', e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, 'color')}
                    className="h-7 w-full text-[11px] border-0"
                    placeholder="#3b82f6"
                  />
                </td>
                <td className="text-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive"
                    disabled={rows.length <= 1}
                    onClick={() => onRemove(ri)}
                    title="행 삭제"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            )
          })}
          <tr>
            <td colSpan={5} className="text-center pt-1">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAdd}>
                <Plus className="h-3 w-3 mr-1" /> 행 추가
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Canvas                                                                        //
// --------------------------------------------------------------------------- //

function PackingCanvas({
  rows,
  colorscale = '',
  reverseScale = false,
  textInfo = 'label+value+percent',
  padding = 4,
  unit = '',
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // Measure the cell so the SVG packing can fill it. autoFit makes
  // the cell square (height tracks width).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const measure = () => {
      const w = el.clientWidth
      const h = autoFit ? Math.max(240, w) : el.clientHeight
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [autoFit])

  // Build the d3 hierarchy + lay out the pack. Filter incomplete rows
  // first so half-typed labels don't crash the algorithm.
  const layout = useMemo(() => {
    const w = Math.max(size.w, 1)
    const h = Math.max(size.h, 1)
    const cleaned = (rows ?? []).filter((r) => (r?.label ?? '').trim().length > 0)
    if (cleaned.length === 0) return null

    const byLabel = new Map(cleaned.map((r) => [r.label, r]))
    // Re-root anyone whose parent isn't in the data — keeps the layout
    // from silently dropping orphaned rows.
    const sanitized = cleaned.map((r) => ({
      ...r,
      parent: r.parent && byLabel.has(r.parent) ? r.parent : '',
    }))

    // Build the tree. There may be multiple roots; if so, wrap them in
    // a synthetic root so d3.pack can lay them out together.
    const sanitizedByLabel = new Map(sanitized.map((r) => [r.label, r]))
    const childrenOf = new Map()
    for (const r of sanitized) {
      const p = r.parent || '__root__'
      if (!childrenOf.has(p)) childrenOf.set(p, [])
      childrenOf.get(p).push(r.label)
    }
    // Cycle guard — same shape as aggregateRowValues. A parent loop in
    // the data would otherwise recurse forever and blow the stack.
    const buildVisiting = new Set()
    function buildNode(label) {
      const row = sanitizedByLabel.get(label)
      if (buildVisiting.has(label)) {
        return {
          name: label,
          value: 0,
          children: undefined,
          color: row?.color || null,
        }
      }
      buildVisiting.add(label)
      const kids = (childrenOf.get(label) ?? []).map(buildNode)
      buildVisiting.delete(label)
      return {
        name: label,
        value: kids.length === 0 ? (Number.isFinite(row?.value) ? row.value : 0) : 0,
        children: kids.length > 0 ? kids : undefined,
        color: row?.color || null,
      }
    }
    const rootLabels = childrenOf.get('__root__') ?? []
    const tree =
      rootLabels.length === 1
        ? buildNode(rootLabels[0])
        : {
            name: '__root__',
            children: rootLabels.map(buildNode),
            value: 0,
          }
    const root = d3Hierarchy(tree).sum((d) => d.value || 0)
    if (!root.value || root.value <= 0) return null
    const packed = d3Pack()
      .size([w, h])
      .padding(padding)(root)
    return { root: packed, syntheticRoot: rootLabels.length !== 1 }
  }, [rows, size.w, size.h, padding])

  // Color resolver — single root → root's direct children are the
  // groups; multiple roots → roots themselves are the groups. Same
  // rule the treemap uses, restated here so colorscale + per-row
  // overrides + group fallback all live in one place.
  const colorOf = useMemo(() => {
    if (!layout) return () => '#94a3b8'
    const { root, syntheticRoot } = layout
    const groupAncestorOf = (node) => {
      // walk up until the parent is the (real or synthetic) root
      let cur = node
      while (cur.parent && (syntheticRoot ? cur.parent.depth > 0 : cur.parent.parent)) {
        cur = cur.parent
      }
      return cur
    }
    // Stable group order = first appearance in `root.descendants()`
    const groupOrder = []
    const groupSet = new Set()
    for (const n of root.descendants()) {
      if (n === root) continue
      const g = groupAncestorOf(n)
      if (!groupSet.has(g.data.name)) {
        groupSet.add(g.data.name)
        groupOrder.push(g.data.name)
      }
    }
    const total = root.value || 1
    return (node) => {
      // Per-node explicit color wins everywhere.
      if (node.data?.color) return node.data.color
      // Synthetic root or real root → neutral grey (mostly invisible
      // anyway since children cover it).
      if (node === root || (syntheticRoot && node.depth === 0)) {
        return '#e2e8f0'
      }
      if (colorscale) {
        // colorscale mode — map the leaf's share of the total. For
        // non-leaves (intermediate parents) use the same metric.
        return colorAt(colorscale, node.value / total, reverseScale)
      }
      const g = groupAncestorOf(node)
      const idx = groupOrder.indexOf(g.data.name)
      return PACKING_GROUP_PALETTE[
        (idx < 0 ? 0 : idx) % PACKING_GROUP_PALETTE.length
      ]
    }
  }, [layout, colorscale, reverseScale])

  // Hover state for the floating tooltip.
  const [hover, setHover] = useState(null)

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-md border bg-background overflow-hidden"
      style={
        autoFit
          ? { height: size.w ? `${Math.max(240, size.w)}px` : '20rem' }
          : { height: '100%', minHeight: '12rem' }
      }
    >
      {layout && size.w > 0 && size.h > 0 ? (
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          style={{ display: 'block' }}
        >
          {/* Two render passes — first draw every circle (in BFS order
              so deeper nodes naturally land on top of shallower ones),
              then draw every label as a second layer. That way parent
              labels never end up underneath a child circle that was
              rendered later in the same <g>. */}
          <g>
            {layout.root.descendants().map((node, i) => {
              if (layout.syntheticRoot && node.depth === 0) return null
              const fill = colorOf(node)
              const isLeaf = !node.children || node.children.length === 0
              return (
                <circle
                  key={`c-${node.data.name}-${i}`}
                  cx={node.x}
                  cy={node.y}
                  r={node.r}
                  fill={fill}
                  fillOpacity={isLeaf ? 0.95 : 0.18}
                  stroke="#ffffff"
                  strokeWidth={isLeaf ? 1 : 1.5}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) => {
                    const total = layout.root.value || 1
                    const parent = node.parent
                    const parentTotal = parent?.value || total
                    // 부모 컨테이너 기준 좌표로 계산. clientX/Y 절대값
                    // 그대로 쓰던 예전 코드는 react-grid-layout 의 grid
                    // item 이 CSS transform 으로 배치돼서 position:fixed
                    // 가 viewport 가 아닌 그 transformed box 기준으로
                    // 잡혀 툴팁이 엉뚱한 위치로 가는 버그가 있었음.
                    const box =
                      containerRef.current?.getBoundingClientRect()
                    const localX = box ? e.clientX - box.left : e.clientX
                    const localY = box ? e.clientY - box.top : e.clientY
                    setHover({
                      x: localX,
                      y: localY,
                      label: node.data.name,
                      value: node.value,
                      pct: (node.value / total) * 100,
                      pctParent: (node.value / parentTotal) * 100,
                    })
                  }}
                  onMouseMove={(e) => {
                    const box =
                      containerRef.current?.getBoundingClientRect()
                    const localX = box ? e.clientX - box.left : e.clientX
                    const localY = box ? e.clientY - box.top : e.clientY
                    setHover((h) =>
                      h ? { ...h, x: localX, y: localY } : h,
                    )
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              )
            })}
          </g>
          <g style={{ pointerEvents: 'none' }}>
            {layout.root.descendants().map((node, i) => {
              if (layout.syntheticRoot && node.depth === 0) return null
              const isLeaf = !node.children || node.children.length === 0
              return (
                <CircleLabel
                  key={`l-${node.data.name}-${i}`}
                  node={node}
                  isLeaf={isLeaf}
                  textInfo={textInfo}
                  unit={unit}
                  totalValue={layout.root.value || 1}
                />
              )
            })}
          </g>
        </svg>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          데이터를 입력하면 패킹이 표시됩니다
        </div>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute z-50 rounded-md px-2 py-1.5 text-[11px] shadow-lg"
          style={{
            // 부모(컨테이너)의 position: relative 와 같이 절대 좌표로
            // 박는다. 컨테이너 우측에서 잘리지 않게 transform 으로 살짝
            // 띄움 — left+12 만 두면 우측 경계 근처에서 잘림.
            left: hover.x + 12,
            top: hover.y + 12,
            background: 'rgba(15, 23, 42, 0.96)',
            color: 'white',
            maxWidth: '280px',
          }}
        >
          <div className="font-semibold">{hover.label}</div>
          <div>
            값: {formatNum(hover.value)}
            {unit ? ` ${unit}` : ''}
          </div>
          <div>부모 대비: {hover.pctParent.toFixed(1)}%</div>
          <div>전체 대비: {hover.pct.toFixed(1)}%</div>
        </div>
      )}
    </div>
  )
}

function CircleLabel({ node, isLeaf, textInfo, unit, totalValue }) {
  if (textInfo === 'none') return null
  // Hide labels when the circle is too small to legibly fit them.
  if (node.r < 14) return null
  const u = unit ? ` ${unit}` : ''
  const pct = (node.value / (node.parent?.value || totalValue)) * 100

  // ─── Parent label — pinned to the top inside-edge of the circle,
  // with a translucent white pill backdrop so it survives even when
  // child circles crowd the area. The "tab at the top" placement is
  // the convention most static circle-packing reports use; the pill
  // backdrop adds the readability that hover would otherwise carry.
  if (!isLeaf) {
    const fontSize = Math.max(10, Math.min(13, node.r / 5))
    const lineH = fontSize + 2
    const pillPadX = 6
    const text = node.data.name || ''
    // Rough width estimate — average glyph is ~0.6em for Korean+Latin
    // mix at this size, slight bump on the conservative side so the
    // pill doesn't clip on the right.
    const textW = Math.min(node.r * 1.8 - pillPadX * 2, text.length * fontSize * 0.7)
    const pillW = textW + pillPadX * 2
    const pillH = lineH + 2
    const cx = node.x
    const top = node.y - node.r + 2 // sit just inside the top edge
    return (
      <g style={{ pointerEvents: 'none' }}>
        <rect
          x={cx - pillW / 2}
          y={top}
          width={pillW}
          height={pillH}
          rx={pillH / 2}
          ry={pillH / 2}
          fill="rgba(255,255,255,0.88)"
          stroke="rgba(15,23,42,0.12)"
          strokeWidth={0.5}
        />
        <text
          x={cx}
          y={top + pillH / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={fontSize}
          fontWeight={700}
          fill="#1e293b"
        >
          {text}
        </text>
      </g>
    )
  }

  // ─── Leaf label — centered inside the slice. Standard packing
  // convention: leaves get the full {label, value, percent} stack
  // since they're the actual data points.
  const parts = []
  if (textInfo.includes('label')) parts.push(node.data.name)
  if (textInfo.includes('value')) parts.push(`${formatNum(node.value)}${u}`)
  if (textInfo.includes('percent')) parts.push(`${pct.toFixed(1)}%`)
  if (textInfo === 'value') parts[0] = `${formatNum(node.value)}${u}`
  const fontSize = Math.max(9, Math.min(14, node.r / 4))
  const lineH = fontSize + 2
  const maxLines = Math.max(1, Math.floor((node.r * 1.6) / lineH))
  const lines = parts.slice(0, maxLines)
  const startDy = -((lines.length - 1) * lineH) / 2
  return (
    <text
      x={node.x}
      y={node.y}
      textAnchor="middle"
      dominantBaseline="middle"
      fontSize={fontSize}
      fontWeight={600}
      fill="#ffffff"
      style={{ pointerEvents: 'none', textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}
    >
      {lines.map((t, i) => (
        <tspan key={i} x={node.x} dy={i === 0 ? startDy : lineH}>
          {t}
        </tspan>
      ))}
    </text>
  )
}

// --------------------------------------------------------------------------- //
// Helpers                                                                       //
// --------------------------------------------------------------------------- //

function aggregateRowValues(rows) {
  const byLabel = new Map(rows.map((r) => [r.label, r]))
  const childrenOf = new Map()
  for (const r of rows) {
    const p = r.parent ?? ''
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(r.label)
  }
  const cache = new Map()
  // Track the labels currently on the recursion stack so we can stop
  // before parent cycles (A→B, B→A or self-parent X→X) blow up the
  // call stack. The user's data is bad in that case, but the editor
  // should keep responding — we just treat cycled nodes as value 0.
  const visiting = new Set()
  function compute(label) {
    if (cache.has(label)) return cache.get(label)
    if (visiting.has(label)) return 0 // cycle guard
    visiting.add(label)
    const kids = childrenOf.get(label) ?? []
    const row = byLabel.get(label)
    let val
    if (kids.length === 0) {
      val = Number.isFinite(row?.value) ? row.value : 0
    } else {
      val = kids.reduce((acc, k) => acc + compute(k), 0)
    }
    visiting.delete(label)
    cache.set(label, val)
    return val
  }
  return rows.map((r) => compute(r.label))
}

function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}

function coerceNumOrNull(raw) {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function formatNum(n) {
  if (n == null || !Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}억`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`
  if (abs % 1 === 0) return n.toLocaleString()
  return parseFloat(n.toFixed(1)).toLocaleString()
}
