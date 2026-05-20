/**
 * Radar chart widget — multi-axis polar comparison.
 *
 * Data shape mirrors the heatmap widget: positional `axis_labels[]`,
 * a `series[]` of `{ label, color }`, and a 2-D `values[axis][series]`
 * matrix. Each series traces a polygon through its values across the
 * shared set of axes — natural shape for spec-sheet style comparison
 * (강도 / 연성 / 내식성 / … across multiple materials).
 *
 * Editor surface follows the heatmap / scatter pattern:
 *   - top toolbar: value range (radial domain) + fill opacity +
 *     legend toggle
 *   - 50/50 grid: chart left, data table right
 *   - table accepts Excel-style multi-cell paste (cell / header /
 *     headered-corner) — same 3-mode pattern as heatmap
 *   - autoFit, resize-time placeholder, column min-width with
 *     horizontal scroll on overflow
 *
 * Annotations are out of scope — radar plots don't have a flat (x, y)
 * coordinate space for 2-D-pixel marks to anchor against.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  AxisRangeInput,
  CaptionInput,
  LabelField,
  PreviewLabel,
  captionSkipProps,
} from './_shared'

const SERIES_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#475569',
]

// Default 4-axis × 2-series starter. Labels are positional
// placeholders so the user can immediately type their own — no
// domain-specific seed text. Values are null so the chart stays
// empty until real data is entered.
const DEFAULT_AXES = ['축 1', '축 2', '축 3', '축 4']
const DEFAULT_SERIES = [
  { label: '시리즈 1', color: SERIES_COLORS[0] },
  { label: '시리즈 2', color: SERIES_COLORS[1] },
]
const DEFAULT_VALUES = [
  [null, null],
  [null, null],
  [null, null],
  [null, null],
]

// --------------------------------------------------------------------------- //
// Props panel + preview                                                         //
// --------------------------------------------------------------------------- //

export function RadarPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="사양 비교"
      />
    </div>
  )
}

export function RadarPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="다축 폴라 비교">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-muted-foreground text-xs">
        다축 점수 비교
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function RadarEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const axisLabels = useMemo(
    () => (Array.isArray(content?.axis_labels) ? content.axis_labels : DEFAULT_AXES),
    [content?.axis_labels],
  )
  const series = useMemo(
    () => (Array.isArray(content?.series) ? content.series : DEFAULT_SERIES),
    [content?.series],
  )
  const values = useMemo(
    () => normalizeMatrix(content?.values, axisLabels.length, series.length, DEFAULT_VALUES),
    [content?.values, axisLabels.length, series.length],
  )
  const valueMin = content?.value_min
  const valueMax = content?.value_max
  const fillOpacity = typeof content?.fill_opacity === 'number' ? content.fill_opacity : 0.3
  const showLegend = content?.show_legend !== false

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      axis_labels: axisLabels,
      series,
      values,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    for (const k of ['value_min', 'value_max']) {
      if (merged[k] === undefined || Number.isNaN(merged[k])) delete merged[k]
    }
    if (merged.fill_opacity === 0.3 || merged.fill_opacity === undefined) {
      delete merged.fill_opacity
    }
    if (merged.show_legend !== false) delete merged.show_legend
    onChange(merged)
  }

  // ──────────────────────────────────────────────────────────────────
  // Mutations
  // ──────────────────────────────────────────────────────────────────
  function setAxisLabel(i, label) {
    const next = axisLabels.slice()
    next[i] = label
    patch({ axis_labels: next })
  }
  function setSeriesField(i, field, v) {
    const next = series.map((s, idx) => (idx === i ? { ...s, [field]: v } : s))
    patch({ series: next })
  }
  function setCell(r, c, v) {
    const next = values.map((row) => row.slice())
    const n = v === '' || v === null || v === undefined ? null : Number(v)
    next[r][c] = Number.isFinite(n) ? n : null
    patch({ values: next })
  }
  function addAxis() {
    const nextAxes = [...axisLabels, `축 ${axisLabels.length + 1}`]
    const nextValues = [...values, new Array(series.length).fill(null)]
    patch({ axis_labels: nextAxes, values: nextValues })
  }
  function removeAxis(idx) {
    if (axisLabels.length <= 3) return // need at least 3 for a sensible radar
    const nextAxes = axisLabels.filter((_, i) => i !== idx)
    const nextValues = values.filter((_, i) => i !== idx)
    patch({ axis_labels: nextAxes, values: nextValues })
  }
  function addSeries() {
    const usedColors = new Set(series.map((s) => s.color))
    const color = SERIES_COLORS.find((c) => !usedColors.has(c)) ?? SERIES_COLORS[series.length % SERIES_COLORS.length]
    const nextSeries = [...series, { label: `시리즈 ${series.length + 1}`, color }]
    const nextValues = values.map((row) => [...row, null])
    patch({ series: nextSeries, values: nextValues })
  }
  function removeSeries(idx) {
    if (series.length <= 1) return
    const nextSeries = series.filter((_, i) => i !== idx)
    const nextValues = values.map((row) => row.filter((_, i) => i !== idx))
    patch({ series: nextSeries, values: nextValues })
  }

  // ──────────────────────────────────────────────────────────────────
  // Paste handlers — same 3 modes as heatmap (headered corner / body
  // grid / header-only row|column).
  // ──────────────────────────────────────────────────────────────────
  function pasteAt(startRow, startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingHeight = grid.length
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    const isCornerPaste = startRow === -1 && startCol === -1
    // Corner paste = headered mode. Three sub-shapes:
    //   1. single row              → just series labels
    //   2. multi-row, (0,0) empty  → series labels + axis labels + data
    //   3. multi-row, (0,0) filled → series labels + data only (no axis labels)
    // The old "(0,0) must be empty" gate was too strict — Excel only
    // produces an empty corner cell when the user selects the row-
    // label column too. Most pastes are the (3) shape (header row +
    // value rows), which used to silently fall into body-paste and
    // drop the header row.
    if (isCornerPaste) {
      if (incomingHeight === 1) {
        // Single row = just series labels.
        pasteHeader('col', 0, text)
        return
      }
      const hasRowHeaders = (grid[0][0] ?? '').toString().trim() === ''
      const colHeaderCells = hasRowHeaders
        ? grid[0].slice(1)
        : grid[0]
      const colHeaders = colHeaderCells.map((s) => String(s ?? '').trim())
      const bodyRows = grid.slice(1)
      const rowHeaders = hasRowHeaders
        ? bodyRows.map((row) => String(row[0] ?? '').trim())
        : []
      const body = bodyRows.map((row) =>
        (hasRowHeaders ? row.slice(1) : row).map(coerceNumOrNull),
      )
      const nextSeries = series.slice()
      while (nextSeries.length < colHeaders.length) {
        nextSeries.push({
          label: `시리즈 ${nextSeries.length + 1}`,
          color: SERIES_COLORS[nextSeries.length % SERIES_COLORS.length],
        })
      }
      for (let i = 0; i < colHeaders.length; i += 1) {
        if (colHeaders[i]) nextSeries[i] = { ...nextSeries[i], label: colHeaders[i] }
      }
      const nextAxes = axisLabels.slice()
      while (nextAxes.length < Math.max(body.length, rowHeaders.length)) {
        nextAxes.push(`축 ${nextAxes.length + 1}`)
      }
      for (let i = 0; i < rowHeaders.length; i += 1) {
        if (rowHeaders[i]) nextAxes[i] = rowHeaders[i]
      }
      const nextValues = matrixFit(values, nextAxes.length, nextSeries.length)
      for (let r = 0; r < body.length; r += 1) {
        for (let c = 0; c < body[r].length; c += 1) {
          nextValues[r][c] = body[r][c]
        }
      }
      patch({
        axis_labels: nextAxes,
        series: nextSeries,
        values: nextValues,
      })
      return
    }
    const targetRow = Math.max(0, startRow)
    const targetCol = Math.max(0, startCol)
    const needRows = targetRow + incomingHeight
    const needCols = targetCol + incomingWidth
    const nextSeries = series.slice()
    while (nextSeries.length < needCols) {
      nextSeries.push({
        label: `시리즈 ${nextSeries.length + 1}`,
        color: SERIES_COLORS[nextSeries.length % SERIES_COLORS.length],
      })
    }
    const nextAxes = axisLabels.slice()
    while (nextAxes.length < needRows) nextAxes.push(`축 ${nextAxes.length + 1}`)
    const nextValues = matrixFit(values, nextAxes.length, nextSeries.length)
    for (let r = 0; r < incomingHeight; r += 1) {
      for (let c = 0; c < grid[r].length; c += 1) {
        nextValues[targetRow + r][targetCol + c] = coerceNumOrNull(grid[r][c])
      }
    }
    patch({ axis_labels: nextAxes, series: nextSeries, values: nextValues })
  }
  /** Header-strip paste.
   *  - axis='col' (paste into a series header): first row = labels;
   *    any additional rows fall into the body starting at row 0 for
   *    the same column range.
   *  - axis='row' (paste into an axis header): first column = labels;
   *    any additional columns fall into the body starting at col 0
   *    for the same row range.
   *  This lets users copy "header row + value rows" from Excel and
   *  drop it onto the first series cell without having to first hit
   *  the corner paste target. */
  function pasteHeader(axis, startIdx, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    if (axis === 'col') {
      const headerRow = grid[0]
      const labelCount = headerRow.length
      const dataRows = grid.slice(1).map((row) => row.map(coerceNumOrNull))
      const nextSeries = series.slice()
      while (nextSeries.length < startIdx + labelCount) {
        nextSeries.push({
          label: `시리즈 ${nextSeries.length + 1}`,
          color: SERIES_COLORS[nextSeries.length % SERIES_COLORS.length],
        })
      }
      for (let i = 0; i < labelCount; i += 1) {
        const label = String(headerRow[i] ?? '').trim()
        if (label) nextSeries[startIdx + i] = { ...nextSeries[startIdx + i], label }
      }
      const nextAxes = axisLabels.slice()
      while (nextAxes.length < dataRows.length) {
        nextAxes.push(`축 ${nextAxes.length + 1}`)
      }
      const nextValues = matrixFit(values, nextAxes.length, nextSeries.length)
      for (let r = 0; r < dataRows.length; r += 1) {
        for (let c = 0; c < dataRows[r].length; c += 1) {
          nextValues[r][startIdx + c] = dataRows[r][c]
        }
      }
      patch({ series: nextSeries, values: nextValues, axis_labels: nextAxes })
    } else {
      const labelCol = grid.map((row) => String(row[0] ?? '').trim())
      const dataCells = grid.map((row) =>
        row.slice(1).map(coerceNumOrNull),
      )
      const incomingDataWidth = Math.max(0, ...dataCells.map((r) => r.length))
      const nextAxes = axisLabels.slice()
      while (nextAxes.length < startIdx + labelCol.length) {
        nextAxes.push(`축 ${nextAxes.length + 1}`)
      }
      for (let i = 0; i < labelCol.length; i += 1) {
        if (labelCol[i]) nextAxes[startIdx + i] = labelCol[i]
      }
      const nextSeries = series.slice()
      while (nextSeries.length < incomingDataWidth) {
        nextSeries.push({
          label: `시리즈 ${nextSeries.length + 1}`,
          color: SERIES_COLORS[nextSeries.length % SERIES_COLORS.length],
        })
      }
      const nextValues = matrixFit(values, nextAxes.length, nextSeries.length)
      for (let r = 0; r < dataCells.length; r += 1) {
        for (let c = 0; c < dataCells[r].length; c += 1) {
          nextValues[startIdx + r][c] = dataCells[r][c]
        }
      }
      patch({ axis_labels: nextAxes, values: nextValues, series: nextSeries })
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────
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
          <RadarCanvas
            axisLabels={axisLabels}
            series={series}
            values={values}
            valueMin={valueMin}
            valueMax={valueMax}
            fillOpacity={fillOpacity}
            showLegend={showLegend}
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

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>값 범위 (선택):</span>
        <AxisRangeInput
          label="min"
          value={valueMin}
          onChange={(v) => patch({ value_min: v })}
        />
        <AxisRangeInput
          label="max"
          value={valueMax}
          onChange={(v) => patch({ value_max: v })}
        />
        <span className="text-[10px]">미설정 시 데이터 범위로 자동 맞춤</span>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">채움:</span>
          <select
            value={String(fillOpacity)}
            onChange={(e) => patch({ fill_opacity: Number(e.target.value) })}
            className="h-7 rounded border px-2 text-xs"
          >
            <option value="0">없음 (선만)</option>
            <option value="0.15">15%</option>
            <option value="0.3">30%</option>
            <option value="0.5">50%</option>
            <option value="0.8">80%</option>
          </select>
        </div>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showLegend}
            onChange={(e) => patch({ show_legend: e.target.checked })}
          />
          <span className="text-muted-foreground">범례 표시</span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        {/* Chart */}
        <div className="min-h-0 flex flex-col">
          <RadarCanvas
            axisLabels={axisLabels}
            series={series}
            values={values}
            valueMin={valueMin}
            valueMax={valueMax}
            fillOpacity={fillOpacity}
            showLegend={showLegend}
            autoFit={false}
          />
        </div>

        {/* Data table */}
        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground">데이터 (행 = 축 / 열 = 시리즈)</span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addAxis}>
                <Plus className="h-3 w-3 mr-1" /> 축 추가
              </Button>
              <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addSeries}>
                <Plus className="h-3 w-3 mr-1" /> 시리즈 추가
              </Button>
            </div>
          </div>
          <div className="overflow-auto max-h-[28rem]">
            <table className="text-xs" style={{ minWidth: '100%' }}>
              <colgroup>
                <col style={{ minWidth: '6rem' }} />
                {series.map((_, i) => (
                  <col key={i} style={{ minWidth: '6rem' }} />
                ))}
                <col style={{ width: '2rem' }} />
              </colgroup>
              <thead>
                <tr>
                  {/* Headered-corner paste target */}
                  <th className="border border-muted bg-muted/30 p-0">
                    <Input
                      placeholder="←헤더 포함 붙여넣기"
                      readOnly
                      onPaste={(e) => {
                        const text = e.clipboardData?.getData('text/plain')
                        if (!text) return
                        e.preventDefault()
                        pasteAt(-1, -1, text)
                      }}
                      onChange={() => {}}
                      className="h-7 text-[10px] text-center border-0"
                    />
                  </th>
                  {series.map((s, ci) => (
                    <th key={ci} className="border border-muted bg-muted/30 p-0">
                      <div className="flex items-center gap-1 px-1">
                        <input
                          type="color"
                          value={s.color ?? SERIES_COLORS[ci % SERIES_COLORS.length]}
                          onChange={(e) => setSeriesField(ci, 'color', e.target.value)}
                          className="h-5 w-5 cursor-pointer border-0 bg-transparent p-0"
                          title="시리즈 색"
                        />
                        <Input
                          value={s.label ?? ''}
                          onChange={(e) => setSeriesField(ci, 'label', e.target.value)}
                          onPaste={(e) => {
                            const text = e.clipboardData?.getData('text/plain')
                            if (!text) return
                            if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
                            e.preventDefault()
                            pasteHeader('col', ci, text)
                          }}
                          placeholder={`시리즈 ${ci + 1}`}
                          className="h-7 text-[11px] text-center border-0 flex-1"
                        />
                      </div>
                    </th>
                  ))}
                  <th className="border border-muted bg-muted/30" />
                </tr>
                {/* Series delete row */}
                <tr>
                  <th />
                  {series.map((_, ci) => (
                    <th key={ci} className="text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-destructive"
                        disabled={series.length <= 1}
                        onClick={() => removeSeries(ci)}
                        title="시리즈 삭제"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {axisLabels.map((label, ri) => (
                  <tr key={ri}>
                    <th className="border border-muted bg-muted/30 p-0">
                      <Input
                        value={label ?? ''}
                        onChange={(e) => setAxisLabel(ri, e.target.value)}
                        onPaste={(e) => {
                          const text = e.clipboardData?.getData('text/plain')
                          if (!text) return
                          if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
                          e.preventDefault()
                          pasteHeader('row', ri, text)
                        }}
                        placeholder={`축 ${ri + 1}`}
                        className="h-7 text-[11px] text-center border-0"
                      />
                    </th>
                    {series.map((_, ci) => (
                      <td key={ci} className="border border-muted p-0">
                        <RadarCell
                          value={values[ri]?.[ci]}
                          onChange={(v) => setCell(ri, ci, v)}
                          onMultiPaste={(text) => pasteAt(ri, ci, text)}
                        />
                      </td>
                    ))}
                    <td className="border border-muted text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive"
                        disabled={axisLabels.length <= 3}
                        onClick={() => removeAxis(ri)}
                        title="축 삭제"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function RadarCell({ value, onChange, onMultiPaste }) {
  function handlePaste(e) {
    if (!onMultiPaste) return
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onMultiPaste(text)
  }
  return (
    <Input
      type="number"
      step="any"
      value={value === undefined || value === null ? '' : value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={handlePaste}
      className="h-7 w-20 text-[11px] text-center border-0"
    />
  )
}

// --------------------------------------------------------------------------- //
// Canvas — Recharts RadarChart wrapped in the standard autoFit /                //
// resize-placeholder shell used by the rest of the chart family.                //
// --------------------------------------------------------------------------- //

function RadarCanvas({
  axisLabels,
  series,
  values,
  valueMin,
  valueMax,
  fillOpacity,
  showLegend,
  autoFit = true,
}) {
  const containerRef = useRef(null)
  // Sizing parallels the rest of the chart family — autoFit=true →
  // square (clientWidth → height), autoFit=false → fill parent.
  // resize-debouncing: Recharts repaints its SVG on every dimension
  // change, which lags during an RGL drag — we mount a placeholder
  // until size has been stable for 200 ms.
  const [squareSize, setSquareSize] = useState(null)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    let firstCall = true
    const measure = () => {
      const w = el.clientWidth
      if (autoFit && w > 0) {
        setSquareSize((prev) => {
          const next = Math.max(240, Math.min(720, w))
          return prev === next ? prev : next
        })
      }
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

  // Recharts wants one object per axis, with each series's value
  // keyed by `seriesKey`. Series keys are derived positionally
  // (`s0`, `s1`, …) so renaming a series doesn't invalidate stored
  // values.
  const chartData = useMemo(() => {
    return axisLabels.map((axisLabel, ri) => {
      const row = { axis: axisLabel || `축 ${ri + 1}` }
      for (let ci = 0; ci < series.length; ci += 1) {
        const v = values[ri]?.[ci]
        row[`s${ci}`] = Number.isFinite(v) ? v : null
      }
      return row
    })
  }, [axisLabels, values, series.length])

  const domain = [
    Number.isFinite(valueMin) ? valueMin : 'auto',
    Number.isFinite(valueMax) ? valueMax : 'auto',
  ]

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full"
      style={
        autoFit
          ? { height: squareSize ? `${squareSize}px` : '20rem' }
          : { height: '100%', minHeight: '12rem' }
      }
    >
      {resizing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-muted-foreground bg-muted/20 rounded-md">
          크기 조정 중…
        </div>
      )}
      {!resizing && (
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={chartData} margin={{ top: 16, right: 24, left: 24, bottom: 16 }}>
            <PolarGrid stroke="#e5e7eb" />
            <PolarAngleAxis dataKey="axis" tick={{ fontSize: 12 }} />
            <PolarRadiusAxis domain={domain} tick={{ fontSize: 11 }} />
            <Tooltip />
            {showLegend && series.length > 0 && (
              <Legend wrapperStyle={{ fontSize: 12 }} />
            )}
            {series.map((s, i) => {
              const color = s.color || SERIES_COLORS[i % SERIES_COLORS.length]
              return (
                <Radar
                  key={`s${i}`}
                  name={s.label || `시리즈 ${i + 1}`}
                  dataKey={`s${i}`}
                  stroke={color}
                  strokeWidth={2}
                  fill={color}
                  fillOpacity={fillOpacity}
                  isAnimationActive={false}
                />
              )
            })}
          </RadarChart>
        </ResponsiveContainer>
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
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Reshape a (axis-row × series-col) value matrix to fit (rows × cols).
 *  Existing cells stay where they are; new cells default to null. */
function normalizeMatrix(raw, rows, cols, fallback) {
  if (!Array.isArray(raw)) return fallback.map((row) => row.slice())
  const out = []
  for (let r = 0; r < rows; r += 1) {
    const src = Array.isArray(raw[r]) ? raw[r] : []
    const row = []
    for (let c = 0; c < cols; c += 1) {
      const v = src[c]
      row.push(typeof v === 'number' && Number.isFinite(v) ? v : null)
    }
    out.push(row)
  }
  return out
}

function matrixFit(raw, rows, cols) {
  const out = []
  for (let r = 0; r < rows; r += 1) {
    const src = Array.isArray(raw[r]) ? raw[r] : []
    const row = []
    for (let c = 0; c < cols; c += 1) {
      const v = src[c]
      row.push(typeof v === 'number' && Number.isFinite(v) ? v : null)
    }
    out.push(row)
  }
  return out
}
