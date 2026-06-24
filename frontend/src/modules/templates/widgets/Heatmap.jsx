/**
 * Heatmap widget — 2D color matrix.
 *
 * Data model differs from the scatter family: there's no "columns
 * with keys" abstraction; we store positional `x_labels[]`,
 * `y_labels[]`, and a `matrix[row][col]` of numbers (nullable for
 * sparse cells). Rendering goes through Plotly's `heatmap` trace.
 *
 * Editor surface mirrors the scatter widgets:
 *   - top toolbar: axis titles + colorscale + z range + show-values
 *   - 50/50 grid below: chart (left) / data table (right)
 *   - data table accepts Excel-style multi-cell paste, including
 *     pastes that land on the top-left corner (first row → x labels,
 *     first column → y labels, rest → matrix)
 *
 * Annotations are out of scope — heatmaps already encode the data
 * through color + optional cell labels; bolting on freeform marks
 * would clutter the encoding for limited gain.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import Plotly from 'plotly.js-dist'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  AxisRangeInput,
  CaptionInput,
  captionPositionOf,
  DataTableActions,
  LabelField,
  PreviewLabel,
  captionSkipProps,
  toTsv,
} from './_shared'

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

// Default 3×3 starter matrix so a newly added widget renders something
// rather than an empty placeholder.
const DEFAULT_X = ['X1', 'X2', 'X3']
const DEFAULT_Y = ['Y1', 'Y2', 'Y3']
const DEFAULT_MATRIX = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function HeatmapPropsPanel({ props, onChange }) {
  function patch(next) {
    onChange({ ...props, ...next })
  }
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="상관 행렬"
      />
      <div className="grid grid-cols-2 gap-2">
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
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function HeatmapPreview({ props }) {
  // Tiny 3×3 swatch giving a hint that this widget is a color matrix.
  const swatch = [
    ['#1f3b6f', '#27598f', '#3477b0'],
    ['#3a93cf', '#69b3d7', '#a4d0e3'],
    ['#d6e3ec', '#f5e6cc', '#f4b873'],
  ]
  return (
    <div className="space-y-2">
      <PreviewLabel hint="2D 값 매트릭스">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <div className="grid grid-cols-3 gap-0.5">
          {swatch.flat().map((c, i) => (
            <div key={i} className="w-5 h-5 rounded-sm" style={{ background: c }} />
          ))}
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function HeatmapEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const xLabels = useMemo(
    () => (Array.isArray(content?.x_labels) ? content.x_labels : DEFAULT_X),
    [content?.x_labels],
  )
  const yLabels = useMemo(
    () => (Array.isArray(content?.y_labels) ? content.y_labels : DEFAULT_Y),
    [content?.y_labels],
  )
  const matrix = useMemo(
    () => normalizeMatrix(content?.matrix, yLabels.length, xLabels.length, DEFAULT_MATRIX),
    [content?.matrix, xLabels.length, yLabels.length],
  )
  const colorscale = content?.colorscale ?? 'Viridis'
  const reverseScale = content?.reverse_scale ?? false
  const xAxisTitle = content?.x_axis_title ?? props?.x_axis_title ?? ''
  const yAxisTitle = content?.y_axis_title ?? props?.y_axis_title ?? ''
  const showValues = content?.show_values ?? false
  const zMin = content?.z_min
  const zMax = content?.z_max
  const capPos = captionPositionOf(content)

  function patch(next) {
    const merged = { ...(content ?? {}), x_labels: xLabels, y_labels: yLabels, matrix, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.x_axis_title) delete merged.x_axis_title
    if (!merged.y_axis_title) delete merged.y_axis_title
    if (merged.colorscale === 'Viridis' || !merged.colorscale) delete merged.colorscale
    if (!merged.reverse_scale) delete merged.reverse_scale
    if (!merged.show_values) delete merged.show_values
    for (const k of ['z_min', 'z_max']) {
      if (merged[k] === undefined || Number.isNaN(merged[k])) delete merged[k]
    }
    onChange(merged)
  }

  function setXLabel(i, label) {
    const next = xLabels.slice()
    next[i] = label
    patch({ x_labels: next })
  }
  function setYLabel(i, label) {
    const next = yLabels.slice()
    next[i] = label
    patch({ y_labels: next })
  }
  function setCell(r, c, v) {
    const next = matrix.map((row) => row.slice())
    const n = v === '' || v === null || v === undefined ? null : Number(v)
    next[r][c] = Number.isFinite(n) ? n : null
    patch({ matrix: next })
  }
  function addRow() {
    const nextY = [...yLabels, `Y${yLabels.length + 1}`]
    const nextMatrix = [...matrix, new Array(xLabels.length).fill(null)]
    patch({ y_labels: nextY, matrix: nextMatrix })
  }
  function removeRow(idx) {
    if (yLabels.length <= 1) return
    const nextY = yLabels.filter((_, i) => i !== idx)
    const nextMatrix = matrix.filter((_, i) => i !== idx)
    patch({ y_labels: nextY, matrix: nextMatrix })
  }
  function addColumn() {
    const nextX = [...xLabels, `X${xLabels.length + 1}`]
    const nextMatrix = matrix.map((row) => [...row, null])
    patch({ x_labels: nextX, matrix: nextMatrix })
  }
  function removeColumn(idx) {
    if (xLabels.length <= 1) return
    const nextX = xLabels.filter((_, i) => i !== idx)
    const nextMatrix = matrix.map((row) => row.filter((_, i) => i !== idx))
    patch({ x_labels: nextX, matrix: nextMatrix })
  }

  /** Paste handler. Two modes inferred from the TSV shape:
   *   1. Single cell  → falls through to browser default (inline edit)
   *   2. Multi-cell   → land starting at (startRow, startCol). If the
   *                     paste lands at (0, 0) AND its top-left cell is
   *                     empty / non-numeric, treat the first row as
   *                     x_labels and the first column as y_labels —
   *                     matches how Excel "selection with headers"
   *                     copies look.
   *  startRow / startCol use 0-based indices into the body cells:
   *  startRow = -1 indicates the header row, startCol = -1 the header
   *  column. */
  function pasteAt(startRow, startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingHeight = grid.length
    const incomingWidth = Math.max(...grid.map((r) => r.length))

    // Header-paste detection — only when landing on the top-left
    // corner AND the corner cell is empty (Excel emits an empty
    // top-left when copying with headers).
    const looksLikeHeadered =
      startRow === -1 &&
      startCol === -1 &&
      (grid[0][0] ?? '') === '' &&
      incomingHeight > 1 &&
      incomingWidth > 1
    if (looksLikeHeadered) {
      const xs = grid[0].slice(1).map((s) => String(s ?? '').trim())
      const ys = grid.slice(1).map((row) => String(row[0] ?? '').trim())
      const body = grid.slice(1).map((row) => row.slice(1).map(coerceNumOrNull))
      const nextX = [...xLabels]
      while (nextX.length < xs.length) nextX.push(`X${nextX.length + 1}`)
      for (let i = 0; i < xs.length; i += 1) {
        if (xs[i]) nextX[i] = xs[i]
      }
      const nextY = [...yLabels]
      while (nextY.length < ys.length) nextY.push(`Y${nextY.length + 1}`)
      for (let i = 0; i < ys.length; i += 1) {
        if (ys[i]) nextY[i] = ys[i]
      }
      const nextMatrix = matrix.map((r) => r.slice())
      while (nextMatrix.length < nextY.length) {
        nextMatrix.push(new Array(nextX.length).fill(null))
      }
      // Widen every row to the new column count.
      for (let r = 0; r < nextMatrix.length; r += 1) {
        while (nextMatrix[r].length < nextX.length) nextMatrix[r].push(null)
      }
      for (let r = 0; r < body.length; r += 1) {
        for (let c = 0; c < body[r].length; c += 1) {
          nextMatrix[r][c] = body[r][c]
        }
      }
      patch({ x_labels: nextX, y_labels: nextY, matrix: nextMatrix })
      return
    }

    // Generic body paste — extend matrix as needed.
    const targetRow = Math.max(0, startRow)
    const targetCol = Math.max(0, startCol)
    const needRows = targetRow + incomingHeight
    const needCols = targetCol + incomingWidth
    const nextX = [...xLabels]
    while (nextX.length < needCols) nextX.push(`X${nextX.length + 1}`)
    const nextY = [...yLabels]
    while (nextY.length < needRows) nextY.push(`Y${nextY.length + 1}`)
    const nextMatrix = matrix.map((r) => r.slice())
    while (nextMatrix.length < nextY.length) {
      nextMatrix.push(new Array(nextX.length).fill(null))
    }
    for (let r = 0; r < nextMatrix.length; r += 1) {
      while (nextMatrix[r].length < nextX.length) nextMatrix[r].push(null)
    }
    for (let r = 0; r < incomingHeight; r += 1) {
      for (let c = 0; c < grid[r].length; c += 1) {
        nextMatrix[targetRow + r][targetCol + c] = coerceNumOrNull(grid[r][c])
      }
    }
    patch({ x_labels: nextX, y_labels: nextY, matrix: nextMatrix })
  }

  /** Header-label paste — TSV row → multiple labels at once.
   *  For X header row: paste extends/relabels x_labels.
   *  For Y header column: each pasted line → one y_label. */
  function pasteHeader(axis, startIdx, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const cells = axis === 'x' ? grid[0] : grid.map((row) => row[0] ?? '')
    if (axis === 'x') {
      const nextX = [...xLabels]
      while (nextX.length < startIdx + cells.length) {
        nextX.push(`X${nextX.length + 1}`)
      }
      const nextMatrix = matrix.map((row) => {
        const r = row.slice()
        while (r.length < nextX.length) r.push(null)
        return r
      })
      for (let i = 0; i < cells.length; i += 1) {
        const label = String(cells[i] ?? '').trim()
        if (label) nextX[startIdx + i] = label
      }
      patch({ x_labels: nextX, matrix: nextMatrix })
    } else {
      const nextY = [...yLabels]
      while (nextY.length < startIdx + cells.length) {
        nextY.push(`Y${nextY.length + 1}`)
      }
      const nextMatrix = matrix.slice()
      while (nextMatrix.length < nextY.length) {
        nextMatrix.push(new Array(xLabels.length).fill(null))
      }
      for (let i = 0; i < cells.length; i += 1) {
        const label = String(cells[i] ?? '').trim()
        if (label) nextY[startIdx + i] = label
      }
      patch({ y_labels: nextY, matrix: nextMatrix })
    }
  }

  if (readOnly) {
    return (
      <div className={autoFit ? 'space-y-2' : 'flex flex-col h-full gap-2 min-h-0'}>
        {capPos !== 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
        <div className={autoFit ? '' : 'flex-1 min-h-0'}>
          <HeatmapCanvas
            xLabels={xLabels}
            yLabels={yLabels}
            matrix={matrix}
            colorscale={colorscale}
            reverseScale={reverseScale}
            zMin={zMin}
            zMax={zMax}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            showValues={showValues}
            autoFit={autoFit}
          />
        </div>
        {capPos === 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full gap-3 min-h-0">
      {capPos !== 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patch({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch })}
        />
      )}

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
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={reverseScale}
            onChange={(e) => patch({ reverse_scale: e.target.checked })}
          />
          <span className="text-muted-foreground">색 반전</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showValues}
            onChange={(e) => patch({ show_values: e.target.checked })}
          />
          <span className="text-muted-foreground">값 표시</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>색 범위 (선택):</span>
        <AxisRangeInput label="z min" value={zMin} onChange={(v) => patch({ z_min: v })} />
        <AxisRangeInput label="z max" value={zMax} onChange={(v) => patch({ z_max: v })} />
        <span className="text-[10px]">미설정 시 데이터 범위로 자동 맞춤</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        {/* Heatmap canvas */}
        <div className="min-h-0 flex flex-col">
          <HeatmapCanvas
            xLabels={xLabels}
            yLabels={yLabels}
            matrix={matrix}
            colorscale={colorscale}
            reverseScale={reverseScale}
            zMin={zMin}
            zMax={zMax}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            showValues={showValues}
            autoFit={false}
          />
        </div>

        {/* Data entry — top-left corner accepts headered paste, body
            cells accept body-only paste. */}
        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="히트맵 데이터"
              onCopy={() => {
                const header = ['', ...xLabels]
                const body = matrix.map((row, i) => [yLabels[i] ?? '', ...row])
                return toTsv([header, ...body])
              }}
              onClear={() => {
                const emptyMatrix = matrix.map((row) => row.map(() => null))
                patch({ matrix: emptyMatrix })
              }}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
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
                      className="h-7 w-24 text-[10px] text-center border-0"
                      // The corner doesn't capture user typing — it's
                      // only a paste target — so block onChange-driven
                      // mutations by treating it as readOnly.
                      onChange={() => {}}
                    />
                  </th>
                  {xLabels.map((label, ci) => (
                    <th key={ci} className="border border-muted bg-muted/30 p-0">
                      <Input
                        value={label ?? ''}
                        onChange={(e) => setXLabel(ci, e.target.value)}
                        onPaste={(e) => {
                          const text = e.clipboardData?.getData('text/plain')
                          if (!text) return
                          if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
                          e.preventDefault()
                          pasteHeader('x', ci, text)
                        }}
                        className="h-7 w-20 text-[11px] text-center border-0"
                        placeholder={`X${ci + 1}`}
                      />
                    </th>
                  ))}
                  <th className="border border-muted bg-muted/30 w-7 text-center">
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addColumn} title="열 추가">
                      <Plus className="h-3 w-3" />
                    </Button>
                  </th>
                </tr>
                {/* Column-delete row */}
                <tr>
                  <th />
                  {xLabels.map((_, ci) => (
                    <th key={ci} className="text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-destructive"
                        disabled={xLabels.length <= 1}
                        onClick={() => removeColumn(ci)}
                        title="열 삭제"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {yLabels.map((label, ri) => (
                  <tr key={ri}>
                    <th className="border border-muted bg-muted/30 p-0">
                      <Input
                        value={label ?? ''}
                        onChange={(e) => setYLabel(ri, e.target.value)}
                        onPaste={(e) => {
                          const text = e.clipboardData?.getData('text/plain')
                          if (!text) return
                          if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
                          e.preventDefault()
                          pasteHeader('y', ri, text)
                        }}
                        className="h-7 w-20 text-[11px] text-center border-0"
                        placeholder={`Y${ri + 1}`}
                      />
                    </th>
                    {xLabels.map((_, ci) => (
                      <td key={ci} className="border border-muted p-0">
                        <HeatmapCell
                          value={matrix[ri]?.[ci]}
                          onChange={(v) => setCell(ri, ci, v)}
                          onMultiPaste={(text) => pasteAt(ri, ci, text)}
                        />
                      </td>
                    ))}
                    <td className="border border-muted text-center w-7">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive"
                        disabled={yLabels.length <= 1}
                        onClick={() => removeRow(ri)}
                        title="행 삭제"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={xLabels.length + 2} className="text-center pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addRow}>
                      <Plus className="h-3 w-3 mr-1" /> 행 추가
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {capPos === 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patch({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch })}
        />
      )}
    </div>
  )
}

/** Cell input with multi-cell paste detection. Same pattern the
 *  scatter widgets use — single-cell paste falls through to the
 *  browser, TSV (tab / newline) paste is forwarded to the host. */
function HeatmapCell({ value, onChange, onMultiPaste }) {
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
// Plotly canvas                                                                 //
// --------------------------------------------------------------------------- //

function HeatmapCanvas({
  xLabels,
  yLabels,
  matrix,
  colorscale = 'Viridis',
  reverseScale = false,
  zMin,
  zMax,
  xAxisTitle,
  yAxisTitle,
  showValues = false,
  autoFit = true,
}) {
  const containerRef = useRef(null)
  // Same sizing model as the scatter / 3D widgets — autoFit=true →
  // square (clientWidth → height), autoFit=false → fill parent.
  // Plus a `resizing` flag to skip Plotly.react while size is in
  // flight (matches Chart's behavior — RGL drag fires ResizeObserver
  // many times per second, expensive to repaint on each tick).
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
    // Suspend Plotly.react during an active resize burst. The effect
    // re-fires once `resizing` flips back to false with the latest
    // size — one repaint per drag instead of many.
    if (resizing) return undefined
    const trace = {
      type: 'heatmap',
      x: xLabels,
      y: yLabels,
      z: matrix,
      colorscale,
      reversescale: !!reverseScale,
      zmin: Number.isFinite(zMin) ? zMin : undefined,
      zmax: Number.isFinite(zMax) ? zMax : undefined,
      hoverongaps: false,
      showscale: true,
      colorbar: { thickness: 12, len: 0.8 },
      // Plotly's `texttemplate` paints each cell's value over its
      // color — useful for sparse / wide-domain matrices where the
      // color alone is hard to read precisely.
      ...(showValues
        ? {
            text: matrix.map((row) =>
              row.map((v) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(2))),
            ),
            texttemplate: '%{text}',
            textfont: { size: 10 },
          }
        : {}),
    }
    const layout = {
      autosize: true,
      margin: { l: 60, r: 24, t: 8, b: 40 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      xaxis: {
        title: xAxisTitle ? { text: xAxisTitle, font: { size: 12 } } : undefined,
        side: 'bottom',
        tickfont: { size: 11 },
      },
      yaxis: {
        title: yAxisTitle ? { text: yAxisTitle, font: { size: 12 } } : undefined,
        // Reverse so y_labels[0] sits at the top — the natural reading
        // order for tables / spreadsheets.
        autorange: 'reversed',
        tickfont: { size: 11 },
      },
    }
    const config = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['sendDataToCloud'] }
    Plotly.react(el, [trace], layout, config)
    return undefined
  }, [
    xLabels,
    yLabels,
    matrix,
    colorscale,
    reverseScale,
    zMin,
    zMax,
    xAxisTitle,
    yAxisTitle,
    showValues,
    size,
    resizing,
  ])

  // Release WebGL / canvas resources on unmount.
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
        // Drop the plot during cell drag — Plotly's heatmap re-paint is
        // heavy enough that keeping it visible visibly stutters under
        // RGL's per-frame resize events. Same trade-off Chart / Contour
        // make.
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
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Reshape a matrix to fit (rows × cols), padding with nulls and
 *  trimming overflow. Falls back to the supplied `fallback` matrix
 *  when the incoming value isn't a 2-D array at all. */
function normalizeMatrix(raw, rows, cols, fallback) {
  if (!Array.isArray(raw)) {
    // Clone the fallback so callers can mutate it safely.
    return fallback.map((row) => row.slice())
  }
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
