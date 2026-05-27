/**
 * Boxplot widget — long-form rows, Plotly `type: 'box'`.
 *
 * Each row is one observation `{group, value}`; rows sharing a group
 * collapse into one box. Plotly computes Q1/median/Q3/whiskers/
 * outliers from the raw values automatically, so authors only enter
 * (group, number) pairs.
 *
 * UI mirrors the other long-form widgets (Pie, Treemap rows, Contour
 * xyz mode) — toolbar + 2-column rows table with Excel TSV paste.
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

const ORIENTATION_OPTIONS = [
  { value: 'vertical', label: '세로 (값 = Y)' },
  { value: 'horizontal', label: '가로 (값 = X)' },
]

const BOX_POINTS_OPTIONS = [
  { value: 'outliers', label: '이상치만 (기본)' },
  { value: 'suspectedoutliers', label: '의심 이상치 강조' },
  { value: 'all', label: '모든 점' },
  { value: 'none', label: '점 없음' },
]

const BOX_MEAN_OPTIONS = [
  { value: 'none', label: '중앙값만' },
  { value: 'line', label: '+ 평균선' },
  { value: 'sd', label: '+ 평균선 ± 표준편차' },
]

// Default starter — a single placeholder row so a fresh widget has
// editable table cells without preloading fake demo data the author
// would have to delete first. Same row is used by the table's
// "비우기" (clear) action so the table never collapses to an empty
// state.
const DEFAULT_ROWS = [{ group: 'Sample', value: 0 }]

const BOX_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function BoxPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="측정값 분포"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">X 축 제목</Label>
          <Input
            value={props.x_axis_title ?? ''}
            onChange={(e) => onChange({ ...props, x_axis_title: e.target.value })}
            className="mt-1 h-9 text-sm"
            placeholder="(없음)"
          />
        </div>
        <div>
          <Label className="text-xs">Y 축 제목</Label>
          <Input
            value={props.y_axis_title ?? ''}
            onChange={(e) => onChange({ ...props, y_axis_title: e.target.value })}
            className="mt-1 h-9 text-sm"
            placeholder="(없음)"
          />
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function BoxPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="박스플롯">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 60 40" className="w-20 h-14">
          {/* Two mini boxes */}
          {[10, 32].map((cx, i) => {
            const c = ['#6366f1', '#10b981'][i]
            return (
              <g key={i}>
                <line x1={cx + 6} y1={6} x2={cx + 6} y2={34} stroke={c} strokeWidth="0.7" />
                <rect x={cx} y={12} width={12} height={16} fill={c} fillOpacity="0.25" stroke={c} strokeWidth="0.8" />
                <line x1={cx} y1={20} x2={cx + 12} y2={20} stroke={c} strokeWidth="1.2" />
                <line x1={cx + 3} y1={6} x2={cx + 9} y2={6} stroke={c} strokeWidth="0.7" />
                <line x1={cx + 3} y1={34} x2={cx + 9} y2={34} stroke={c} strokeWidth="0.7" />
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function BoxEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const rows = useMemo(
    () =>
      Array.isArray(content?.rows) && content.rows.length > 0
        ? content.rows
        : DEFAULT_ROWS,
    [content?.rows],
  )
  const orientation = content?.orientation === 'horizontal' ? 'horizontal' : 'vertical'
  const boxPoints = content?.box_points ?? 'outliers'
  const boxMean = content?.box_mean ?? 'none'
  const jitter = Number.isFinite(content?.jitter) ? content.jitter : 0.3
  const xAxisTitle = content?.x_axis_title ?? props?.x_axis_title ?? ''
  const yAxisTitle = content?.y_axis_title ?? props?.y_axis_title ?? ''
  const unit = content?.unit ?? ''
  // Value-axis range (Y for vertical, X for horizontal). null = auto
  // on that side.
  const yMin = Number.isFinite(content?.y_min) ? content.y_min : null
  const yMax = Number.isFinite(content?.y_max) ? content.y_max : null

  function patch(next) {
    const merged = { ...(content ?? {}), rows, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.unit) delete merged.unit
    if (!merged.x_axis_title) delete merged.x_axis_title
    if (!merged.y_axis_title) delete merged.y_axis_title
    if (!merged.orientation || merged.orientation === 'vertical') {
      delete merged.orientation
    }
    if (!merged.box_points || merged.box_points === 'outliers') {
      delete merged.box_points
    }
    if (!merged.box_mean || merged.box_mean === 'none') delete merged.box_mean
    if (merged.jitter == null || merged.jitter === 0.3) delete merged.jitter
    // Empty/blank y_min/y_max should not survive to the saved content
    // — keep the payload clean so partial drafts don't carry stale
    // string values from a cleared input.
    if (merged.y_min == null || !Number.isFinite(merged.y_min)) delete merged.y_min
    if (merged.y_max == null || !Number.isFinite(merged.y_max)) delete merged.y_max
    if (Array.isArray(merged.rows) && merged.rows.length === 0) delete merged.rows
    onChange(merged)
  }

  // Inputs are loose strings (so the user can clear them); convert to
  // number on patch, treat blank as "auto".
  function setRangeBound(which, raw) {
    if (raw === '' || raw == null) {
      patch({ [which]: null })
      return
    }
    const n = Number(raw)
    patch({ [which]: Number.isFinite(n) ? n : null })
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
    patch({ rows: [...rows, { group: '', value: null }] })
  }
  function removeRow(idx) {
    if (rows.length <= 1) return
    patch({ rows: rows.filter((_, i) => i !== idx) })
  }

  /** Multi-cell paste — accepts `(group, value)` TSV with optional
   *  header. First TSV row is dropped if it looks like a header
   *  (`group` / `value` / `그룹` / `값`). */
  function pasteAtTable(startRowIdx, startField, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    let body = grid
    const firstLower = (grid[0] || []).map((s) =>
      String(s ?? '').trim().toLowerCase(),
    )
    const headerHit = firstLower.some((s) =>
      ['group', 'value', '그룹', '값', '구분'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['group', 'value']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...rows]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ group: '', value: null })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = {
        ...(nextRows[startRowIdx + r] ?? { group: '', value: null }),
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
          <BoxCanvas
            rows={rows}
            orientation={orientation}
            boxPoints={boxPoints}
            boxMean={boxMean}
            jitter={jitter}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            yMin={yMin}
            yMax={yMax}
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
          <span className="text-muted-foreground">방향:</span>
          <select
            value={orientation}
            onChange={(e) => patch({ orientation: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {ORIENTATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">점:</span>
          <select
            value={boxPoints}
            onChange={(e) => patch({ box_points: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {BOX_POINTS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">평균:</span>
          <select
            value={boxMean}
            onChange={(e) => patch({ box_mean: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {BOX_MEAN_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {boxPoints !== 'none' && (
          <div className="flex items-center gap-1" title="0 = 박스 중심에 점 일렬, 1 = 박스 폭 전체로 산포">
            <span className="text-muted-foreground">점 산포:</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={jitter}
              onChange={(e) => {
                const v = Number(e.target.value)
                patch({ jitter: Number.isFinite(v) ? v : 0.3 })
              }}
              className="h-7 w-16 text-xs"
            />
          </div>
        )}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">X 제목:</span>
          <Input
            value={xAxisTitle}
            onChange={(e) => patch({ x_axis_title: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-20 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Y 제목:</span>
          <Input
            value={yAxisTitle}
            onChange={(e) => patch({ y_axis_title: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-20 text-xs"
          />
        </div>
        <div className="flex items-center gap-1" title="값 옆에 붙는 단위 (예: mm, kg, %)">
          <span className="text-muted-foreground">단위:</span>
          <Input
            value={unit}
            onChange={(e) => patch({ unit: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-20 text-xs"
          />
        </div>
        <div
          className="flex items-center gap-1"
          title={
            orientation === 'horizontal'
              ? '값 축 (X) 범위. 비우면 자동.'
              : '값 축 (Y) 범위. 비우면 자동.'
          }
        >
          <span className="text-muted-foreground">
            {orientation === 'horizontal' ? 'X 범위:' : 'Y 범위:'}
          </span>
          <Input
            type="number"
            value={yMin == null ? '' : yMin}
            onChange={(e) => setRangeBound('y_min', e.target.value)}
            placeholder="min"
            className="h-7 w-16 text-xs"
          />
          <span className="text-muted-foreground">~</span>
          <Input
            type="number"
            value={yMax == null ? '' : yMax}
            onChange={(e) => setRangeBound('y_max', e.target.value)}
            placeholder="max"
            className="h-7 w-16 text-xs"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          <BoxCanvas
            rows={rows}
            orientation={orientation}
            boxPoints={boxPoints}
            boxMean={boxMean}
            jitter={jitter}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            yMin={yMin}
            yMax={yMax}
            unit={unit}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="박스플롯 데이터"
              onCopy={() => {
                const header = ['group', 'value']
                const body = rows.map((r) => [r?.group ?? '', r?.value ?? ''])
                return toTsv([header, ...body])
              }}
              onClear={() =>
                // Reset to the placeholder seed instead of an empty
                // array so the table keeps a single editable row
                // (matches the fresh-widget state).
                patch({ rows: [{ group: 'Sample', value: 0 }] })
              }
            />
          </div>
          <BoxRowsTable
            rows={rows}
            onCellChange={setCell}
            onAdd={addRow}
            onRemove={removeRow}
            onMultiPaste={pasteAtTable}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            같은 `group` 의 row 들이 한 박스로 묶입니다. 비어 있거나 숫자 아닌 value 는 자동으로 제외. 엑셀 TSV 붙여넣기 지원 (헤더 `group/value` 자동 감지).
          </p>
        </div>
      </div>
    </div>
  )
}

function BoxRowsTable({ rows, onCellChange, onAdd, onRemove, onMultiPaste }) {
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
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">group</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">value</th>
            <th className="border border-muted bg-muted/30 w-7" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              <td className="border border-muted p-0">
                <Input
                  value={row?.group ?? ''}
                  onChange={(e) => onCellChange(ri, 'group', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'group')}
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
            <td colSpan={3} className="text-center pt-1">
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

function BoxCanvas({
  rows,
  orientation = 'vertical',
  boxPoints = 'outliers',
  boxMean = 'none',
  jitter = 0.3,
  xAxisTitle = '',
  yAxisTitle = '',
  yMin = null,
  yMax = null,
  unit = '',
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState(null)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)

  // Filter rows where both fields are usable. Plotly raises on
  // non-finite numerics; cheap upfront so we don't ship junk to the
  // renderer.
  const safeRows = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          (r?.group ?? '').toString().trim().length > 0 &&
          Number.isFinite(r?.value),
      ),
    [rows],
  )

  // Group order = first-appearance in the rows array. We'd otherwise
  // get Plotly's alphabetic sort, which can scramble the user's
  // intended A/B/C ordering.
  const groupOrder = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const r of safeRows) {
      if (!seen.has(r.group)) {
        seen.add(r.group)
        out.push(r.group)
      }
    }
    return out
  }, [safeRows])

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
    if (safeRows.length === 0 || groupOrder.length === 0) {
      Plotly.react(
        el,
        [],
        { autosize: true, margin: { l: 8, r: 8, t: 8, b: 8 } },
        { displaylogo: false },
      )
      return undefined
    }

    // One Plotly trace per group — gives each box its own color in the
    // legend + lets users toggle individual groups. The alternative
    // (single trace with shared x/y arrays) renders identically but
    // loses the per-group legend toggle.
    const u = unit ? ` ${unit}` : ''
    const data = groupOrder.map((g, i) => {
      const values = safeRows.filter((r) => r.group === g).map((r) => r.value)
      const color = BOX_PALETTE[i % BOX_PALETTE.length]
      const valueAxis = orientation === 'horizontal' ? 'x' : 'y'
      return {
        type: 'box',
        name: g,
        [valueAxis]: values,
        orientation: orientation === 'horizontal' ? 'h' : 'v',
        boxpoints:
          boxPoints === 'none'
            ? false
            : boxPoints, // 'outliers' | 'suspectedoutliers' | 'all'
        boxmean:
          boxMean === 'sd' ? 'sd' : boxMean === 'line' ? true : false,
        jitter,
        pointpos: -1.6,
        marker: { color, size: 5, opacity: 0.85 },
        line: { color },
        fillcolor: color,
        opacity: 0.55,
        hovertemplate: `<b>${g}</b><br>값: %{${valueAxis}}${u}<extra></extra>`,
      }
    })

    // Value-axis manual range. Three states:
    //   - both bounds set → fixed range, autorange off
    //   - one bound set   → use Plotly's minallowed/maxallowed so the
    //     auto side still expands to fit data while the clamped side
    //     stays put
    //   - neither set     → fully auto (Plotly's default behavior)
    const hasMin = Number.isFinite(yMin)
    const hasMax = Number.isFinite(yMax)
    const rangeBits =
      hasMin && hasMax
        ? { range: [yMin, yMax], autorange: false }
        : hasMin || hasMax
        ? {
            autorange: true,
            ...(hasMin ? { minallowed: yMin } : {}),
            ...(hasMax ? { maxallowed: yMax } : {}),
          }
        : {}
    const valueAxis = {
      title: yAxisTitle
        ? { text: yAxisTitle, font: { size: 12 } }
        : undefined,
      tickfont: { size: 11 },
      zeroline: false,
      ...rangeBits,
    }
    const categoryAxis = {
      title: xAxisTitle
        ? { text: xAxisTitle, font: { size: 12 } }
        : undefined,
      tickfont: { size: 11 },
    }
    const layout = {
      autosize: true,
      margin: { l: 60, r: 24, t: 16, b: 40 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      boxmode: 'group',
      showlegend: false, // group name is already on the category axis
      xaxis: orientation === 'horizontal' ? valueAxis : categoryAxis,
      yaxis: orientation === 'horizontal' ? categoryAxis : valueAxis,
      hoverlabel: {
        bgcolor: 'rgba(15, 23, 42, 0.96)',
        bordercolor: 'rgba(255, 255, 255, 0.08)',
        font: { color: '#ffffff', size: 12 },
      },
    }
    const config = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['sendDataToCloud'],
    }
    Plotly.react(el, data, layout, config)
    return undefined
  }, [
    safeRows,
    groupOrder,
    orientation,
    boxPoints,
    boxMean,
    jitter,
    xAxisTitle,
    yAxisTitle,
    yMin,
    yMax,
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
