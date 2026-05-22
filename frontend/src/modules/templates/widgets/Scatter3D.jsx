/**
 * 3D scatter widget. Each series picks three columns from the data
 * — (x, y, z) — and is plotted as a marker cloud via Plotly.js. The
 * data entry surface mirrors the 2D scatter widget (paste support,
 * per-series column dropdowns); the canvas itself is Plotly because
 * Recharts has no 3-D primitives.
 *
 * Annotations are intentionally NOT supported here — the user can
 * rotate / pan the 3-D scene freely, so 2-D-pixel annotation
 * geometry would drift away from the data points it was anchored to.
 * Re-enable when / if a 3-D-aware annotation system lands.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import Plotly from 'plotly.js-dist'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, DataTableActions, LabelField, PreviewLabel, captionSkipProps, toTsv } from './_shared'

const SERIES_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#475569',
]

// Colorscale options shown in the top toolbar. Values are Plotly's
// named colorscales — pass directly to traces. Backend enum mirrors
// this list (registry.py `_SCATTER3D_COLORSCALES`).
const COLORSCALE_OPTIONS = [
  { value: 'Viridis', label: '비리디스 (보라→노랑)' },
  { value: 'Plasma', label: '플라즈마 (보라→노랑)' },
  { value: 'Cividis', label: '시비디스 (색약 친화)' },
  { value: 'Hot', label: '핫 (검정→빨강→노랑)' },
  { value: 'Blues', label: '파랑 단색' },
  { value: 'Reds', label: '빨강 단색' },
  { value: 'Greens', label: '초록 단색' },
  { value: 'RdBu', label: '빨강↔파랑' },
  { value: 'Bluered', label: '파랑→흰→빨강' },
  { value: 'Portland', label: '포틀랜드' },
  { value: 'Jet', label: '제트 (무지개, 레거시)' },
]

// --------------------------------------------------------------------------- //
// Props panel — template-time config                                            //
// --------------------------------------------------------------------------- //

export function Scatter3DPropsPanel({ props, onChange }) {
  function patch(next) {
    onChange({ ...props, ...next })
  }
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="3D 측정 결과"
      />
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label className="text-xs">X 축 제목</Label>
          <Input
            value={props.x_axis_title ?? ''}
            onChange={(e) => patch({ x_axis_title: e.target.value })}
            className="mt-1 h-9 text-sm"
            placeholder="(없음)"
          />
        </div>
        <div>
          <Label className="text-xs">Y 축 제목</Label>
          <Input
            value={props.y_axis_title ?? ''}
            onChange={(e) => patch({ y_axis_title: e.target.value })}
            className="mt-1 h-9 text-sm"
            placeholder="(없음)"
          />
        </div>
        <div>
          <Label className="text-xs">Z 축 제목</Label>
          <Input
            value={props.z_axis_title ?? ''}
            onChange={(e) => patch({ z_axis_title: e.target.value })}
            className="mt-1 h-9 text-sm"
            placeholder="(없음)"
          />
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview thumbnail                                                             //
// --------------------------------------------------------------------------- //

export function Scatter3DPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="3D 산점도">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-muted-foreground text-xs">
        x · y · z 3축 좌표 (회전 가능)
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function Scatter3DEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const columns = Array.isArray(content?.columns) && content.columns.length > 0
    ? content.columns
    : (props?.columns ?? [])
  const rows = Array.isArray(content?.rows) ? content.rows : []
  const xAxisTitle = content?.x_axis_title ?? props?.x_axis_title ?? ''
  const yAxisTitle = content?.y_axis_title ?? props?.y_axis_title ?? ''
  const zAxisTitle = content?.z_axis_title ?? props?.z_axis_title ?? ''
  // Single chart-wide colorscale — applied to every series whose
  // `color_key` is set. Defaults to Viridis for color-blind safety.
  const colorscale = content?.colorscale ?? 'Viridis'

  // Series defaults to a single scatter3d (x, y, z) triple drawn
  // from the first three columns when content.series is absent.
  const series = useMemo(() => {
    if (Array.isArray(content?.series) && content.series.length > 0) {
      return content.series
    }
    if (columns.length < 3) return []
    return [
      {
        label: '시리즈 1',
        kind: 'scatter3d',
        x_key: columns[0].key,
        y_key: columns[1].key,
        z_key: columns[2].key,
      },
    ]
  }, [content?.series, columns])

  function patch(next) {
    const merged = { ...(content ?? {}), caption, rows, columns, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (Array.isArray(merged.series) && merged.series.length === 0) {
      delete merged.series
    }
    if (!merged.x_axis_title) delete merged.x_axis_title
    if (!merged.y_axis_title) delete merged.y_axis_title
    if (!merged.z_axis_title) delete merged.z_axis_title
    // Drop the colorscale field when it matches the default — keeps
    // the wire payload tight for the common case.
    if (merged.colorscale === 'Viridis' || !merged.colorscale) {
      delete merged.colorscale
    }
    onChange(merged)
  }

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
    patch({ columns: columns.map((c, i) => (i === idx ? { ...c, label } : c)) })
  }
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
  function removeColumn(idx) {
    const col = columns[idx]
    if (!col) return
    if (columns.length <= 3) return // need at least one (x, y, z) triple
    const nextCols = columns.filter((_, i) => i !== idx)
    const nextRows = rows.map((r) => {
      const copy = { ...r }
      delete copy[col.key]
      return copy
    })
    const nextSeries = series.filter(
      (s) => s.x_key !== col.key && s.y_key !== col.key && s.z_key !== col.key,
    )
    patch({ columns: nextCols, rows: nextRows, series: nextSeries })
  }

  function ensureColsFor(needed, base) {
    const baseCols = base ?? columns
    if (needed <= baseCols.length) return baseCols
    const next = [...baseCols]
    const used = new Set(next.map((c) => c.key))
    while (next.length < needed) {
      let n = next.length + 1
      let key = `c${n}`
      while (used.has(key)) {
        n += 1
        key = `c${n}`
      }
      used.add(key)
      next.push({ key, label: '', type: 'number' })
    }
    return next
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
        target[col.key] = coerceNum(grid[r][c])
      }
      nextRows[startRow + r] = target
    }
    patch({ columns: nextCols, rows: nextRows })
  }
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

  function patchSeries(nextSeries) {
    patch({ series: nextSeries })
  }
  function updateSeries(idx, patch_) {
    patchSeries(series.map((s, i) => (i === idx ? { ...s, ...patch_ } : s)))
  }
  function removeSeriesAt(idx) {
    patchSeries(series.filter((_, i) => i !== idx))
  }
  /** Adds a new (x, y, z) triple series. Picks the first three
   *  existing columns; auto-creates additional columns if fewer
   *  than three exist. */
  function addTripleSeries() {
    let workingCols = [...columns]
    while (workingCols.length < 3) {
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
      kind: 'scatter3d',
      x_key: workingCols[0].key,
      y_key: workingCols[1].key,
      z_key: workingCols[2].key,
    }
    const nextPatch = { series: [...series, candidate] }
    if (workingCols.length !== columns.length) nextPatch.columns = workingCols
    patch(nextPatch)
  }

  // Build per-series (x, y, z [, c]) tuples for Plotly. Surface and
  // scatter share the same long-form `points` array — the canvas
  // pivots it to a grid before issuing the Plotly surface trace.
  // When `color_key` is set, each point also carries `c` so markers
  // (scatter) and surfacecolor (surface) can be painted by an
  // independent column.
  const seriesData = useMemo(() => {
    return series.map((s, i) => {
      const colorKey = s.color_key || null
      const colorCol = colorKey
        ? columns.find((c) => c.key === colorKey)
        : null
      // If the referenced color column went away (renamed / removed),
      // treat it as "no color axis" rather than render NaN soup.
      const effectiveColorKey = colorCol ? colorKey : null
      return {
        key: `s${i}-${s.kind || 'scatter3d'}-${s.x_key}-${s.y_key}-${s.z_key}-${effectiveColorKey ?? ''}`,
        label: s.label || `시리즈 ${i + 1}`,
        kind: s.kind === 'surface' ? 'surface' : 'scatter3d',
        color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
        colorKey: effectiveColorKey,
        colorTitle: colorCol?.label || effectiveColorKey || '',
        points: rows
          .map((r) => ({
            x: r[s.x_key],
            y: r[s.y_key],
            z: r[s.z_key],
            c: effectiveColorKey ? r[effectiveColorKey] : undefined,
          }))
          .filter(
            (p) =>
              Number.isFinite(p.x) &&
              Number.isFinite(p.y) &&
              Number.isFinite(p.z),
          ),
      }
    })
  }, [rows, series, columns])

  const hasData = seriesData.some((s) => s.points.length > 0)

  if (readOnly) {
    if (!caption && !hasData) return null
    return (
      <div className={autoFit ? 'space-y-2' : 'flex flex-col h-full gap-2 min-h-0'}>
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
        />
        {hasData && (
          <div className={autoFit ? '' : 'flex-1 min-h-0'}>
            <Scatter3DCanvas
              seriesData={seriesData}
              xAxisTitle={xAxisTitle}
              yAxisTitle={yAxisTitle}
              zAxisTitle={zAxisTitle}
              colorscale={colorscale}
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
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Z 제목:</span>
          <Input
            value={zAxisTitle}
            onChange={(e) => patch({ z_axis_title: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-20 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">색상:</span>
          <select
            value={colorscale}
            onChange={(e) => patch({ colorscale: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
            title="시리즈 색축이 지정될 때 사용되는 컬러스케일"
          >
            {COLORSCALE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <span className="text-[10px] text-muted-foreground">
          드래그로 회전 · 휠로 확대 · 호버로 좌표 확인
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          {hasData ? (
            <Scatter3DCanvas
              seriesData={seriesData}
              xAxisTitle={xAxisTitle}
              yAxisTitle={yAxisTitle}
              zAxisTitle={zAxisTitle}
              colorscale={colorscale}
              autoFit={false}
            />
          ) : (
            <div className="flex-1 min-h-0 rounded-md border border-dashed bg-muted/20 flex items-center justify-center text-xs text-muted-foreground">
              X / Y / Z 값을 입력하면 3D 그래프가 그려집니다.
            </div>
          )}
        </div>

        <div className="space-y-3 min-h-0 overflow-y-auto pr-1">
          {/* Series — (x, y, z) triples */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">시리즈</span>
              <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addTripleSeries}>
                <Plus className="h-3 w-3 mr-1" /> 시리즈 추가
              </Button>
            </div>
            {series.length === 0 ? (
              <div className="rounded border border-dashed p-2 text-[11px] text-muted-foreground text-center">
                시리즈를 추가해 (x, y, z) 컬럼 3개를 지정하세요.
              </div>
            ) : (
              <div className="space-y-1">
                {series.map((s, i) => {
                  const color = s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]
                  const kind = s.kind === 'surface' ? 'surface' : 'scatter3d'
                  return (
                    <div key={`${s.x_key}-${s.y_key}-${s.z_key}-${i}`} className="space-y-1 rounded border px-1.5 py-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-3 w-3 rounded-sm shrink-0"
                          style={{ background: color }}
                          title={color}
                        />
                        <Input
                          value={s.label ?? ''}
                          onChange={(e) => updateSeries(i, { label: e.target.value })}
                          placeholder={`시리즈 ${i + 1}`}
                          className="h-7 flex-1 text-xs"
                        />
                        <select
                          value={kind}
                          onChange={(e) => updateSeries(i, { kind: e.target.value })}
                          className="h-7 rounded border px-1 text-[11px] shrink-0"
                          title="시리즈 표시 방식"
                        >
                          <option value="scatter3d">산점</option>
                          <option value="surface">표면</option>
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
                      <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
                        <SeriesAxisPicker
                          label="X"
                          value={s.x_key}
                          columns={columns}
                          onChange={(v) => updateSeries(i, { x_key: v })}
                        />
                        <SeriesAxisPicker
                          label="Y"
                          value={s.y_key}
                          columns={columns}
                          onChange={(v) => updateSeries(i, { y_key: v })}
                        />
                        <SeriesAxisPicker
                          label="Z"
                          value={s.z_key}
                          columns={columns}
                          onChange={(v) => updateSeries(i, { z_key: v })}
                        />
                        <SeriesAxisPicker
                          label="색"
                          value={s.color_key ?? ''}
                          columns={columns}
                          allowNone
                          onChange={(v) =>
                            updateSeries(i, { color_key: v || undefined })
                          }
                        />
                      </div>
                      {kind === 'surface' && (
                        <p className="text-[10px] text-muted-foreground">
                          표면은 (X, Y)가 정규 격자일 때 깔끔합니다. 데이터가 듬성하면 빈 셀로 보일 수 있어요.
                        </p>
                      )}
                      {s.color_key && (
                        <p className="text-[10px] text-muted-foreground">
                          색 축이 지정되어 산점은 점 색상, 표면은 컨투어로 칠해집니다 (시리즈 색은 무시).
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Data */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground">데이터</span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-6 text-xs" onClick={addColumn}>
                  <Plus className="h-3 w-3 mr-1" /> 열 추가
                </Button>
                <DataTableActions
                  label="3D 산점도 데이터"
                  onCopy={() => {
                    const header = columns.map((c) => c.label || c.key)
                    const body = rows.map((row) => columns.map((c) => row[c.key]))
                    return toTsv([header, ...body])
                  }}
                  onClear={() => patch({ rows: [] })}
                />
              </div>
            </div>
            {/* See Scatter.jsx for sizing notes — same `6rem` min per
                column + horizontal overflow scroll on the wrapper. */}
            <div className="space-y-1 max-h-[24rem] overflow-auto">
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
              <div className="grid items-center gap-1 w-max min-w-full"
                style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(6rem, 1fr)) auto` }}>
                {columns.map((c, ci) => (
                  <Button
                    key={c.key}
                    variant="ghost"
                    size="sm"
                    className="h-5 text-[10px] text-destructive"
                    disabled={columns.length <= 3}
                    onClick={() => removeColumn(ci)}
                  >
                    <Trash2 className="h-3 w-3 mr-1" /> 열 삭제
                  </Button>
                ))}
                <div className="w-7" />
              </div>
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

function SeriesAxisPicker({ label, value, columns, onChange, allowNone = false }) {
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span className="shrink-0">{label}:</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded border px-1 text-[11px] flex-1 min-w-0"
      >
        {allowNone && <option value="">(없음)</option>}
        {columns.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label || c.key}
          </option>
        ))}
      </select>
    </span>
  )
}

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

function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}

function coerceNum(raw) {
  if (raw === undefined || raw === null) return ''
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '') return ''
  const n = Number(s)
  return Number.isFinite(n) ? n : ''
}

// --------------------------------------------------------------------------- //
// Plotly canvas — rotation / zoom / hover come for free                         //
// --------------------------------------------------------------------------- //

function Scatter3DCanvas({ seriesData, xAxisTitle, yAxisTitle, zAxisTitle, colorscale = 'Viridis', autoFit = true }) {
  const containerRef = useRef(null)
  // Sizing — mirrors the 2D scatter / chart pattern:
  //   autoFit=true  → square (height tracks measured width). Used in
  //                   in-grid cells without a definite height.
  //   autoFit=false → fill parent (height: 100%). Used in the edit
  //                   modal where the dialog provides 80vh.
  // ResizeObserver also drives a Plotly relayout in the second effect
  // below so the 3-D scene resizes with the container in both modes.
  //
  // resize-debouncing: Plotly's `react()` is incremental but still
  // expensive enough that calling it many times a second during an
  // RGL drag lags. We overlay a placeholder while size is in flight
  // and let Plotly re-render once 200 ms after the last measurement.
  const [size, setSize] = useState(null)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    let firstCall = true
    const measure = () => {
      const w = el.clientWidth
      if (w <= 0) return
      // autoFit mode: square clamp; otherwise: track the width so
      // Plotly's responsive resize fires on width changes too.
      const next = autoFit ? Math.max(240, Math.min(720, w)) : w
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

  // Render / re-render the plot whenever inputs change. Plotly owns
  // its own DOM inside containerRef — we never let React touch the
  // chart's children. Purge on unmount to release WebGL contexts.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !size) return undefined
    // Suspend Plotly.react during an active resize burst so the
    // ResizeObserver storm doesn't repaint the scene on every tick.
    // We refire once when `resizing` settles to false.
    if (resizing) return undefined
    // When a series carries an independent color axis we use Plotly's
    // Viridis ramp for it (the series' base color is meaningless
    // here — the colorbar carries the visual semantics instead). The
    // first series with a color axis gets a visible colorbar; further
    // ones suppress it so the canvas doesn't grow a stack of bars.
    let colorbarShown = false
    const traces = seriesData.map((s) => {
      const hasColorAxis = !!s.colorKey
      const showColorbar = hasColorAxis && !colorbarShown
      if (hasColorAxis) colorbarShown = true

      if (s.kind === 'surface') {
        const pivot = pivotToGrid(s.points, hasColorAxis)
        const baseColorscale = [
          [0, lighten(s.color, 0.85)],
          [1, s.color],
        ]
        return {
          type: 'surface',
          name: s.label,
          x: pivot.x,
          y: pivot.y,
          z: pivot.z,
          // When the user assigned a color axis, paint by it +
          // overlay contour lines colored from the same ramp. Without
          // an axis, fall back to the single-tone per-series ramp.
          ...(hasColorAxis
            ? {
                surfacecolor: pivot.c,
                colorscale: colorscale,
                showscale: showColorbar,
                colorbar: showColorbar
                  ? { title: { text: s.colorTitle || '색' }, len: 0.6, thickness: 12 }
                  : undefined,
                contours: {
                  z: {
                    show: true,
                    usecolormap: true,
                    highlightcolor: '#ffffff',
                    project: { z: true },
                  },
                },
              }
            : {
                colorscale: baseColorscale,
                showscale: false,
              }),
          opacity: 0.85,
          hovertemplate:
            `<b>${escapeHtml(s.label)}</b><br>` +
            `${escapeHtml(xAxisTitle || 'x')}: %{x}<br>` +
            `${escapeHtml(yAxisTitle || 'y')}: %{y}<br>` +
            `${escapeHtml(zAxisTitle || 'z')}: %{z}` +
            (hasColorAxis
              ? `<br>${escapeHtml(s.colorTitle || '색')}: %{surfacecolor}`
              : '') +
            '<extra></extra>',
        }
      }
      // scatter3d — marker.color becomes an array when a color axis
      // is set, with Viridis colorscale + colorbar.
      return {
        type: 'scatter3d',
        mode: 'markers',
        name: s.label,
        x: s.points.map((p) => p.x),
        y: s.points.map((p) => p.y),
        z: s.points.map((p) => p.z),
        marker: hasColorAxis
          ? {
              size: 5,
              color: s.points.map((p) =>
                Number.isFinite(p.c) ? p.c : null,
              ),
              colorscale: colorscale,
              showscale: showColorbar,
              colorbar: showColorbar
                ? { title: { text: s.colorTitle || '색' }, len: 0.6, thickness: 12 }
                : undefined,
              opacity: 0.85,
              line: { color: '#333', width: 0.5 },
            }
          : {
              size: 5,
              color: s.color,
              opacity: 0.85,
              line: { color: '#333', width: 0.5 },
            },
        // Custom hover field for the color axis value when active.
        customdata: hasColorAxis ? s.points.map((p) => p.c) : undefined,
        hovertemplate:
          `<b>${escapeHtml(s.label)}</b><br>` +
          `${escapeHtml(xAxisTitle || 'x')}: %{x}<br>` +
          `${escapeHtml(yAxisTitle || 'y')}: %{y}<br>` +
          `${escapeHtml(zAxisTitle || 'z')}: %{z}` +
          (hasColorAxis
            ? `<br>${escapeHtml(s.colorTitle || '색')}: %{customdata}`
            : '') +
          '<extra></extra>',
      }
    })
    const layout = {
      autosize: true,
      margin: { l: 0, r: 0, t: 8, b: 0 },
      paper_bgcolor: '#ffffff',
      scene: {
        xaxis: { title: { text: xAxisTitle || 'X' }, gridcolor: '#e5e7eb' },
        yaxis: { title: { text: yAxisTitle || 'Y' }, gridcolor: '#e5e7eb' },
        zaxis: { title: { text: zAxisTitle || 'Z' }, gridcolor: '#e5e7eb' },
        bgcolor: '#fafafa',
      },
      showlegend: seriesData.length > 1,
      legend: { x: 1.02, y: 1, font: { size: 11 } },
    }
    const config = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['sendDataToCloud'],
    }
    Plotly.react(el, traces, layout, config)
    return () => {
      // Don't purge between updates — that'd reset the camera every
      // time. Purge only on unmount via the empty-deps cleanup below.
    }
  }, [seriesData, size, xAxisTitle, yAxisTitle, zAxisTitle, colorscale, resizing])

  // Final-unmount purge so WebGL contexts get released.
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
      {/* Plotly target — React never reaches inside this div, Plotly
          manages all its children. We keep it mounted across resize
          bursts so WebGL contexts don't churn; the resize handler
          just suspends Plotly.react until the size settles. */}
      <div ref={containerRef} className="absolute inset-0" />
      {resizing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-[11px] text-muted-foreground bg-muted/20">
          크기 조정 중…
        </div>
      )}
    </div>
  )
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Pivot a long-form [{x, y, z[, c]}] list into the regular-grid
 *  shape Plotly's `surface` trace needs:
 *    x: unique x values, sorted asc
 *    y: unique y values, sorted asc
 *    z: 2-D array shape [len(y)][len(x)], NaN for missing cells
 *    c: 2-D array same shape as z when `withColor=true` — used for
 *       `surfacecolor` so the surface paints by an independent axis
 *  Sorting matters — Plotly assumes the grid is monotonic in both
 *  axes for correct face shading. */
function pivotToGrid(points, withColor = false) {
  const xSet = new Set()
  const ySet = new Set()
  for (const p of points) {
    xSet.add(p.x)
    ySet.add(p.y)
  }
  const xs = Array.from(xSet).sort((a, b) => a - b)
  const ys = Array.from(ySet).sort((a, b) => a - b)
  const xIdx = new Map(xs.map((v, i) => [v, i]))
  const yIdx = new Map(ys.map((v, i) => [v, i]))
  const z = Array.from({ length: ys.length }, () =>
    Array.from({ length: xs.length }, () => NaN),
  )
  const c = withColor
    ? Array.from({ length: ys.length }, () =>
        Array.from({ length: xs.length }, () => NaN),
      )
    : null
  for (const p of points) {
    const i = yIdx.get(p.y)
    const j = xIdx.get(p.x)
    if (i == null || j == null) continue
    z[i][j] = p.z
    if (c && Number.isFinite(p.c)) c[i][j] = p.c
  }
  return { x: xs, y: ys, z, c }
}

/** Mix the given hex color with white by the given factor (0..1).
 *  Used to build a per-series colorscale [light, dark] so surfaces
 *  paint in their own color rather than Plotly's default rainbow. */
function lighten(hex, factor) {
  const f = Math.max(0, Math.min(1, factor))
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const lr = Math.round(r + (255 - r) * f)
  const lg = Math.round(g + (255 - g) * f)
  const lb = Math.round(b + (255 - b) * f)
  return `#${[lr, lg, lb].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
