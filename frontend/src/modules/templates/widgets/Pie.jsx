/**
 * Pie / Donut widget — flat proportional chart.
 *
 * One trace covers both styles: `chart_type='donut'` just sets a
 * non-zero `hole` on the same Plotly `type: 'pie'`. Data is a flat
 * `rows: [{label, value, color}]` array — no hierarchy (use treemap
 * for that).
 *
 * UX is modeled after the treemap editor: split pane with the chart
 * on the left and an editable rows table on the right; toolbar across
 * the top for colorscale / sort / textinfo / donut hole / label /
 * unit. Multi-cell paste for the rows table; the same DataTableActions
 * (copy / clear) component the other table-driven widgets use.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import Plotly from 'plotly.js-dist'
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

// Pie 는 슬라이스 개수가 적고 값 범위가 좁은 경우가 흔해서 단색 그라데이션
// (Blues/Reds/Greens) 이 시각적으로 거의 한 톤처럼 깔리는 문제가 있음 —
// 의도적으로 제외하고 multi-hue 스케일만 노출. 다른 위젯(Heatmap, Contour,
// Treemap …) 의 COLORSCALE_OPTIONS 는 별도 정의라 영향 없음.
const COLORSCALE_OPTIONS = [
  { value: '', label: '(자동 — 카테고리 팔레트)' },
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
  { value: 'label+percent', label: '라벨 + %' },
  { value: 'label+value', label: '라벨 + 값' },
  { value: 'label+value+percent', label: '라벨 + 값 + %' },
  { value: 'percent', label: '% 만' },
  { value: 'value', label: '값만' },
  { value: 'none', label: '표시 안 함' },
]

const TEXT_POSITION_OPTIONS = [
  { value: 'auto', label: '자동' },
  { value: 'inside', label: '슬라이스 안' },
  { value: 'outside', label: '슬라이스 밖' },
  { value: 'none', label: '표시 안 함' },
]

const CHART_TYPE_OPTIONS = [
  { value: 'pie', label: '파이' },
  { value: 'donut', label: '도넛' },
]

const DEFAULT_ROWS = [
  { label: 'A', value: 30 },
  { label: 'B', value: 20 },
  { label: 'C', value: 15 },
]

// Categorical fallback palette — used when `colorscale` isn't set and
// a row didn't specify its own `color`. Matching treemap's group
// palette keeps the visual language consistent across the proportion
// widgets.
const PIE_FALLBACK_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

// Named colorscale → hex stops. We sample these client-side instead of
// relying on Plotly's `marker.colorscale` on pie traces — that path is
// inconsistent in practice (some scales render fine, others fall back
// to the categorical palette). By precomputing the colors here we
// guarantee the dropdown selection actually shows up. Stops taken
// directly from Plotly's built-in colorscale definitions so the visual
// result matches what other widgets (heatmap/contour) render.
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

/** Linear-interpolate between two hex colors. `t` ∈ [0,1]. */
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

/** Pick `count` evenly-spaced colors out of a named colorscale via
 *  piecewise-linear interpolation. Falls back to Viridis if the name
 *  is unknown. */
function sampleColorscale(name, count, reverse = false) {
  const stops = COLORSCALE_PRESETS[name] ?? COLORSCALE_PRESETS.Viridis
  if (count <= 0) return []
  if (count === 1) return [stops[Math.floor(stops.length / 2)]]
  const out = []
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1)
    const pos = t * (stops.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(stops.length - 1, lo + 1)
    out.push(lerpHex(stops[lo], stops[hi], pos - lo))
  }
  return reverse ? out.reverse() : out
}

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function PiePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="비용 구성"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function PiePreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="비중 차트">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 60 60" className="w-16 h-16">
          {/* Three-slice donut sketch */}
          <circle cx="30" cy="30" r="22" fill="#3b82f6" />
          <path d="M 30 30 L 52 30 A 22 22 0 0 1 41 49 Z" fill="#10b981" />
          <path d="M 30 30 L 41 49 A 22 22 0 0 1 14 41 Z" fill="#f59e0b" />
          <circle cx="30" cy="30" r="10" fill="#ffffff" />
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function PieEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const rows = useMemo(
    () =>
      Array.isArray(content?.rows) && content.rows.length > 0
        ? content.rows
        : DEFAULT_ROWS,
    [content?.rows],
  )
  const chartType = content?.chart_type === 'donut' ? 'donut' : 'pie'
  const hole = Number.isFinite(content?.hole) ? content.hole : 0.45
  const colorscale = content?.colorscale ?? ''
  const reverseScale = content?.reverse_scale ?? false
  const textInfo = content?.text_info ?? 'label+percent'
  const textPosition = content?.text_position ?? 'auto'
  const sort = content?.sort !== false // default true
  const showLegend = content?.show_legend !== false // default true
  const unit = content?.unit ?? ''

  function patch(next) {
    const merged = { ...(content ?? {}), rows, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.unit) delete merged.unit
    if (!merged.chart_type || merged.chart_type === 'pie') delete merged.chart_type
    if (merged.hole == null || merged.hole === 0.45) delete merged.hole
    if (!merged.colorscale) delete merged.colorscale
    if (!merged.reverse_scale) delete merged.reverse_scale
    if (!merged.text_info || merged.text_info === 'label+percent') {
      delete merged.text_info
    }
    if (!merged.text_position || merged.text_position === 'auto') {
      delete merged.text_position
    }
    if (merged.sort === undefined || merged.sort === true) delete merged.sort
    if (merged.show_legend === undefined || merged.show_legend === true) {
      delete merged.show_legend
    }
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
    patch({ rows: [...rows, { label: '', value: null }] })
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
      ['label', 'value', 'color', '이름', '항목', '값', '색상'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['label', 'value', 'color']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...rows]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ label: '', value: null })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = {
        ...(nextRows[startRowIdx + r] ?? { label: '', value: null }),
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
          <PieCanvas
            rows={rows}
            chartType={chartType}
            hole={hole}
            colorscale={colorscale}
            reverseScale={reverseScale}
            textInfo={textInfo}
            textPosition={textPosition}
            sort={sort}
            showLegend={showLegend}
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
          <span className="text-muted-foreground">유형:</span>
          <select
            value={chartType}
            onChange={(e) => patch({ chart_type: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {CHART_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {chartType === 'donut' && (
          <div className="flex items-center gap-1" title="0 ~ 0.9. 0 이면 파이, 0.9 면 가는 도넛">
            <span className="text-muted-foreground">구멍:</span>
            <Input
              type="number"
              min={0}
              max={0.9}
              step={0.05}
              value={hole}
              onChange={(e) => {
                const v = Number(e.target.value)
                patch({ hole: Number.isFinite(v) ? v : 0.45 })
              }}
              className="h-7 w-16 text-xs"
            />
          </div>
        )}
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
          <span className="text-muted-foreground">위치:</span>
          <select
            value={textPosition}
            onChange={(e) => patch({ text_position: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {TEXT_POSITION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="끄면 입력한 row 순서대로, 켜면 큰 값부터 시계 방향으로 정렬"
        >
          <input
            type="checkbox"
            checked={sort}
            onChange={(e) => patch({ sort: e.target.checked })}
          />
          <span className="text-muted-foreground">정렬</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showLegend}
            onChange={(e) => patch({ show_legend: e.target.checked })}
          />
          <span className="text-muted-foreground">범례</span>
        </label>
        <div
          className="flex items-center gap-1"
          title="값 옆에 붙는 단위 (예: 억원, %, 건)"
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
          <PieCanvas
            rows={rows}
            chartType={chartType}
            hole={hole}
            colorscale={colorscale}
            reverseScale={reverseScale}
            textInfo={textInfo}
            textPosition={textPosition}
            sort={sort}
            showLegend={showLegend}
            unit={unit}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="파이 데이터"
              onCopy={() => {
                const header = ['label', 'value', 'color']
                const body = rows.map((r) => [
                  r?.label ?? '',
                  r?.value ?? '',
                  r?.color ?? '',
                ])
                return toTsv([header, ...body])
              }}
              onClear={() => patch({ rows: [] })}
            />
          </div>
          <PieRowsTable
            rows={rows}
            onCellChange={setCell}
            onAdd={addRow}
            onRemove={removeRow}
            onMultiPaste={pasteAtTable}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            값이 음수이거나 비어 있는 row 는 차트에서 자동으로 빠집니다. color 는 hex/CSS 컬러 (선택). 엑셀 TSV 붙여넣기 지원.
          </p>
        </div>
      </div>
    </div>
  )
}

function PieRowsTable({ rows, onCellChange, onAdd, onRemove, onMultiPaste }) {
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
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">value</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">color</th>
            <th className="border border-muted bg-muted/30 w-7" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
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
                  type="number"
                  value={row?.value === null || row?.value === undefined ? '' : row.value}
                  onChange={(e) => onCellChange(ri, 'value', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'value')}
                  className="h-7 w-full text-[11px] text-center border-0"
                />
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
          ))}
          <tr>
            <td colSpan={4} className="text-center pt-1">
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

function PieCanvas({
  rows,
  chartType = 'pie',
  hole = 0.45,
  colorscale = '',
  reverseScale = false,
  textInfo = 'label+percent',
  textPosition = 'auto',
  sort = true,
  showLegend = true,
  unit = '',
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState(null)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)

  // Filter rows with usable data — empty labels OR non-positive values
  // get dropped before the trace is built. Plotly tolerates 0 but the
  // resulting "0%" slice clutters the legend without communicating
  // anything.
  const safeRows = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          (r?.label ?? '').toString().trim().length > 0 &&
          Number.isFinite(r?.value) &&
          r.value > 0,
      ),
    [rows],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    let firstCall = true
    const measure = () => {
      const w = el.clientWidth
      if (w <= 0) return
      const next = autoFit ? Math.max(240, w) : w
      setSize((prev) => (prev === next ? prev : next))
      if (firstCall) {
        firstCall = false
        return
      }
      setResizing(true)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => setResizing(false), 200)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    }
  }, [autoFit])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !size) return undefined
    if (resizing) return undefined
    if (safeRows.length === 0) {
      Plotly.react(
        el,
        [],
        { autosize: true, margin: { l: 0, r: 0, t: 0, b: 0 } },
        { displaylogo: false },
      )
      return undefined
    }

    // Plotly's pie `sort` reorders slices visually but doesn't reorder
    // `marker.colors` to match — so when sort=true with explicit
    // colors, the palette gets shuffled relative to the slices. To
    // keep colors aligned to labels we sort the rows ourselves (when
    // requested) and tell Plotly `sort: false` below.
    const orderedRows = sort
      ? [...safeRows].sort((a, b) => b.value - a.value)
      : safeRows
    const labels = orderedRows.map((r) => r.label)
    const values = orderedRows.map((r) => r.value)
    const explicitColors = orderedRows.map((r) => r.color || null)

    // Coloring rules — both modes produce an explicit hex `colors[]`
    // array. Plotly pie's `marker.colorscale` works inconsistently
    // (some scales render, others fall back to default), so we sample
    // the colorscale client-side via COLORSCALE_PRESETS/lerpHex and
    // hand Plotly the resolved hex list directly. That guarantees
    // every named scale renders predictably AND per-row overrides keep
    // working in both modes.
    let resolved
    if (colorscale) {
      const sampled = sampleColorscale(colorscale, orderedRows.length, !!reverseScale)
      resolved = explicitColors.map((c, i) => c || sampled[i])
    } else {
      resolved = explicitColors.map(
        (c, i) => c || PIE_FALLBACK_PALETTE[i % PIE_FALLBACK_PALETTE.length],
      )
    }
    const marker = {
      colors: resolved,
      line: { width: 2, color: '#ffffff' },
    }

    // Value formatting (with unit suffix) lives in texttemplate so the
    // percent / value fields render with a single decimal place rather
    // than Plotly's auto-precision (which looks noisy for round-ish
    // human values).
    const u = unit ? ` ${unit}` : ''
    const TEXT_TEMPLATES = {
      label: '%{label}',
      'label+percent': '%{label}<br>%{percent:.1%}',
      'label+value': `%{label}<br>%{value}${u}`,
      'label+value+percent': `%{label}<br>%{value}${u}<br>%{percent:.1%}`,
      percent: '%{percent:.1%}',
      value: `%{value}${u}`,
      none: '',
    }
    const textTemplate = TEXT_TEMPLATES[textInfo] ?? TEXT_TEMPLATES['label+percent']

    const trace = {
      type: 'pie',
      labels,
      values,
      hole: chartType === 'donut' ? hole : 0,
      // We've already applied the sort above so marker.colors stays
      // aligned with labels; tell Plotly to keep our order.
      sort: false,
      direction: 'clockwise',
      ...(textInfo === 'none'
        ? { textinfo: 'none' }
        : {
            texttemplate: textTemplate,
            textinfo: 'none',
            textposition: textPosition,
          }),
      marker,
      hovertemplate: `<b>%{label}</b><br>값: %{value}${u}<br>비중: %{percent:.1%}<extra></extra>`,
      hoverlabel: {
        bgcolor: 'rgba(15, 23, 42, 0.96)',
        bordercolor: 'rgba(255, 255, 255, 0.08)',
        font: { color: '#ffffff', size: 12 },
      },
    }
    const layout = {
      autosize: true,
      margin: { l: 8, r: 8, t: 8, b: 8 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      showlegend: !!showLegend,
      legend: {
        orientation: 'v',
        x: 1.02,
        y: 0.5,
        font: { size: 11 },
      },
    }
    const config = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['sendDataToCloud'],
    }
    Plotly.react(el, [trace], layout, config)
    return undefined
  }, [
    safeRows,
    chartType,
    hole,
    colorscale,
    reverseScale,
    textInfo,
    textPosition,
    sort,
    showLegend,
    unit,
    size,
    resizing,
  ])

  useEffect(() => {
    const el = containerRef.current
    return () => {
      if (el) Plotly.purge(el)
    }
  }, [])

  return (
    <div
      className="relative w-full h-full rounded-md border bg-background overflow-hidden"
      style={
        autoFit
          ? { height: size ? `${size}px` : '20rem' }
          : { height: '100%', minHeight: '12rem' }
      }
    >
      {resizing ? (
        <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground bg-muted/20 rounded-md">
          크기 조정 중…
        </div>
      ) : (
        <div ref={containerRef} className="absolute inset-0" />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Helpers                                                                       //
// --------------------------------------------------------------------------- //

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
