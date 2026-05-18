import { useDeferredValue, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BarChart3, ChevronDown, ChevronUp, LineChart as LineIcon, Plus, Settings, Table2, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import { CaptionInput, LabelField, PreviewLabel } from './_shared'

const CHART_TYPES = [
  { value: 'bar', label: '막대', Icon: BarChart3 },
  { value: 'line', label: '꺾은선', Icon: LineIcon },
]

// Series colors — matches Tailwind palette feel without pulling in a tokens file.
const SERIES_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // rose
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#14b8a6', // teal
]

// --------------------------------------------------------------------------- //
// PropsPanel — template-time configuration
// --------------------------------------------------------------------------- //
export function ChartPropsPanel({ props, onChange }) {
  const cols = props.columns ?? []

  function patchProps(next) {
    onChange({ ...props, ...next })
  }

  function addColumn() {
    const existing = new Set(cols.map((c) => c.key))
    let n = cols.length + 1
    while (existing.has(`col_${n}`)) n += 1
    // Newly-added columns default to 'number' so they can be plotted as
    // a series. The first column (X axis) is typically text.
    patchProps({
      columns: [...cols, { key: `col_${n}`, label: `시리즈 ${n}`, type: 'number' }],
    })
  }
  function updateColumn(idx, patch) {
    patchProps({
      columns: cols.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    })
  }
  function removeColumn(idx) {
    const removed = cols[idx]
    const nextCols = cols.filter((_, i) => i !== idx)
    const next = { ...props, columns: nextCols }
    // If we just removed the X column, fall back to the first text column or
    // the first remaining column so the schema stays consistent.
    if (removed?.key === props.x_column_key) {
      const newX =
        nextCols.find((c) => c.type === 'text')?.key ?? nextCols[0]?.key
      next.x_column_key = newX
    }
    onChange(next)
  }

  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patchProps({ label: v })}
        placeholder="분기 매출"
      />
      <div>
        <Label className="text-xs">기본 그래프 타입</Label>
        <div className="mt-1 flex gap-1">
          {CHART_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => patchProps({ chart_type: t.value })}
              className={`flex-1 flex items-center justify-center gap-1 h-9 rounded-md border text-sm transition-colors ${
                props.chart_type === t.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-input hover:bg-accent'
              }`}
            >
              <t.Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          보고서에서 작성자가 토글로 변경 가능.
        </p>
      </div>
      <div>
        <Label className="text-xs">X축 열</Label>
        <select
          value={props.x_column_key ?? ''}
          onChange={(e) => patchProps({ x_column_key: e.target.value })}
          className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        >
          {cols.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label || c.key} ({c.type})
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">X축 제목 (선택)</Label>
          <Input
            value={props.x_axis_title ?? ''}
            onChange={(e) =>
              patchProps({ x_axis_title: e.target.value || undefined })
            }
            placeholder="분기"
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">Y축 제목 (선택)</Label>
          <Input
            value={props.y_axis_title ?? ''}
            onChange={(e) =>
              patchProps({ y_axis_title: e.target.value || undefined })
            }
            placeholder="매출 (억원)"
            className="mt-1 h-9"
          />
        </div>
      </div>
      <div>
        <Label className="text-xs">열</Label>
        <p className="text-[10px] text-muted-foreground mt-0.5 mb-2">
          X축 열은 텍스트, 시리즈는 숫자 타입이어야 합니다.
        </p>
        <div className="space-y-2">
          {cols.map((c, i) => (
            <div key={i} className="rounded-md border p-2 bg-muted/20 space-y-1">
              <div className="grid grid-cols-12 gap-1 items-end">
                <div className="col-span-4">
                  <Label className="text-[10px] uppercase">키</Label>
                  <Input
                    value={c.key}
                    onChange={(e) => updateColumn(i, { key: e.target.value.toLowerCase() })}
                    className="mt-0.5 h-8 text-xs font-mono"
                  />
                </div>
                <div className="col-span-4">
                  <Label className="text-[10px] uppercase">라벨</Label>
                  <Input
                    value={c.label}
                    onChange={(e) => updateColumn(i, { label: e.target.value })}
                    className="mt-0.5 h-8 text-xs"
                  />
                </div>
                <div className="col-span-3">
                  <Label className="text-[10px] uppercase">타입</Label>
                  <select
                    value={c.type}
                    onChange={(e) => updateColumn(i, { type: e.target.value })}
                    className="mt-0.5 flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                  >
                    <option value="text">텍스트</option>
                    <option value="number">숫자</option>
                  </select>
                </div>
                <div className="col-span-1 flex justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    onClick={() => removeColumn(i)}
                    disabled={cols.length <= 2}
                    title="열 삭제"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addColumn}>
            <Plus className="mr-1 h-3 w-3" />
            열 추가
          </Button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview — empty chart placeholder for the template editor canvas
// --------------------------------------------------------------------------- //
export function ChartPreview({ props }) {
  const seriesCount = (props.columns ?? []).filter((c) => c.type === 'number').length
  return (
    <div className="space-y-2">
      <PreviewLabel hint={props.chart_type === 'line' ? '꺾은선' : '막대'}>
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-[16/9] bg-muted/30 border border-dashed rounded-md flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          {props.chart_type === 'line' ? (
            <LineIcon className="h-8 w-8 mx-auto opacity-50" />
          ) : (
            <BarChart3 className="h-8 w-8 mx-auto opacity-50" />
          )}
          <div className="text-[11px] mt-1 italic">
            {seriesCount > 0
              ? `시리즈 ${seriesCount}개`
              : '시리즈를 추가하세요'}
          </div>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor — bar/line toggle + chart visualization + Excel-style data entry
// --------------------------------------------------------------------------- //
export function ChartEditor({ props, content, onChange, readOnly }) {
  // Effective config: per-report overrides take precedence over template props.
  const caption = content?.caption ?? ''
  const cols = Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
  const xKey = content?.x_column_key ?? props.x_column_key
  const chartType = content?.chart_type ?? props.chart_type ?? 'bar'
  const xAxisTitle = content?.x_axis_title ?? props.x_axis_title ?? ''
  const yAxisTitle = content?.y_axis_title ?? props.y_axis_title ?? ''
  const rows = content?.rows ?? []
  // Data entry table is heavy chrome — keep it collapsed by default so the
  // edit-mode block stays close in size to the read-only render. Writers
  // expand it only when they actually need to add/edit data.
  const [dataExpanded, setDataExpanded] = useState(false)

  const seriesCols = cols.filter((c) => c.key !== xKey && c.type === 'number')

  function patch(next) {
    const merged = {
      ...(caption ? { caption } : {}),
      ...(content?.columns ? { columns: content.columns } : {}),
      ...(content?.chart_type ? { chart_type: content.chart_type } : {}),
      ...(content?.x_column_key ? { x_column_key: content.x_column_key } : {}),
      ...(content?.x_axis_title ? { x_axis_title: content.x_axis_title } : {}),
      ...(content?.y_axis_title ? { y_axis_title: content.y_axis_title } : {}),
      rows,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.columns) delete merged.columns
    if (!merged.chart_type) delete merged.chart_type
    if (!merged.x_column_key) delete merged.x_column_key
    if (!merged.x_axis_title) delete merged.x_axis_title
    if (!merged.y_axis_title) delete merged.y_axis_title
    onChange(merged)
  }

  function setChartType(t) {
    patch({ chart_type: t })
  }

  function updateCell(rowIdx, key, value) {
    const next = rows.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r))
    patch({ rows: next })
  }
  function renameColumn(idx, label) {
    // Lazy-init content.columns from props.columns the first time the
    // report writer touches a header. After this, content owns the
    // column labels for this report.
    const base = Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
    const next = base.map((c, i) => (i === idx ? { ...c, label } : c))
    patch({ columns: next })
  }
  function removeColumn(idx) {
    const base = Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
    const removed = base[idx]
    if (!removed) return
    const nextCols = base.filter((_, i) => i !== idx)
    // Strip the dropped column's data from every row.
    const nextRows = rows.map((r) => {
      const { [removed.key]: _drop, ...rest } = r
      return rest
    })
    // If the X-axis column was removed, fall back to the first remaining
    // text column, or just the first column if no text columns remain.
    const next = { columns: nextCols, rows: nextRows }
    if (removed.key === xKey) {
      const fallbackX =
        nextCols.find((c) => c.type === 'text')?.key ?? nextCols[0]?.key
      if (fallbackX) next.x_column_key = fallbackX
    }
    patch(next)
  }
  function addRow() {
    patch({ rows: [...rows, {}] })
  }
  function removeRow(rowIdx) {
    patch({ rows: rows.filter((_, i) => i !== rowIdx) })
  }
  function moveRow(rowIdx, dir) {
    const newIdx = rowIdx + dir
    if (newIdx < 0 || newIdx >= rows.length) return
    const next = [...rows]
    const [item] = next.splice(rowIdx, 1)
    next.splice(newIdx, 0, item)
    patch({ rows: next })
  }
  function addColumn() {
    const base = Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
    const existing = new Set(base.map((c) => c.key))
    let n = base.length + 1
    while (existing.has(`col_${n}`)) n += 1
    patch({
      columns: [...base, { key: `col_${n}`, label: `시리즈 ${n}`, type: 'number' }],
    })
  }

  /** Helpers for paste handlers — both extend `cols` to fit the TSV width
   *  and produce auto-generated number-type series columns when needed. */
  function ensureColsFor(neededCols) {
    const base = Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
    if (neededCols <= base.length) return base
    const nextCols = [...base]
    const existing = new Set(nextCols.map((c) => c.key))
    while (nextCols.length < neededCols) {
      let n = nextCols.length + 1
      let key = `col_${n}`
      while (existing.has(key)) {
        n += 1
        key = `col_${n}`
      }
      existing.add(key)
      nextCols.push({ key, label: '', type: 'number' })
    }
    return nextCols
  }

  function pasteGrid(startRow, startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    const nextCols = ensureColsFor(startCol + incomingWidth)

    let nextRows = [...rows]
    while (nextRows.length < startRow + grid.length) nextRows.push({})
    for (let r = 0; r < grid.length; r += 1) {
      const target = { ...nextRows[startRow + r] }
      for (let c = 0; c < grid[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        target[col.key] = coerceCellValue(col, grid[r][c])
      }
      nextRows[startRow + r] = target
    }
    patch({ columns: nextCols, rows: nextRows })
  }

  /**
   * Paste landing on a column header. The first TSV row becomes column
   * labels (extending columns when needed); the remaining rows fill data
   * rows starting at row 0. Mirrors the table widget's behavior.
   */
  function pasteOntoHeader(startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    let nextCols = ensureColsFor(startCol + incomingWidth)

    // First TSV row → column labels for the affected range.
    const labels = grid[0]
    nextCols = nextCols.map((c, i) => {
      const labelIdx = i - startCol
      if (labelIdx >= 0 && labelIdx < labels.length) {
        return { ...c, label: labels[labelIdx] }
      }
      return c
    })

    // Remaining rows → data rows from row 0.
    const dataGrid = grid.slice(1)
    let nextRows = [...rows]
    while (nextRows.length < dataGrid.length) nextRows.push({})
    for (let r = 0; r < dataGrid.length; r += 1) {
      const target = { ...nextRows[r] }
      for (let c = 0; c < dataGrid[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        target[col.key] = coerceCellValue(col, dataGrid[r][c])
      }
      nextRows[r] = target
    }

    patch({ columns: nextCols, rows: nextRows })
  }

  // Recharts wants numeric series values pre-coerced (strings are silently dropped).
  const chartData = useMemo(
    () =>
      rows.map((r) => {
        const out = { [xKey]: r[xKey] ?? '' }
        for (const s of seriesCols) {
          const v = r[s.key]
          out[s.key] = v === '' || v == null ? null : Number(v)
        }
        return out
      }),
    [rows, xKey, seriesCols]
  )
  // Defer chart data so the heavy Recharts re-render doesn't block typing
  // in the data table. The chart catches up in the next idle frame —
  // visually it looks like a tiny lag on huge datasets but typing stays
  // snappy. Edit and view modes both render the real chart, so the block
  // size is the same in both.
  const deferredChartData = useDeferredValue(chartData)

  const hasData = chartData.length > 0 && seriesCols.length > 0

  if (readOnly) {
    if (!caption && !hasData) return null
    return (
      <div className="flex flex-col h-full gap-2">
        <CaptionInput value={caption} readOnly />
        {hasData && (
          <ChartCanvas
            chartType={chartType}
            data={chartData}
            xKey={xKey}
            seriesCols={seriesCols}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Caption + chart tools compressed into a single row so the edit-
          mode block reserves roughly the same height as the read-only
          render. Axis titles are tucked into a popover (rarely changed),
          chart_type and data toggle stay inline (frequently used). */}
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex-1 min-w-0">
          <CaptionInput
            value={caption}
            onChange={(v) => patch({ caption: v })}
            placeholder={props.label}
          />
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {CHART_TYPES.map((t) => (
            <Button
              key={t.value}
              type="button"
              variant={chartType === t.value ? 'default' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={() => setChartType(t.value)}
              title={t.label}
            >
              <t.Icon className="h-3.5 w-3.5" />
            </Button>
          ))}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="축 제목 설정"
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-2">
              <div>
                <Label className="text-xs">X축 제목</Label>
                <Input
                  value={xAxisTitle}
                  onChange={(e) =>
                    patch({ x_axis_title: e.target.value || undefined })
                  }
                  placeholder={props.x_axis_title || '제목 (선택)'}
                  className="mt-1 h-8 text-xs"
                />
              </div>
              <div>
                <Label className="text-xs">Y축 제목</Label>
                <Input
                  value={yAxisTitle}
                  onChange={(e) =>
                    patch({ y_axis_title: e.target.value || undefined })
                  }
                  placeholder={props.y_axis_title || '제목 (선택)'}
                  className="mt-1 h-8 text-xs"
                />
              </div>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant={dataExpanded ? 'default' : 'ghost'}
            size="icon"
            className="h-7 w-7"
            onClick={() => setDataExpanded((v) => !v)}
            title={dataExpanded ? '데이터 닫기' : '데이터 편집'}
          >
            <Table2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {hasData ? (
        <ChartCanvas
          chartType={chartType}
          data={deferredChartData}
          xKey={xKey}
          seriesCols={seriesCols}
          xAxisTitle={xAxisTitle}
          yAxisTitle={yAxisTitle}
        />
      ) : (
        <div className="flex-1 min-h-[16rem] rounded-md border border-dashed bg-muted/20 flex items-center justify-center text-xs text-muted-foreground">
          데이터를 입력하면 그래프가 그려집니다.
        </div>
      )}

      {/* Excel-style data entry. Hidden by default to keep the edit-mode
          block close in size to the read-only render — toggle with the
          "데이터 편집" button in the toolbar. */}
      {dataExpanded && (
      <>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            {cols.map((_, i) => (
              <col key={i} />
            ))}
            <col className="w-20" />
          </colgroup>
          <thead className="bg-muted/40">
            <tr>
              {cols.map((c, i) => (
                <th
                  key={i}
                  className="px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b group relative"
                >
                  <div className="flex items-center justify-center gap-1">
                    <input
                      type="text"
                      value={c.label || ''}
                      onChange={(e) => renameColumn(i, e.target.value)}
                      onPaste={(e) => {
                        const text = e.clipboardData?.getData('text/plain')
                        if (!text) return
                        if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
                        e.preventDefault()
                        pasteOntoHeader(i, text)
                      }}
                      placeholder={c.key}
                      className="bg-transparent border-0 outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5 text-xs text-center w-full min-w-0"
                    />
                    {c.key === xKey && (
                      <span className="text-[10px] uppercase tracking-wide text-primary shrink-0">
                        X
                      </span>
                    )}
                  </div>
                  {/* Hover overlay — no reserved space when idle. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive bg-background/90 border shadow-sm"
                    onClick={() => removeColumn(i)}
                    disabled={cols.length <= 2}
                    title={cols.length <= 2 ? '최소 2개 열 필요' : '열 삭제'}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </th>
              ))}
              <th className="border-b" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b last:border-b-0">
                {cols.map((c, ci) => (
                  <td key={ci} className="px-1 py-1">
                    <ChartCell
                      column={c}
                      value={row[c.key]}
                      onChange={(v) => updateCell(rowIdx, c.key, v)}
                      onMultiPaste={(text) => pasteGrid(rowIdx, ci, text)}
                    />
                  </td>
                ))}
                <td className="px-1 py-1">
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={rowIdx === 0}
                      onClick={() => moveRow(rowIdx, -1)}
                    >
                      <ChevronUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={rowIdx === rows.length - 1}
                      onClick={() => moveRow(rowIdx, 1)}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => removeRow(rowIdx)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={cols.length + 1}
                  className="px-2 py-3 text-center text-xs text-muted-foreground italic"
                >
                  아직 데이터가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="mr-1 h-3 w-3" />
          행 추가
        </Button>
        <Button variant="outline" size="sm" onClick={addColumn}>
          <Plus className="mr-1 h-3 w-3" />
          열 추가
        </Button>
      </div>
      </>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
/**
 * Renders the chart in a container that listens for its own resize and
 * skips Recharts during active size changes. RGL drag/resize fires many
 * size changes per second; redrawing the SVG every frame is what was
 * making the editor feel laggy. We pause rendering for 150ms after the
 * last size change, so the chart only repaints once the user lets go.
 */
function ChartCanvas({ chartType, data, xKey, seriesCols, xAxisTitle, yAxisTitle, className = '' }) {
  // We used to debounce repaints behind a ResizeObserver gate to avoid
  // thrashing recharts during RGL drag-resize. In practice the gate flipped
  // the chart in/out of the DOM on every parent resize — and the block's
  // own auto-fit measurer reports a smaller height when the chart is
  // hidden, which shrinks the cell, which fires the observer again, which
  // hides the chart, … ad infinitum. recharts' ResponsiveContainer already
  // handles parent resizes on its own, so just render it directly.
  return (
    <div className={`flex-1 min-h-[16rem] w-full ${className}`}>
      <ResponsiveContainer width="100%" height="100%">
        {renderChart(chartType, data, xKey, seriesCols, xAxisTitle, yAxisTitle)}
      </ResponsiveContainer>
    </div>
  )
}

function renderChart(type, data, xKey, seriesCols, xAxisTitle, yAxisTitle) {
  // Reserve room for axis titles in the chart margins so labels aren't
  // clipped against the container edges.
  const margin = {
    top: 8,
    right: 16,
    left: yAxisTitle ? 12 : 0,
    bottom: xAxisTitle ? 24 : 0,
  }
  const xLabel = xAxisTitle
    ? { value: xAxisTitle, position: 'insideBottom', offset: -8, fontSize: 12 }
    : undefined
  const yLabel = yAxisTitle
    ? { value: yAxisTitle, angle: -90, position: 'insideLeft', fontSize: 12, style: { textAnchor: 'middle' } }
    : undefined

  if (type === 'line') {
    return (
      <LineChart data={data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey={xKey} fontSize={11} label={xLabel} />
        <YAxis fontSize={11} label={yLabel} />
        <Tooltip />
        <Legend verticalAlign="top" height={28} />
        {seriesCols.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label || s.key}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        ))}
      </LineChart>
    )
  }
  return (
    <BarChart data={data} margin={margin}>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
      <XAxis dataKey={xKey} fontSize={11} label={xLabel} />
      <YAxis fontSize={11} label={yLabel} />
      <Tooltip />
      <Legend verticalAlign="top" height={28} />
      {seriesCols.map((s, i) => (
        <Bar
          key={s.key}
          dataKey={s.key}
          name={s.label || s.key}
          fill={SERIES_COLORS[i % SERIES_COLORS.length]}
        />
      ))}
    </BarChart>
  )
}

function ChartCell({ column, value, onChange, onMultiPaste }) {
  function handlePaste(e) {
    if (!onMultiPaste) return
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onMultiPaste(text)
  }
  if (column.type === 'number') {
    return (
      <Input
        type="number"
        step="any"
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
        onPaste={handlePaste}
        className="h-8 text-xs text-center"
      />
    )
  }
  return (
    <Input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      onPaste={handlePaste}
      className="h-8 text-xs text-center"
    />
  )
}

function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}

function coerceCellValue(column, raw) {
  if (raw === undefined || raw === null) return undefined
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '') return undefined
  if (column.type === 'number') {
    const n = Number(s)
    return Number.isFinite(n) ? n : s
  }
  return s
}
