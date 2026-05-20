import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Customized,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AnnotationContents } from '@/shared/annotations'
import { AlertTriangle, BarChart3, ChevronDown, ChevronUp, Hash, LineChart as LineIcon, Plus, Settings, Table2, Type, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import { CaptionInput, LabelField, PreviewLabel, captionSkipProps } from './_shared'
import { usePrintScale } from '@/modules/reports/printContext'

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
// Only the chart's overall *label* and its default chart type live here.
// Column structure (keys / labels / types / X-axis / axis titles) is
// configured exclusively from the data-entry table in the report
// editor — that's the single source of truth, so admins and writers
// don't have to keep two places in sync.
export function ChartPropsPanel({ props, onChange }) {
  function patchProps(next) {
    onChange({ ...props, ...next })
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
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
        열·X축·축 제목 등 차트 구조는 보고서 작성 화면의{' '}
        <strong>데이터 표</strong>에서 직접 설정합니다. 행/열을 더하고
        헤더의 <code className="text-[10px]">#/T</code> 칩으로 타입을
        바꾸세요.
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
/** Keys that describe the chart's *structure* (which columns, which axis,
 *  chart type, axis labels). These belong in props_overrides so they
 *  travel with the template definition (and the PropsPanel sees them);
 *  the remaining keys (rows, caption) are the user's *data* and stay
 *  in content. Legacy reports may have these structural fields in
 *  content — we read from content as a fallback and migrate on first
 *  edit so the two storage locations stay in sync over time. */
const STRUCTURAL_KEYS = new Set([
  'columns',
  'chart_type',
  'x_column_key',
  'x_axis_title',
  'y_axis_title',
])

export function ChartEditor({ props, content, onChange, onChangePropsOverride, autoFit, readOnly }) {
  // Structural fields: prefer content (legacy reports) so the user's
  // inline-built layout doesn't visually reset when this refactor
  // lands; otherwise fall back to props (= template + override).
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
    // Split incoming patch into structural (→ props_overrides) and
    // data (→ content). When no override callback is provided (e.g.
    // template-editor preview path), fall back to writing everything
    // to content so the legacy behavior still works.
    const structural = {}
    const data = {}
    for (const [k, v] of Object.entries(next)) {
      if (STRUCTURAL_KEYS.has(k)) structural[k] = v
      else data[k] = v
    }

    const hasStructural = Object.keys(structural).length > 0
    const hasData = Object.keys(data).length > 0
    const canOverride = typeof onChangePropsOverride === 'function'

    if (hasStructural && canOverride) {
      // Lift any legacy structural fields still sitting in content into
      // the same override write — once we move structure into props,
      // content's copies become stale, so we promote them in-place and
      // then strip them below.
      const liftFromContent = {}
      for (const k of STRUCTURAL_KEYS) {
        if (
          content?.[k] !== undefined &&
          structural[k] === undefined
        ) {
          liftFromContent[k] = content[k]
        }
      }
      onChangePropsOverride({ ...liftFromContent, ...structural })
    }

    // Build the next content object. When canOverride, content holds
    // only data (rows + caption); otherwise it's the union (legacy).
    const nextContent = {}
    if (caption) nextContent.caption = caption
    // Preserve the caption-skip flag across unrelated patches (rows /
    // column edits etc.). If the current patch explicitly sets or
    // clears it, the `Object.assign(nextContent, data)` below wins.
    if (content?.caption_skip_autofill && data.caption_skip_autofill === undefined) {
      nextContent.caption_skip_autofill = true
    }
    nextContent.rows = rows
    if (!canOverride) {
      // Legacy fallback — keep mirroring structural fields into content
      // so the template-editor preview still works without an override
      // callback.
      if (content?.columns) nextContent.columns = content.columns
      if (content?.chart_type) nextContent.chart_type = content.chart_type
      if (content?.x_column_key) nextContent.x_column_key = content.x_column_key
      if (content?.x_axis_title) nextContent.x_axis_title = content.x_axis_title
      if (content?.y_axis_title) nextContent.y_axis_title = content.y_axis_title
      Object.assign(nextContent, structural)
    }
    Object.assign(nextContent, data)
    if (!nextContent.caption) delete nextContent.caption
    if (!nextContent.caption_skip_autofill) delete nextContent.caption_skip_autofill
    // The structural fallback fields may end up empty after the merge
    // — drop them so JSON stays tight.
    for (const k of STRUCTURAL_KEYS) {
      if (nextContent[k] === undefined || nextContent[k] === '') {
        delete nextContent[k]
      }
    }
    // Always call onChange so rows/caption updates land — even pure
    // structural edits trigger this to strip legacy structural keys
    // from content on the first edit.
    onChange(nextContent)
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

  /** Helper for paste handlers — extend `cols` to fit the TSV width.
   *  New columns are added with `type: 'number'` as a placeholder; callers
   *  re-type them based on actual data via `inferTypeFromValues` before
   *  patching. */
  function ensureColsFor(neededCols, baseCols) {
    const base = baseCols ?? (
      Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
    )
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

  /** After paste lands data into a column, re-evaluate its type from
   *  what's now in `rows`. Only flips when the column is "new" (label
   *  empty or auto-generated 시리즈 N) or when the existing type is
   *  clearly wrong — we don't want to overwrite an intentional user
   *  choice from an earlier session. */
  function autoTypeColumnsFromData(cols, rows, affectedKeys) {
    return cols.map((c) => {
      if (!affectedKeys.has(c.key)) return c
      const sample = rows.map((r) => r[c.key])
      const inferred = inferTypeFromValues(sample)
      // Only flip if data tells us the current type is wrong. Trusting
      // explicit text columns even when sample is empty avoids surprises.
      if (c.type === inferred) return c
      if (c.type === 'number' && inferred === 'text') return { ...c, type: 'text' }
      if (c.type === 'text' && inferred === 'number') {
        // Don't auto-promote text→number — text often has meaning the
        // user set on purpose (e.g. zero-padded codes). Leave it.
        return c
      }
      return c
    })
  }

  function pasteGrid(startRow, startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    let nextCols = ensureColsFor(startCol + incomingWidth)

    let nextRows = [...rows]
    while (nextRows.length < startRow + grid.length) nextRows.push({})
    const affectedKeys = new Set()
    for (let r = 0; r < grid.length; r += 1) {
      const target = { ...nextRows[startRow + r] }
      for (let c = 0; c < grid[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        // Stage cell value as a raw string — final coercion happens
        // after we re-type the column from the full data sample below.
        target[col.key] = grid[r][c]
        affectedKeys.add(col.key)
      }
      nextRows[startRow + r] = target
    }
    nextCols = autoTypeColumnsFromData(nextCols, nextRows, affectedKeys)
    // Re-coerce every affected row now that the types are final.
    nextRows = nextRows.map((r) => {
      const next = { ...r }
      for (const key of affectedKeys) {
        const col = nextCols.find((c) => c.key === key)
        if (col) next[key] = coerceCellValue(col, next[key])
      }
      return next
    })
    patch({
      columns: nextCols,
      rows: nextRows,
      x_column_key: repairXKey(nextCols, xKey),
    })
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
    const affectedKeys = new Set()
    for (let r = 0; r < dataGrid.length; r += 1) {
      const target = { ...nextRows[r] }
      for (let c = 0; c < dataGrid[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        target[col.key] = dataGrid[r][c]
        affectedKeys.add(col.key)
      }
      nextRows[r] = target
    }
    nextCols = autoTypeColumnsFromData(nextCols, nextRows, affectedKeys)
    nextRows = nextRows.map((r) => {
      const next = { ...r }
      for (const key of affectedKeys) {
        const col = nextCols.find((c) => c.key === key)
        if (col) next[key] = coerceCellValue(col, next[key])
      }
      return next
    })

    patch({
      columns: nextCols,
      rows: nextRows,
      x_column_key: repairXKey(nextCols, xKey),
    })
  }

  /** Flip a column's type between text and number, then re-coerce all
   *  the rows so saved data matches the declared type. Used by the
   *  inline type chip in the data editor header. */
  function toggleColumnType(idx) {
    const base = Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
    const target = base[idx]
    if (!target) return
    const nextType = target.type === 'number' ? 'text' : 'number'
    const updated = { ...target, type: nextType }
    const nextCols = base.map((c, i) => (i === idx ? updated : c))
    const nextRows = recoerceRowsForColumn(rows, updated)
    patch({
      columns: nextCols,
      rows: nextRows,
      // Type change may invalidate the X-axis pointer (e.g. user flipped
      // the X column away from text to no-text). repairXKey is a no-op
      // when the key still resolves.
      x_column_key: repairXKey(nextCols, xKey),
    })
  }

  /** Promote a column to the X-axis. Convenient one-click action from
   *  the warning chip on text-typed series columns. */
  function setXColumn(idx) {
    const base = Array.isArray(content?.columns) ? content.columns : (props.columns ?? [])
    const target = base[idx]
    if (!target) return
    patch({ x_column_key: target.key })
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
            autoFit={autoFit}
            annotations={Array.isArray(content?.annotations) ? content.annotations : []}
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
            {...captionSkipProps({ content, patch })}
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
          autoFit={autoFit}
          annotations={Array.isArray(content?.annotations) ? content.annotations : []}
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
              {cols.map((c, i) => {
                const isX = c.key === xKey
                // Series columns must be number-typed for the chart to
                // plot them. Flag text-typed non-X columns so the user
                // sees the problem at design time instead of getting a
                // validation error at "템플릿으로 저장".
                const isInvalidSeries = !isX && c.type !== 'number'
                return (
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
                      {/* Type toggle chip — click to flip text↔number,
                          re-coerces existing data automatically. */}
                      <button
                        type="button"
                        onClick={() => toggleColumnType(i)}
                        title={
                          c.type === 'number'
                            ? '숫자 (클릭하여 텍스트로 변경)'
                            : '텍스트 (클릭하여 숫자로 변경)'
                        }
                        className={`shrink-0 h-4 w-4 rounded inline-flex items-center justify-center transition-colors ${
                          c.type === 'number'
                            ? 'bg-blue-500/15 text-blue-600 hover:bg-blue-500/25'
                            : 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25'
                        }`}
                      >
                        {c.type === 'number' ? (
                          <Hash className="h-2.5 w-2.5" />
                        ) : (
                          <Type className="h-2.5 w-2.5" />
                        )}
                      </button>
                      {isX && (
                        <span className="text-[10px] uppercase tracking-wide text-primary shrink-0">
                          X
                        </span>
                      )}
                      {isInvalidSeries && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              title="시리즈는 숫자여야 그래프에 그려집니다"
                              className="shrink-0 h-4 w-4 rounded inline-flex items-center justify-center bg-destructive/15 text-destructive hover:bg-destructive/25"
                            >
                              <AlertTriangle className="h-2.5 w-2.5" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align="center" className="w-56 space-y-2">
                            <div className="text-xs text-muted-foreground leading-relaxed">
                              <strong>{c.label || c.key}</strong> 컬럼은 X축이 아니면서
                              텍스트라 차트에 그려지지 않고, 템플릿으로 저장 시 검증 오류가
                              납니다.
                            </div>
                            <div className="flex flex-col gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => toggleColumnType(i)}
                              >
                                숫자로 변경
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setXColumn(i)}
                              >
                                X축으로 지정
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                onClick={() => removeColumn(i)}
                                disabled={cols.length <= 2}
                              >
                                이 열 삭제
                              </Button>
                            </div>
                          </PopoverContent>
                        </Popover>
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
                )
              })}
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
function ChartCanvas({ chartType, data, xKey, seriesCols, xAxisTitle, yAxisTitle, autoFit, annotations, className = '' }) {
  // PDF-print font scale. 1 outside of printing; rebinds during print so
  // the SVG re-renders with axis/legend/tooltip fonts multiplied to
  // match the body-text scale picked in PdfPrintDialog.
  const printScale = usePrintScale()
  // Two sizing modes, both giving ResponsiveContainer a *definite*
  // parent height so it actually renders:
  //
  //   autoFit (default)
  //     Use the canvas's own measured width and set height = width →
  //     a square chart that fills the available horizontal space. The
  //     surrounding cell's row_span tracks this height via the auto-fit
  //     measurement pipeline, so the cell grows to wrap the square.
  //
  //   manual (autoFit === false)
  //     The user has fixed the cell height by dragging. The flex chain
  //     (BlockEditorCard's CardContent + contentRef + ChartEditor's
  //     `h-full`) gives this `flex: 1` a real height to expand into.
  //
  // During an active resize (RGL drag → many ResizeObserver callbacks
  // per second), Recharts repaints its SVG every frame which lags the
  // editor noticeably. We mount a lightweight placeholder while the
  // size is changing and only remount ResponsiveContainer once the
  // dimensions have been stable for 200ms — so the chart paints once
  // per drag instead of continuously.
  const ref = useRef(null)
  const [measuredWidth, setMeasuredWidth] = useState(0)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // ResizeObserver fires once synchronously when we start observing.
    // Treat that initial call as "no resize in progress" so the chart
    // paints on first mount instead of starting in placeholder mode.
    let firstCall = true
    const measure = () => {
      const w = el.clientWidth
      if (autoFit) {
        // Functional update keeps `measuredWidth` out of the effect
        // deps, so the ResizeObserver doesn't churn.
        setMeasuredWidth((prev) => (w > 0 && w !== prev ? w : prev))
      }
      if (firstCall) {
        firstCall = false
        return
      }
      setResizing(true)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => setResizing(false), 200)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    }
  }, [autoFit])

  // 18rem fallback while the first measurement is in flight (initial
  // paint, before ResizeObserver fires). Once measured, height = width.
  const style = autoFit
    ? { height: measuredWidth > 0 ? `${measuredWidth}px` : '18rem' }
    : { flex: 1, minHeight: '12rem' }
  return (
    <div ref={ref} className={`w-full ${className}`} style={style}>
      {resizing ? (
        <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground bg-muted/20 rounded-md">
          크기 조정 중…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(chartType, data, xKey, seriesCols, xAxisTitle, yAxisTitle, printScale, annotations)}
        </ResponsiveContainer>
      )}
    </div>
  )
}

// Chart text sizes — scaled ~1.3× from Recharts' compact defaults so the
// axes, legend, and tooltip match the rest of the report's body type
// (set via `.report-widget-body` overrides in index.css). Recharts paints
// these on an <svg>, which isn't reachable from the Tailwind utility
// overrides, so the scale has to be applied here.
const CHART_AXIS_TICK_FONT = 14
const CHART_AXIS_TITLE_FONT = 16
const CHART_LEGEND_FONT = 16
const CHART_LEGEND_HEIGHT = 34
const CHART_TOOLTIP_FONT = 16

function renderChart(type, data, xKey, seriesCols, xAxisTitle, yAxisTitle, printScale = 1, annotations = []) {
  // Apply the PDF-print scale (1 outside printing) to every SVG-rendered
  // text size so the chart's labels grow/shrink with the rest of the
  // report body. Margins also scale so the (taller) axis title text
  // still fits under/beside the chart at higher zooms.
  const pScale = Number.isFinite(printScale) && printScale > 0 ? printScale : 1
  const tickFont = Math.round(CHART_AXIS_TICK_FONT * pScale)
  const titleFont = Math.round(CHART_AXIS_TITLE_FONT * pScale)
  const legendFont = Math.round(CHART_LEGEND_FONT * pScale)
  const legendHeight = Math.round(CHART_LEGEND_HEIGHT * pScale)
  const tooltipFont = Math.round(CHART_TOOLTIP_FONT * pScale)

  const margin = {
    top: 8,
    right: 16,
    left: yAxisTitle ? Math.round(14 * pScale) : 0,
    bottom: xAxisTitle ? Math.round(30 * pScale) : 0,
  }
  const xLabel = xAxisTitle
    ? { value: xAxisTitle, position: 'insideBottom', offset: -8, fontSize: titleFont }
    : undefined
  const yLabel = yAxisTitle
    ? {
        value: yAxisTitle,
        angle: -90,
        position: 'insideLeft',
        fontSize: titleFont,
        style: { textAnchor: 'middle' },
      }
    : undefined
  const legendStyle = { fontSize: legendFont }
  const tooltipContentStyle = { fontSize: tooltipFont }
  const tooltipLabelStyle = { fontSize: tooltipFont }
  const tooltipItemStyle = { fontSize: tooltipFont }

  if (type === 'line') {
    return (
      <LineChart data={data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey={xKey} fontSize={tickFont} label={xLabel} />
        <YAxis fontSize={tickFont} label={yLabel} />
        <Tooltip
          contentStyle={tooltipContentStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
        />
        <Legend
          verticalAlign="top"
          height={legendHeight}
          wrapperStyle={legendStyle}
        />
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
        <Customized
          component={(rcProps) => (
            <ChartAnnotationOverlay rcProps={rcProps} annotations={annotations} />
          )}
        />
      </LineChart>
    )
  }
  return (
    <BarChart data={data} margin={margin}>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
      <XAxis dataKey={xKey} fontSize={tickFont} label={xLabel} />
      <YAxis fontSize={tickFont} label={yLabel} />
      <Tooltip
        contentStyle={tooltipContentStyle}
        labelStyle={tooltipLabelStyle}
        itemStyle={tooltipItemStyle}
      />
      <Legend
        verticalAlign="top"
        height={legendHeight}
        wrapperStyle={legendStyle}
      />
      {seriesCols.map((s, i) => (
        <Bar
          key={s.key}
          dataKey={s.key}
          name={s.label || s.key}
          fill={SERIES_COLORS[i % SERIES_COLORS.length]}
        />
      ))}
      <Customized
        component={(rcProps) => (
          <ChartAnnotationOverlay rcProps={rcProps} annotations={annotations} />
        )}
      />
    </BarChart>
  )
}

/**
 * Bridges Recharts' Customized hand-off (which gives us the internal
 * xAxisMap / yAxisMap / offset) into a synchronous adapter object that
 * the shared AnnotationContents component understands. Lives inside the
 * chart's SVG, so the <g> elements it produces sit on top of the bars
 * / lines without needing a separate overlay <svg>.
 *
 * Read-only for now (Phase A integration). Phase B will add a sibling
 * interactive layer that handles create/select/drag — the read-only
 * one stays as the canonical "final paint" so view-mode rendering is
 * never affected by editing UI.
 */
function ChartAnnotationOverlay({ rcProps, annotations }) {
  if (!annotations || annotations.length === 0) return null
  const xMap = rcProps?.xAxisMap
  const yMap = rcProps?.yAxisMap
  if (!xMap || !yMap) return null
  const xAxis = Object.values(xMap)[0]
  const yAxis = Object.values(yMap)[0]
  if (!xAxis?.scale || !yAxis?.scale) return null
  const adapter = buildChartAdapter(xAxis, yAxis, rcProps?.offset)
  return <AnnotationContents drawable={annotations} adapter={adapter} readOnly />
}

function buildChartAdapter(xAxis, yAxis, offset) {
  // Same logic as the standalone factory in ChartAnnotationAdapter.js
  // — duplicated here so this file stays self-contained and the chart
  // can render annotations without indirection through a ref.
  function scaleToPx(scale, value) {
    if (scale == null) return NaN
    const out = scale(value)
    if (typeof out !== 'number' || !Number.isFinite(out)) return NaN
    if (typeof scale.bandwidth === 'function') return out + scale.bandwidth() / 2
    return out
  }
  return {
    coordSpace: 'data',
    supportedTypes: ['vline', 'vrange', 'hline', 'hrange', 'point', 'rect', 'arrow', 'text'],
    bounds: {
      x: xAxis.x ?? offset?.left ?? 0,
      y: yAxis.y ?? offset?.top ?? 0,
      width: xAxis.width ?? offset?.width ?? 0,
      height: yAxis.height ?? offset?.height ?? 0,
    },
    toPx(geometry) {
      const out = {}
      if ('x' in geometry) out.x = scaleToPx(xAxis.scale, geometry.x)
      if ('y' in geometry) out.y = scaleToPx(yAxis.scale, geometry.y)
      if ('x_from' in geometry) out.x_from = scaleToPx(xAxis.scale, geometry.x_from)
      if ('x_to' in geometry) out.x_to = scaleToPx(xAxis.scale, geometry.x_to)
      if ('y_from' in geometry) out.y_from = scaleToPx(yAxis.scale, geometry.y_from)
      if ('y_to' in geometry) out.y_to = scaleToPx(yAxis.scale, geometry.y_to)
      if (geometry.from) {
        out.from = {
          x: scaleToPx(xAxis.scale, geometry.from.x),
          y: scaleToPx(yAxis.scale, geometry.from.y),
        }
      }
      if (geometry.to) {
        out.to = {
          x: scaleToPx(xAxis.scale, geometry.to.x),
          y: scaleToPx(yAxis.scale, geometry.to.y),
        }
      }
      return out
    },
  }
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

/** Guess a column's type from a sample of incoming values. If every
 *  non-empty value parses cleanly as a finite number, the column is
 *  `number`; otherwise `text`. Empty samples default to `number`
 *  because new series columns are almost always numeric — the user
 *  can flip the chip if needed. */
function inferTypeFromValues(values) {
  const nonEmpty = (values ?? []).filter(
    (v) => v !== undefined && v !== null && String(v).trim() !== '',
  )
  if (nonEmpty.length === 0) return 'number'
  for (const v of nonEmpty) {
    const n = Number(typeof v === 'string' ? v.trim() : v)
    if (!Number.isFinite(n)) return 'text'
  }
  return 'number'
}

/** Re-coerce every row's value in the given column according to the new
 *  type. Used when the user flips T↔# inline so existing data stays
 *  consistent with the declared type. */
function recoerceRowsForColumn(rows, column) {
  return rows.map((r) => {
    if (!(column.key in r)) return r
    return { ...r, [column.key]: coerceCellValue(column, r[column.key]) }
  })
}

/** Auto-fix x_column_key if it points to a missing column. Prefers a
 *  text column; falls back to the first remaining column. Returns the
 *  original key when it's still valid. */
function repairXKey(cols, currentXKey) {
  if (cols.some((c) => c.key === currentXKey)) return currentXKey
  return cols.find((c) => c.type === 'text')?.key ?? cols[0]?.key
}
