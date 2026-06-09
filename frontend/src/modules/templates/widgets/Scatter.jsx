/**
 * Scatter / XY chart widget.
 *
 * Sibling to Chart.jsx but for numeric x-axis data (measurement plots,
 * calibration curves, parametric data). Three rendering modes:
 *   - scatter:       just points
 *   - line:          line connecting points sorted by x (no markers)
 *   - scatter_line:  line + visible markers (default)
 *
 * Shares the same annotation surface as Chart — both axes live in
 * `data` coord space and use the same buildScatterAdapter to bridge
 * Recharts scales ↔ pixel coords for the AnnotationLayer.
 *
 * Numeric-only by design: x_column_key must reference a `number`
 * column. Categorical x belongs in the Chart widget.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  CartesianGrid,
  Customized,
  Label as RcLabel,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  useXAxisScale,
  useYAxisScale,
  useXAxisInverseScale,
  useYAxisInverseScale,
  usePlotArea,
} from 'recharts'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  AnnotationContents,
  AnnotationCountBadge,
  AnnotationLabelEditor,
  AnnotationStyleBar,
  AnnotationToolbar,
  InteractiveOverlay,
  SelectionMarquee,
  useAnnotationInteractions,
  useAnnotationStore,
} from '@/shared/annotations'
import { AxisRangeInput, CaptionInput, DataTableActions, LabelField, PreviewLabel, captionSkipProps, toTsv } from './_shared'

const MODES = [
  { value: 'scatter', label: '산점도' },
  { value: 'line', label: '곡선' },
  { value: 'scatter_line', label: '산점도 + 곡선' },
]

const SERIES_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#475569',
]

// --------------------------------------------------------------------------- //
// Props panel — template-time config                                            //
// --------------------------------------------------------------------------- //

export function ScatterPropsPanel({ props, onChange }) {
  function patch(next) {
    onChange({ ...props, ...next })
  }
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="측정 결과"
      />
      <div>
        <Label className="text-xs">기본 표시 모드</Label>
        <select
          value={props.mode ?? 'scatter_line'}
          onChange={(e) => patch({ mode: e.target.value })}
          className="mt-1 h-9 w-full rounded-md border px-2 text-sm"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          보고서 작성 시 변경 가능
        </p>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview thumbnail                                                             //
// --------------------------------------------------------------------------- //

export function ScatterPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint={MODES.find((m) => m.value === props.mode)?.label}>
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-muted-foreground text-xs">
        x · y 좌표 그래프
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function ScatterEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  // Columns / rows live in content (per-report editable). Default to
  // the template's columns when content hasn't been touched yet.
  const columns = Array.isArray(content?.columns) && content.columns.length > 0
    ? content.columns
    : (props?.columns ?? [])
  const rows = Array.isArray(content?.rows) ? content.rows : []
  const mode = content?.mode ?? props?.mode ?? 'scatter_line'
  const xColumnKey = content?.x_column_key ?? props?.x_column_key
  const xAxisTitle = content?.x_axis_title ?? props?.x_axis_title ?? ''
  const yAxisTitle = content?.y_axis_title ?? props?.y_axis_title ?? ''
  const xMin = content?.x_min
  const xMax = content?.x_max
  const yMin = content?.y_min
  const yMax = content?.y_max

  // Resolve the (x, y) pair series. Each series owns its own pair of
  // columns — they can be the same column across series (shared x) or
  // entirely independent. When `content.series` is missing, derive
  // legacy "shared x" series from x_column_key + remaining columns so
  // older scatters still render until the user touches series state.
  const series = useMemo(() => {
    if (Array.isArray(content?.series) && content.series.length > 0) {
      return content.series
    }
    if (!xColumnKey) return []
    return columns
      .filter((c) => c.key !== xColumnKey)
      .map((c) => ({ label: c.label, x_key: xColumnKey, y_key: c.key }))
  }, [content?.series, xColumnKey, columns])

  const stableAnnotations = useMemo(
    () => (Array.isArray(content?.annotations) ? content.annotations : []),
    [content?.annotations],
  )
  const annotationStore = useAnnotationStore({
    annotations: stableAnnotations,
    onChange: (next) => patch({ annotations: next }),
  })
  const [annotationTool, setAnnotationTool] = useState(null)

  function patch(next) {
    const merged = { ...(content ?? {}), caption, mode, rows, columns, x_column_key: xColumnKey, ...next }
    // Strip empty / default fields so the saved JSON stays tight.
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (Array.isArray(merged.annotations) && merged.annotations.length === 0) {
      delete merged.annotations
    }
    // Empty series array = "no marks" — drop the field rather than
    // emitting `[]` (which would also defeat the legacy fallback).
    if (Array.isArray(merged.series) && merged.series.length === 0) {
      delete merged.series
    }
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max']) {
      if (merged[k] === undefined || Number.isNaN(merged[k])) delete merged[k]
    }
    if (!merged.x_axis_title) delete merged.x_axis_title
    if (!merged.y_axis_title) delete merged.y_axis_title
    onChange(merged)
  }

  // Series management — explicit (x, y) pairs. The first touch
  // materializes the derived legacy series into content.series so
  // future edits don't fight the legacy fallback.
  function patchSeries(nextSeries) {
    patch({ series: nextSeries })
  }
  function updateSeries(idx, patch_) {
    patchSeries(series.map((s, i) => (i === idx ? { ...s, ...patch_ } : s)))
  }
  function removeSeriesAt(idx) {
    patchSeries(series.filter((_, i) => i !== idx))
  }
  /** Add a new (x, y) pair series. Picks two existing number columns
   *  (auto-creating a 2nd one when only one exists) so the user
   *  always lands on a usable default. */
  function addPairSeries() {
    let workingCols = [...columns]
    // Need at least 2 columns to form a pair.
    while (workingCols.length < 2) {
      const used = new Set(workingCols.map((c) => c.key))
      let n = workingCols.length + 1
      let key = `c${n}`
      while (used.has(key)) {
        n += 1
        key = `c${n}`
      }
      workingCols.push({ key, label: '', type: 'number' })
    }
    const newIdx = series.length
    const candidate = {
      label: `시리즈 ${newIdx + 1}`,
      x_key: workingCols[0].key,
      y_key: workingCols[1].key,
    }
    const nextPatch = { series: [...series, candidate] }
    if (workingCols.length !== columns.length) nextPatch.columns = workingCols
    patch(nextPatch)
  }

  // Esc / Delete / Cmd+Z bindings — same shape Chart + AnnotatableImage use.
  useEffect(() => {
    if (readOnly) return undefined
    function editable() {
      const a = document.activeElement
      const t = a?.tagName?.toLowerCase()
      return t === 'input' || t === 'textarea' || a?.isContentEditable
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        // 라벨/데이터 입력 중 Esc 는 입력이 처리하도록 양보.
        if (editable()) return
        // 주석 도구/선택 활성 시 Esc 는 그것만 취소하고 이벤트를 *소비*한다 —
        // 안 그러면 위젯 편집 모달(Radix Dialog)이 같이 닫힌다. capture 단계라
        // 모달의 Esc 핸들러보다 먼저 잡아 stopPropagation 으로 막는다.
        if (annotationTool) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation?.()
          setAnnotationTool(null)
        } else if (annotationStore.selectedIds.size > 0) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation?.()
          annotationStore.clearSelection()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editable()) return
        const ids = Array.from(annotationStore.selectedIds)
        if (ids.length > 0) {
          e.preventDefault()
          annotationStore.removeMany(ids)
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        if (editable()) return
        e.preventDefault()
        if (e.shiftKey) annotationStore.history.redo()
        else annotationStore.history.undo()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        if (editable()) return
        e.preventDefault()
        annotationStore.history.redo()
      }
    }
    // capture 단계 — 모달(Radix Dialog)의 Esc 핸들러보다 먼저 잡기 위해.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [readOnly, annotationTool, annotationStore])

  // Row + column editing helpers (edit mode only)
  function addRow() {
    const fresh = Object.fromEntries(columns.map((c) => [c.key, '']))
    patch({ rows: [...rows, fresh] })
  }
  function removeRow(idx) {
    patch({ rows: rows.filter((_, i) => i !== idx) })
  }
  function updateCell(idx, key, value) {
    const v = value === '' ? '' : Number(value)
    const next = rows.map((r, i) => (i === idx ? { ...r, [key]: v } : r))
    patch({ rows: next })
  }
  function renameColumn(idx, label) {
    patch({
      columns: columns.map((c, i) => (i === idx ? { ...c, label } : c)),
    })
  }
  /** Add a new numeric column. Doesn't touch series — the user wires
   *  it into a series via the series management UI. */
  function addColumn() {
    const usedKeys = new Set(columns.map((c) => c.key))
    let n = columns.length + 1
    let key = `c${n}`
    while (usedKeys.has(key)) {
      n += 1
      key = `c${n}`
    }
    patch({ columns: [...columns, { key, label: '', type: 'number' }] })
  }
  /** Remove a column. Any series referencing it as x or y is also
   *  dropped — leaving a dangling reference would render nothing
   *  for that series anyway. */
  function removeColumn(idx) {
    const col = columns[idx]
    if (!col) return
    if (columns.length <= 2) return // need at least one (x, y) pair
    const nextCols = columns.filter((_, i) => i !== idx)
    const nextRows = rows.map((r) => {
      const copy = { ...r }
      delete copy[col.key]
      return copy
    })
    const nextSeries = series.filter(
      (s) => s.x_key !== col.key && s.y_key !== col.key,
    )
    patch({
      columns: nextCols,
      rows: nextRows,
      // Persist derived legacy series explicitly so subsequent edits
      // don't unexpectedly recreate the dropped one.
      series: nextSeries.length > 0 ? nextSeries : [],
    })
  }
  // Extend `columns` up to `needed` length, auto-generating new keys
  // + empty labels (paste handlers re-label them from the TSV header
  // when present). Always type=number — scatter is numeric-only.
  function ensureColsFor(needed, base) {
    const baseCols = base ?? columns
    if (needed <= baseCols.length) return baseCols
    const next = [...baseCols]
    const used = new Set(next.map((c) => c.key))
    while (next.length < needed) {
      let n = next.length + 1
      let key = `y${n}`
      while (used.has(key)) {
        n += 1
        key = `y${n}`
      }
      used.add(key)
      next.push({ key, label: '', type: 'number' })
    }
    return next
  }
  /** Multi-cell paste landing on a data cell. Extends columns / rows
   *  as needed to fit the incoming TSV grid, then coerces values to
   *  numbers (non-numeric cells become empty). */
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
        target[col.key] = coerceNum(grid[r][c])
      }
      nextRows[startRow + r] = target
    }
    patch({ columns: nextCols, rows: nextRows })
  }
  /** Paste landing on a column-header label. First TSV row becomes
   *  column labels (extending columns when needed); remaining rows
   *  fill data starting at row 0. Mirrors the chart widget. */
  function pasteOntoHeader(startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const headers = grid[0]
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    let nextCols = ensureColsFor(startCol + incomingWidth)
    nextCols = nextCols.map((c, i) => {
      const rel = i - startCol
      if (rel < 0 || rel >= headers.length) return c
      const label = (headers[rel] ?? '').toString().trim()
      return label ? { ...c, label } : c
    })
    let nextRows = [...rows]
    const dataRows = grid.slice(1)
    while (nextRows.length < dataRows.length) nextRows.push({})
    for (let r = 0; r < dataRows.length; r += 1) {
      const target = { ...nextRows[r] }
      for (let c = 0; c < dataRows[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        target[col.key] = coerceNum(dataRows[r][c])
      }
      nextRows[r] = target
    }
    patch({ columns: nextCols, rows: nextRows })
  }
  // Build (x, y) point lists for each pair series, sorted by x. Each
  // series pulls from its own x_key / y_key columns — different
  // series may share an x column (legacy shared-x derivation) or have
  // entirely independent x columns (new multi-x mode).
  const seriesData = useMemo(() => {
    return series.map((s, i) => ({
      key: `s${i}-${s.x_key}-${s.y_key}`,
      label: s.label || `시리즈 ${i + 1}`,
      color: s.color,
      data: rows
        .map((r) => ({ x: r[s.x_key], y: r[s.y_key] }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.x - b.x),
    }))
  }, [rows, series])

  const hasData = seriesData.some((s) => s.data.length > 0)

  if (readOnly) {
    if (!caption && !hasData) return null
    return (
      <div className={autoFit ? 'space-y-2' : 'flex flex-col h-full gap-2 min-h-0'}>
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
          color={content?.caption_color}
          html={content?.caption_html}
        />
        {hasData && (
          <div className={autoFit ? '' : 'flex-1 min-h-0'}>
            <ScatterCanvas
              seriesData={seriesData}
              mode={mode}
              xAxisTitle={xAxisTitle}
              yAxisTitle={yAxisTitle}
              xMin={xMin} xMax={xMax} yMin={yMin} yMax={yMax}
              annotations={stableAnnotations}
              annotationProps={{ readOnly: true }}
              autoFit={autoFit}
            />
          </div>
        )}
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
          <span className="text-muted-foreground">모드:</span>
          <select
            value={mode}
            onChange={(e) => patch({ mode: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">X 제목:</span>
          <Input
            value={xAxisTitle}
            onChange={(e) => patch({ x_axis_title: e.target.value })}
            onPaste={(e) => handleAxisTitlePaste(e, patch, { x: true, y: true })}
            placeholder="(없음)"
            className="h-7 w-24 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Y 제목:</span>
          <Input
            value={yAxisTitle}
            onChange={(e) => patch({ y_axis_title: e.target.value })}
            onPaste={(e) => handleAxisTitlePaste(e, patch, { y: true, x: false })}
            placeholder="(없음)"
            className="h-7 w-24 text-xs"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>축 범위 (선택):</span>
        <AxisRangeInput label="X min" value={xMin} onChange={(v) => patch({ x_min: v })} />
        <AxisRangeInput label="X max" value={xMax} onChange={(v) => patch({ x_max: v })} />
        <AxisRangeInput label="Y min" value={yMin} onChange={(v) => patch({ y_min: v })} />
        <AxisRangeInput label="Y max" value={yMax} onChange={(v) => patch({ y_max: v })} />
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>어노테이션:</span>
        <AnnotationToolbar
          tool={annotationTool}
          onChange={setAnnotationTool}
          supportedTypes={['vline', 'vrange', 'hline', 'hrange', 'point', 'rect', 'arrow', 'text']}
        />
        {annotationStore.annotations.length > 0 && (
          <AnnotationCountBadge count={annotationStore.annotations.length} />
        )}
        {annotationTool && <span>차트 영역을 클릭/드래그 (Esc 취소)</span>}
      </div>

      {/* Chart + data grid fills the rest of the dialog's 80vh. The
          chart canvas runs in autoFit=false (flex-fill) mode so the
          X-axis label doesn't get pushed off-screen by a square that
          outgrew the available height. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          {hasData ? (
            <ScatterCanvas
              seriesData={seriesData}
              mode={mode}
              xAxisTitle={xAxisTitle}
              yAxisTitle={yAxisTitle}
              xMin={xMin} xMax={xMax} yMin={yMin} yMax={yMax}
              annotations={stableAnnotations}
              annotationProps={{
                readOnly: false,
                selection: annotationStore.selectedIds,
                onSelect: (id, opts) => annotationStore.setSelected(id, opts),
                tool: annotationTool,
                onCreate: (init) => annotationStore.add(init),
                onCancelTool: () => setAnnotationTool(null),
                store: annotationStore,
              }}
              autoFit={false}
            />
          ) : (
            <div className="flex-1 min-h-0 rounded-md border border-dashed bg-muted/20 flex items-center justify-center text-xs text-muted-foreground">
              X / Y 값을 입력하면 그래프가 그려집니다.
            </div>
          )}
        </div>

        <div className="space-y-3 min-h-0 overflow-y-auto pr-1">
          {/* ─── Series — each is an (x, y) column pair. Multiple
              series can share an x column or have entirely
              independent x columns. ─── */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">시리즈</span>
              <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addPairSeries}>
                <Plus className="h-3 w-3 mr-1" /> 시리즈 추가
              </Button>
            </div>
            {series.length === 0 ? (
              <div className="rounded border border-dashed p-2 text-[11px] text-muted-foreground text-center">
                시리즈를 추가해 (x, y) 컬럼 쌍을 지정하세요.
              </div>
            ) : (
              <div className="space-y-1">
                {series.map((s, i) => {
                  const color = s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]
                  return (
                    <div key={`${s.x_key}-${s.y_key}-${i}`} className="flex items-center gap-1.5 rounded border px-1.5 py-1">
                      <span
                        className="inline-block h-3 w-3 rounded-sm shrink-0"
                        style={{ background: color }}
                        title={color}
                      />
                      <Input
                        value={s.label ?? ''}
                        onChange={(e) => updateSeries(i, { label: e.target.value })}
                        placeholder={`시리즈 ${i + 1}`}
                        className="h-7 w-24 text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">X:</span>
                      <select
                        value={s.x_key}
                        onChange={(e) => updateSeries(i, { x_key: e.target.value })}
                        className="h-7 rounded border px-1 text-[11px] flex-1 min-w-0"
                      >
                        {columns.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label || c.key}
                          </option>
                        ))}
                      </select>
                      <span className="text-[10px] text-muted-foreground">Y:</span>
                      <select
                        value={s.y_key}
                        onChange={(e) => updateSeries(i, { y_key: e.target.value })}
                        className="h-7 rounded border px-1 text-[11px] flex-1 min-w-0"
                      >
                        {columns.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label || c.key}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive shrink-0"
                        onClick={() => removeSeriesAt(i)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ─── Data — columns + rows of raw numbers. Header inputs
              accept multi-cell paste (first TSV row becomes column
              labels). Series pick which two columns they pair. ─── */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground">데이터</span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addColumn}>
                  <Plus className="h-3 w-3 mr-1" /> 열 추가
                </Button>
                <DataTableActions
                  label="산점도 데이터"
                  onCopy={() => {
                    const header = columns.map((c) => c.label || c.key)
                    const body = rows.map((row) => columns.map((c) => row[c.key]))
                    return toTsv([header, ...body])
                  }}
                  onClear={() => patch({ rows: [] })}
                />
              </div>
            </div>
            {/* Outer wrapper has both axes scrollable. When the column
                count exceeds what the parent panel can fit, each cell
                stays at its min size (~6rem) and the table scrolls
                horizontally — rather than shrinking every cell to
                illegible. The grid columns use a fixed `6rem` minimum
                so rows stay aligned across header/delete/data rows. */}
            <div className="space-y-1 max-h-[28rem] overflow-auto">
              {/* Header row */}
              <div className="grid items-center gap-1 w-max min-w-full"
                style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(6rem, 1fr)) auto` }}>
                {columns.map((c, ci) => (
                  <div key={c.key} className="flex items-center gap-1">
                    <Input
                      value={c.label ?? ''}
                      onChange={(e) => renameColumn(ci, e.target.value)}
                      onPaste={(e) => {
                        const text = e.clipboardData?.getData('text/plain')
                        if (!text) return
                        if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
                        e.preventDefault()
                        pasteOntoHeader(ci, text)
                      }}
                      placeholder={c.key}
                      className="h-7 text-xs text-center"
                    />
                  </div>
                ))}
                <div className="w-7" />
              </div>
              {/* Column delete row */}
              <div className="grid items-center gap-1 w-max min-w-full"
                style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(6rem, 1fr)) auto` }}>
                {columns.map((c, ci) => (
                  <Button
                    key={c.key}
                    variant="ghost"
                    size="sm"
                    className="h-5 text-[10px] text-destructive"
                    disabled={columns.length <= 2}
                    onClick={() => removeColumn(ci)}
                  >
                    <Trash2 className="h-3 w-3 mr-1" /> 열 삭제
                  </Button>
                ))}
                <div className="w-7" />
              </div>
              {/* Data rows */}
              {rows.map((r, ridx) => (
                <div key={ridx} className="grid items-center gap-1 w-max min-w-full"
                  style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(6rem, 1fr)) auto` }}>
                  {columns.map((c, ci) => (
                    <ScatterCell
                      key={c.key}
                      value={r[c.key]}
                      onChange={(v) => updateCell(ridx, c.key, v)}
                      onMultiPaste={(text) => pasteGrid(ridx, ci, text)}
                    />
                  ))}
                  <Button
                    variant="ghost" size="icon"
                    className="h-7 w-7 text-destructive justify-self-end"
                    onClick={() => removeRow(ridx)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" className="h-7 w-full text-xs" onClick={addRow}>
                <Plus className="h-3 w-3 mr-1" /> 행 추가
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Chart canvas — Recharts ScatterChart with annotation surface                  //
// --------------------------------------------------------------------------- //

function ScatterCanvas({
  seriesData, mode, xAxisTitle, yAxisTitle,
  xMin, xMax, yMin, yMax,
  annotations, annotationProps,
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const adapterRef = useRef(null)
  const [adapterBounds, setAdapterBounds] = useState(null)
  // Sizing model — matches Chart's `autoFit` semantics so cells can
  // pass the prop through identically:
  //   autoFit=true  → square (height tracks measured width). Used in
  //                   in-grid cells the user resized to a rough 1:1
  //                   shape, and as a sensible fallback when the
  //                   parent doesn't give us a definite height.
  //   autoFit=false → fill parent height (flex: 1). Used in the edit
  //                   modal where the dialog gives us 80vh, and in
  //                   in-grid cells with `autoFit=false` where the
  //                   user picked a specific cell row count.
  const [squareSize, setSquareSize] = useState(null)
  // Skip Recharts repaints during an active resize burst — RGL drag
  // fires ResizeObserver many times a second, and Recharts repaints
  // its SVG on every dimension change. We mount a lightweight
  // placeholder while sizing is in flight and remount the chart
  // once dimensions have been stable for 200 ms. Same pattern Chart
  // uses; see its resizing-state comments for rationale.
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    // First ResizeObserver callback fires synchronously when we
    // start observing — treat that as initial paint, not a resize.
    let firstCall = true
    const measure = () => {
      const w = el.clientWidth
      if (autoFit && w > 0) {
        setSquareSize((prev) => {
          const next = Math.max(240, w)
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

  // Stable adapter delegating to adapterRef so child interactions /
  // overlays close over a single reference. Same pattern Chart uses.
  const stableAdapter = useMemo(
    () => ({
      coordSpace: 'data',
      supportedTypes: ['vline', 'vrange', 'hline', 'hrange', 'point', 'rect', 'arrow', 'text'],
      get bounds() { return adapterRef.current?.bounds ?? { x: 0, y: 0, width: 0, height: 0 } },
      toPx(g) { return adapterRef.current?.toPx ? adapterRef.current.toPx(g) : {} },
      fromPx(p) { return adapterRef.current?.fromPx ? adapterRef.current.fromPx(p) : {} },
      snap(v, axis) { return adapterRef.current?.snap ? adapterRef.current.snap(v, axis) : v },
    }),
    [],
  )

  const annotationStore = annotationProps?.store ?? null
  const annotationReadOnly = annotationProps?.readOnly ?? true
  const interactions = useAnnotationInteractions({
    store: annotationStore,
    adapter: stableAdapter,
    readOnly: annotationReadOnly,
  })

  // Merge every series's points so X axis can compute a global domain.
  // Each <Scatter> gets its own filtered slice.
  const allPoints = useMemo(() => {
    const merged = []
    for (const s of seriesData) {
      for (const p of s.data) merged.push(p)
    }
    return merged
  }, [seriesData])

  const xDomain = [
    Number.isFinite(xMin) ? xMin : 'dataMin',
    Number.isFinite(xMax) ? xMax : 'dataMax',
  ]
  const yDomain = [
    Number.isFinite(yMin) ? yMin : 'dataMin',
    Number.isFinite(yMax) ? yMax : 'dataMax',
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
        // Match Chart / Contour / Heatmap — placeholder fills the cell
        // by occupying flow (w-full h-full) rather than overlaying on
        // top of a stale plot. ResponsiveContainer below is gated on
        // `!resizing` so we never render both at once.
        <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground bg-muted/20 rounded-md">
          크기 조정 중…
        </div>
      )}
      {!resizing && (
      <ResponsiveContainer width="100%" height="100%">
        {/* Bottom margin reserves space for tick labels (16px), the
            X-axis title (26px when set) — but NOT the legend. The
            legend sits at the TOP so it never competes with the X
            label for the bottom strip. Top margin gets a 24px bump
            when there's more than one series so the legend has its
            own row. */}
        <ScatterChart margin={{
          top: 16 + (seriesData.length > 1 ? 24 : 0),
          right: 24,
          left: 8 + (yAxisTitle ? 14 : 0),
          bottom: 16 + (xAxisTitle ? 26 : 0),
        }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            type="number" dataKey="x" name="x"
            domain={xDomain} allowDataOverflow
            tick={{ fontSize: 12 }}
          >
            {xAxisTitle && (
              <RcLabel value={xAxisTitle} offset={-8} position="insideBottom" style={{ fontSize: 13 }} />
            )}
          </XAxis>
          <YAxis
            type="number" dataKey="y" name="y"
            domain={yDomain} allowDataOverflow
            tick={{ fontSize: 12 }}
          >
            {yAxisTitle && (
              <RcLabel value={yAxisTitle} angle={-90} offset={-2} position="insideLeft" style={{ fontSize: 13 }} />
            )}
          </YAxis>
          <Tooltip cursor={{ strokeDasharray: '3 3' }} />
          {seriesData.length > 1 && (
            <Legend
              verticalAlign="top"
              align="right"
              wrapperStyle={{ fontSize: 12, paddingBottom: 4 }}
            />
          )}
          {seriesData.map((s, i) => {
            // Per-series color override (set via the future style
            // editor) falls back to the rotating palette.
            const color = s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]
            // Recharts' Scatter has no built-in "no marker" mode — for
            // line-only we render an invisible shape (radius 0) so the
            // line still has its anchor points but no visible dots.
            const invisibleShape = ({ cx, cy }) => (
              <circle cx={cx} cy={cy} r={0} fill="transparent" />
            )
            return (
              <Scatter
                key={s.key}
                name={s.label}
                data={s.data}
                fill={color}
                line={mode === 'line' || mode === 'scatter_line' ? { stroke: color, strokeWidth: 2 } : false}
                shape={mode === 'line' ? invisibleShape : 'circle'}
              />
            )
          })}
          {/* Publish a stable adapter to adapterRef + bounds state via
              Recharts hooks. Customized is a no-op here since the
              annotation rendering happens in an external SVG. */}
          <Customized
            component={(rcProps) => (
              <AdapterPublisher
                rcProps={rcProps}
                adapterRef={adapterRef}
                setAdapterBounds={setAdapterBounds}
                allPoints={allPoints}
              />
            )}
          />
        </ScatterChart>
      </ResponsiveContainer>
      )}
      {/* External annotation SVG (sibling overlay). Hidden while
          resizing — its positioning derives from the adapter's bounds
          which haven't caught up to the new size yet. */}
      {!resizing && adapterBounds && (annotations?.length > 0 || !annotationReadOnly) && (
        <svg className="absolute inset-0" width="100%" height="100%" style={{ pointerEvents: 'none' }}>
          {!annotationReadOnly && annotationProps?.tool == null && annotationProps?.store && (
            <SelectionMarquee store={annotationProps.store} adapter={stableAdapter} />
          )}
          <AnnotationContents
            drawable={annotations}
            adapter={stableAdapter}
            selectedIds={annotationProps?.selection}
            readOnly={annotationReadOnly}
            onSelect={annotationProps?.onSelect}
            interactions={interactions}
          />
        </svg>
      )}

      {/* Creation overlay — only when a tool is active in edit mode */}
      {!resizing && !annotationReadOnly && adapterBounds && annotationProps?.tool && (
        <InteractiveOverlay
          bounds={adapterBounds}
          fromPx={(p) => stableAdapter.fromPx(p)}
          toPx={(g) => stableAdapter.toPx(g)}
          tool={annotationProps.tool}
          onCreate={annotationProps.onCreate}
        />
      )}

      {!resizing && !annotationReadOnly && annotationStore && (
        <AnnotationLabelEditor
          interactions={interactions}
          annotations={annotationStore.annotations}
          adapter={stableAdapter}
        />
      )}
      {!resizing && !annotationReadOnly && annotationStore && (
        <AnnotationStyleBar
          store={annotationStore}
          adapter={stableAdapter}
          editingId={interactions?.editingId}
          onDone={annotationProps?.onCancelTool}
        />
      )}
    </div>
  )
}

/** Inside Recharts — grab the scales via v3 hooks and publish a chart
 *  adapter to the parent's ref. Numeric x AND y so both axes use
 *  Recharts' continuous invert(). No categorical fallback needed. */
function AdapterPublisher({ adapterRef, setAdapterBounds }) {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  const xInverse = useXAxisInverseScale()
  const yInverse = useYAxisInverseScale()
  const plotArea = usePlotArea()
  useEffect(() => {
    if (!xScale || !yScale || !plotArea) return
    const bounds = {
      x: Math.round(plotArea.x),
      y: Math.round(plotArea.y),
      width: Math.round(plotArea.width),
      height: Math.round(plotArea.height),
    }
    adapterRef.current = buildScatterAdapter(xScale, yScale, xInverse, yInverse, bounds)
    setAdapterBounds((prev) =>
      prev && prev.x === bounds.x && prev.y === bounds.y && prev.width === bounds.width && prev.height === bounds.height
        ? prev
        : bounds,
    )
  }, [xScale, yScale, xInverse, yInverse, plotArea, adapterRef, setAdapterBounds])
  return null
}

/** Number input with multi-cell paste detection. Pastes containing
 *  tabs or newlines are forwarded to the host (which calls pasteGrid
 *  to populate cells); plain numeric text falls through to the
 *  browser's native input handling. */
function ScatterCell({ value, onChange, onMultiPaste }) {
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
      value={value === undefined || value === null || value === '' ? '' : value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={handlePaste}
      className="h-7 text-xs text-center"
    />
  )
}

/** Paste into an axis-title input. When the clipboard has multiple
 *  cells (Excel selection of two adjacent cells / a 2-row block), we
 *  intercept and route the FIRST row's two cells to x / y titles
 *  respectively. Single-cell paste falls through to the browser. */
function handleAxisTitlePaste(e, patch, { x, y }) {
  const text = e.clipboardData?.getData('text/plain')
  if (!text) return
  const grid = parseTsv(text)
  if (grid.length === 0) return
  const flat = grid[0]
  // Single cell, no newlines either → let the input handle it.
  if (flat.length <= 1 && grid.length === 1) return
  e.preventDefault()
  const out = {}
  if (x && flat[0] !== undefined) out.x_axis_title = String(flat[0]).trim()
  // Second cell or next row's first cell → Y title.
  const ySource = flat[1] ?? grid[1]?.[0]
  if (y && ySource !== undefined) out.y_axis_title = String(ySource).trim()
  patch(out)
}

function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}

/** Coerce a raw paste cell to a number, or '' when empty / NaN.
 *  Scatter is numeric-only so non-numeric text → blank rather than
 *  leaving stringy data in the row. */
function coerceNum(raw) {
  if (raw === undefined || raw === null) return ''
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '') return ''
  const n = Number(s)
  return Number.isFinite(n) ? n : ''
}

function buildScatterAdapter(xScale, yScale, xInverse, yInverse, bounds) {
  function toPxCoord(scale, value) {
    if (scale == null) return NaN
    const out = scale(value)
    return typeof out === 'number' && Number.isFinite(out) ? out : NaN
  }
  return {
    coordSpace: 'data',
    supportedTypes: ['vline', 'vrange', 'hline', 'hrange', 'point', 'rect', 'arrow', 'text'],
    bounds,
    toPx(g) {
      const out = {}
      if ('x' in g) out.x = toPxCoord(xScale, g.x)
      if ('y' in g) out.y = toPxCoord(yScale, g.y)
      if ('x_from' in g) out.x_from = toPxCoord(xScale, g.x_from)
      if ('x_to' in g) out.x_to = toPxCoord(xScale, g.x_to)
      if ('y_from' in g) out.y_from = toPxCoord(yScale, g.y_from)
      if ('y_to' in g) out.y_to = toPxCoord(yScale, g.y_to)
      if (g.from) out.from = { x: toPxCoord(xScale, g.from.x), y: toPxCoord(yScale, g.from.y) }
      if (g.to) out.to = { x: toPxCoord(xScale, g.to.x), y: toPxCoord(yScale, g.to.y) }
      return out
    },
    fromPx(p) {
      const out = {}
      if ('x' in p && xInverse) out.x = xInverse(p.x)
      if ('y' in p && yInverse) out.y = yInverse(p.y)
      return out
    },
    snap(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return value
      // Continuous-only — use the same domain-relative step the chart
      // adapter uses (~1% of range, power of 10).
      const dom = xScale?.domain?.()
      if (!Array.isArray(dom)) return value
      const d0 = Number(dom[0])
      const d1 = Number(dom[dom.length - 1])
      if (!Number.isFinite(d0) || !Number.isFinite(d1)) return value
      const range = Math.abs(d1 - d0)
      if (range === 0) return value
      const step = Math.pow(10, Math.floor(Math.log10(range / 100)))
      return Math.round(value / step) * step
    },
  }
}
