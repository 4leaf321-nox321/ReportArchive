/**
 * Contour widget — 2D iso-value plot.
 *
 * Data model intentionally mirrors `heatmap` (positional x_labels /
 * y_labels / matrix[row][col]) so users who already work with the
 * heatmap editor don't relearn the grid layout. The difference is the
 * Plotly render: instead of coloring every cell, we paint iso-curves
 * across the field. A few contour-specific knobs (level count, fill
 * mode, label visibility) sit alongside the heatmap-shared ones.
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

const COLORING_OPTIONS = [
  { value: 'fill', label: '채우기 + 등고선' },
  { value: 'heatmap', label: '히트맵 (선 없음)' },
  { value: 'lines', label: '등고선만' },
  { value: 'none', label: '단순 채우기' },
]

// 3×3 zero-matrix starter — matches heatmap's "empty grid" convention.
// Plotly won't actually draw contour curves on a flat surface, so the
// plot area shows just the axes until the user puts real values in.
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

export function ContourPropsPanel({ props, onChange }) {
  function patch(next) {
    onChange({ ...props, ...next })
  }
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="응답면"
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

export function ContourPreview({ props }) {
  // Concentric ellipses as a hint that this is an iso-value plot.
  return (
    <div className="space-y-2">
      <PreviewLabel hint="등고선">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 100 60" className="w-24 h-14">
          {[18, 26, 34, 42, 50].map((rx, i) => (
            <ellipse
              key={i}
              cx={50}
              cy={30}
              rx={rx}
              ry={rx * 0.55}
              fill="none"
              stroke={`hsl(${210 + i * 25} 60% ${50 - i * 4}%)`}
              strokeWidth={1}
            />
          ))}
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function ContourEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  // Input mode — 'matrix' (default, legacy) or 'rows' (long-form
  // x/y/z table). Stored on content so a single template can host
  // both styles depending on what the report author has in hand.
  const mode = content?.mode === 'rows' ? 'rows' : 'matrix'
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
  const xyzRows = useMemo(
    () => (Array.isArray(content?.rows) ? content.rows : []),
    [content?.rows],
  )
  // What the Canvas actually draws — for rows mode we pivot
  // (x, y, z) samples into a sparse matrix on the union of unique x's
  // and y's so the same Plotly contour trace can render either input
  // model. Cells with no matching sample stay null.
  const rendered = useMemo(() => {
    if (mode !== 'rows') {
      return { xLabels, yLabels, matrix }
    }
    return rowsToMatrix(xyzRows)
  }, [mode, xLabels, yLabels, matrix, xyzRows])
  const colorscale = content?.colorscale ?? 'Viridis'
  const reverseScale = content?.reverse_scale ?? false
  const xAxisTitle = content?.x_axis_title ?? props?.x_axis_title ?? ''
  const yAxisTitle = content?.y_axis_title ?? props?.y_axis_title ?? ''
  const ncontours = content?.ncontours ?? 15
  const coloring = content?.contours_coloring ?? 'fill'
  const showLines = content?.show_lines ?? true
  const showLabels = content?.show_labels ?? false
  // Bridge null / sparse cells by carrying neighbor values across the
  // gap (Plotly's `connectgaps`). Default ON since the reason users
  // reach for contour is usually "show the response surface" and a
  // ragged null-checkerboard rarely matches that intent. Authors can
  // turn it off when the gaps are meaningful.
  const connectGaps = content?.connect_gaps ?? true
  const zMin = content?.z_min
  const zMax = content?.z_max

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      x_labels: xLabels,
      y_labels: yLabels,
      matrix,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.x_axis_title) delete merged.x_axis_title
    if (!merged.y_axis_title) delete merged.y_axis_title
    if (merged.colorscale === 'Viridis' || !merged.colorscale) delete merged.colorscale
    if (!merged.reverse_scale) delete merged.reverse_scale
    if (merged.mode === 'matrix' || !merged.mode) delete merged.mode
    if (Array.isArray(merged.rows) && merged.rows.length === 0) delete merged.rows
    if (merged.ncontours === 15 || merged.ncontours == null) delete merged.ncontours
    if (merged.contours_coloring === 'fill' || !merged.contours_coloring) {
      delete merged.contours_coloring
    }
    // show_lines default = true, show_labels default = false: store only
    // when divergent from those.
    if (merged.show_lines === true || merged.show_lines == null) delete merged.show_lines
    if (!merged.show_labels) delete merged.show_labels
    // connect_gaps default is true, so persist only when explicitly off.
    if (merged.connect_gaps === true || merged.connect_gaps == null) {
      delete merged.connect_gaps
    }
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
    const nextY = [...yLabels, `${yLabels.length + 1}`]
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
    const nextX = [...xLabels, `${xLabels.length + 1}`]
    const nextMatrix = matrix.map((row) => [...row, null])
    patch({ x_labels: nextX, matrix: nextMatrix })
  }
  function removeColumn(idx) {
    if (xLabels.length <= 1) return
    const nextX = xLabels.filter((_, i) => i !== idx)
    const nextMatrix = matrix.map((row) => row.filter((_, i) => i !== idx))
    patch({ x_labels: nextX, matrix: nextMatrix })
  }

  /** Same paste algorithm as the heatmap widget — single-cell pastes
   *  fall through; multi-cell pastes land at (startRow, startCol);
   *  landing on (-1, -1) AND the corner cell empty is treated as
   *  "paste with headers" (first row → x_labels, first col → y_labels). */
  function pasteAt(startRow, startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingHeight = grid.length
    const incomingWidth = Math.max(...grid.map((r) => r.length))

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
      while (nextX.length < xs.length) nextX.push(`${nextX.length + 1}`)
      for (let i = 0; i < xs.length; i += 1) {
        if (xs[i]) nextX[i] = xs[i]
      }
      const nextY = [...yLabels]
      while (nextY.length < ys.length) nextY.push(`${nextY.length + 1}`)
      for (let i = 0; i < ys.length; i += 1) {
        if (ys[i]) nextY[i] = ys[i]
      }
      const nextMatrix = matrix.map((r) => r.slice())
      while (nextMatrix.length < nextY.length) {
        nextMatrix.push(new Array(nextX.length).fill(null))
      }
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

    const targetRow = Math.max(0, startRow)
    const targetCol = Math.max(0, startCol)
    const needRows = targetRow + incomingHeight
    const needCols = targetCol + incomingWidth
    const nextX = [...xLabels]
    while (nextX.length < needCols) nextX.push(`${nextX.length + 1}`)
    const nextY = [...yLabels]
    while (nextY.length < needRows) nextY.push(`${nextY.length + 1}`)
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

  function pasteHeader(axis, startIdx, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const cells = axis === 'x' ? grid[0] : grid.map((row) => row[0] ?? '')
    if (axis === 'x') {
      const nextX = [...xLabels]
      while (nextX.length < startIdx + cells.length) {
        nextX.push(`${nextX.length + 1}`)
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
        nextY.push(`${nextY.length + 1}`)
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

  // ─── rows-mode helpers ──────────────────────────────────────────
  function setXyzCell(idx, field, value) {
    const next = xyzRows.map((r, i) => {
      if (i !== idx) return r
      const n = value === '' || value == null ? null : Number(value)
      return { ...r, [field]: Number.isFinite(n) ? n : null }
    })
    patch({ rows: next })
  }
  function addXyzRow() {
    patch({ rows: [...xyzRows, { x: null, y: null, z: null }] })
  }
  function removeXyzRow(idx) {
    patch({ rows: xyzRows.filter((_, i) => i !== idx) })
  }
  /** Multi-cell paste landing inside the rows table. Coordinates:
   *  `startRowIdx` = the row whose cell received the paste.
   *  `startField` ∈ { 'x', 'y', 'z' } = the column.
   *
   *  Rules — mirroring the matrix-mode paste handlers:
   *    - First TSV row is dropped if it looks like an `x` / `y` / `z`
   *      header (Excel "copy with headers" pattern).
   *    - Each subsequent TSV row fills one xyz row from `startField`
   *      onward; extra columns past `z` are silently ignored so a 4-col
   *      paste doesn't corrupt anything.
   *    - Existing rows past `startRowIdx + paste.length` are kept.
   *    - The rows array auto-extends when the paste exceeds the
   *      current row count.
   */
  function pasteAtXyz(startRowIdx, startField, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    let body = grid
    const firstNormalized = (grid[0] || []).map((s) =>
      String(s ?? '').trim().toLowerCase(),
    )
    const headerHit = firstNormalized.some(
      (s) => s === 'x' || s === 'y' || s === 'z',
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['x', 'y', 'z']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...xyzRows]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ x: null, y: null, z: null })
    }
    for (let r = 0; r < body.length; r += 1) {
      const targetRow = { ...(nextRows[startRowIdx + r] ?? { x: null, y: null, z: null }) }
      for (let c = 0; c < body[r].length; c += 1) {
        const fieldIdx = startFieldIdx + c
        if (fieldIdx >= 3) break
        const field = fieldOrder[fieldIdx]
        targetRow[field] = coerceNumOrNull(body[r][c])
      }
      nextRows[startRowIdx + r] = targetRow
    }
    patch({ rows: nextRows })
  }
  function setMode(nextMode) {
    if (nextMode === mode) return
    patch({ mode: nextMode })
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
          <ContourCanvas
            xLabels={rendered.xLabels}
            yLabels={rendered.yLabels}
            matrix={rendered.matrix}
            colorscale={colorscale}
            reverseScale={reverseScale}
            zMin={zMin}
            zMax={zMax}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            ncontours={ncontours}
            coloring={coloring}
            showLines={showLines}
            showLabels={showLabels}
            connectGaps={connectGaps}
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
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">등고선 수:</span>
          <Input
            type="number"
            min={2}
            max={100}
            value={ncontours}
            onChange={(e) => {
              const n = Number(e.target.value)
              patch({ ncontours: Number.isFinite(n) ? n : 15 })
            }}
            className="h-7 w-16 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">채우기:</span>
          <select
            value={coloring}
            onChange={(e) => patch({ contours_coloring: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {COLORING_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showLines}
            onChange={(e) => patch({ show_lines: e.target.checked })}
          />
          <span className="text-muted-foreground">등고선 표시</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => patch({ show_labels: e.target.checked })}
          />
          <span className="text-muted-foreground">값 라벨</span>
        </label>
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="빈 셀(또는 흩어진 데이터)을 인접 값으로 메워 등고선이 끊기지 않게 그립니다"
        >
          <input
            type="checkbox"
            checked={connectGaps}
            onChange={(e) => patch({ connect_gaps: e.target.checked })}
          />
          <span className="text-muted-foreground">빈 영역 보간</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>색 범위 (선택):</span>
        <AxisRangeInput label="z min" value={zMin} onChange={(v) => patch({ z_min: v })} />
        <AxisRangeInput label="z max" value={zMax} onChange={(v) => patch({ z_max: v })} />
        <span className="text-[10px]">미설정 시 데이터 범위로 자동 맞춤</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          <ContourCanvas
            xLabels={rendered.xLabels}
            yLabels={rendered.yLabels}
            matrix={rendered.matrix}
            colorscale={colorscale}
            reverseScale={reverseScale}
            zMin={zMin}
            zMax={zMax}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            ncontours={ncontours}
            coloring={coloring}
            showLines={showLines}
            showLabels={showLabels}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="text-xs font-semibold text-muted-foreground">데이터</div>
              <div className="inline-flex rounded-md border bg-muted/30 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setMode('matrix')}
                  className={`px-2 py-0.5 rounded ${mode === 'matrix' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  title="x_labels / y_labels 의 교차점을 직접 입력"
                >
                  그리드
                </button>
                <button
                  type="button"
                  onClick={() => setMode('rows')}
                  className={`px-2 py-0.5 rounded ${mode === 'rows' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  title="x · y · z 세 열로 점 단위 입력 — DOE / 측정 데이터 등"
                >
                  x · y · z 행
                </button>
              </div>
            </div>
            {mode === 'matrix' ? (
              <DataTableActions
                label="등고선 데이터"
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
            ) : (
              <DataTableActions
                label="등고선 데이터 (x · y · z)"
                onCopy={() => {
                  const header = ['x', 'y', 'z']
                  const body = xyzRows.map((r) => [r?.x ?? '', r?.y ?? '', r?.z ?? ''])
                  return toTsv([header, ...body])
                }}
                onClear={() => patch({ rows: [] })}
              />
            )}
          </div>
          {mode === 'rows' ? (
            <XyzRowsTable
              rows={xyzRows}
              onCellChange={setXyzCell}
              onAdd={addXyzRow}
              onRemove={removeXyzRow}
              onMultiPaste={pasteAtXyz}
            />
          ) : (
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
                {yLabels.map((yLabel, ri) => (
                  <tr key={ri}>
                    <th className="border border-muted bg-muted/30 p-0">
                      <Input
                        value={yLabel ?? ''}
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
                        <ContourCell
                          value={matrix[ri]?.[ci]}
                          onChange={(v) => setCell(ri, ci, v)}
                          onMultiPaste={(text) => pasteAt(ri, ci, text)}
                        />
                      </td>
                    ))}
                    <td className="text-center">
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
          )}
        </div>
      </div>
    </div>
  )
}

// Single numeric cell — same paste-detection trick as the heatmap cell.
// 3-column (x / y / z) input table for the rows input mode. Each row
// is a single sample; the renderer pivots the union of unique x/y
// values into a sparse matrix (see rowsToMatrix below). Empty cells
// stay null — the renderer just skips them.
function XyzRowsTable({ rows, onCellChange, onAdd, onRemove, onMultiPaste }) {
  function handlePaste(e, ri, field) {
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    // Single-cell paste falls through to normal Input editing — only
    // intercept when the clipboard actually carries a TSV/CSV grid.
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onMultiPaste?.(ri, field, text)
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">x</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">y</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">z</th>
            <th className="border border-muted bg-muted/30 w-7" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {['x', 'y', 'z'].map((f) => (
                <td key={f} className="border border-muted p-0">
                  <Input
                    type="number"
                    value={row?.[f] === null || row?.[f] === undefined ? '' : row[f]}
                    onChange={(e) => onCellChange(ri, f, e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, f)}
                    className="h-7 w-full text-[11px] text-center border-0"
                  />
                </td>
              ))}
              <td className="text-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive"
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
      {rows.length === 0 ? (
        <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
          행을 추가해서 x · y · z 값을 입력하세요. 클립보드의 TSV(엑셀 셀 복사)도 그대로 붙여넣기 가능합니다.
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
          엑셀/시트에서 x · y · z 열을 복사해 셀에 붙여넣으면 여러 행이 한 번에 채워집니다. 첫 행이 "x", "y", "z" 헤더면 자동으로 건너뜁니다.
        </p>
      )}
    </div>
  )
}

function ContourCell({ value, onChange, onMultiPaste }) {
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
      value={value === null || value === undefined ? '' : value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={handlePaste}
      className="h-7 w-20 text-[11px] text-center border-0"
    />
  )
}

// --------------------------------------------------------------------------- //
// Canvas                                                                        //
// --------------------------------------------------------------------------- //

function ContourCanvas({
  xLabels,
  yLabels,
  matrix,
  colorscale = 'Viridis',
  reverseScale = false,
  zMin,
  zMax,
  xAxisTitle,
  yAxisTitle,
  ncontours = 15,
  coloring = 'fill',
  showLines = true,
  showLabels = false,
  connectGaps = true,
  autoFit = true,
}) {
  const containerRef = useRef(null)
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

  // Plotly's contour algorithm crashes on a flat surface — either
  // every cell identical (no gradient → makeCrossings blows up on
  // undefined neighbor) or no finite cells at all. We detect that
  // here and feed an empty data array to Plotly instead so the user
  // sees the axes but no curves until they put real data in.
  const flatOrEmpty = useMemo(() => {
    let first = null
    let allSame = true
    let anyFinite = false
    for (const row of matrix) {
      if (!Array.isArray(row)) continue
      for (const v of row) {
        if (Number.isFinite(v)) {
          anyFinite = true
          if (first === null) first = v
          else if (v !== first) allSame = false
        }
      }
    }
    return !anyFinite || allSame
  }, [matrix])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !size) return undefined
    if (resizing) return undefined
    const trace = {
      type: 'contour',
      x: xLabels,
      y: yLabels,
      z: matrix,
      colorscale,
      reversescale: !!reverseScale,
      zmin: Number.isFinite(zMin) ? zMin : undefined,
      zmax: Number.isFinite(zMax) ? zMax : undefined,
      ncontours,
      contours: {
        coloring,
        showlines: !!showLines,
        showlabels: !!showLabels,
        ...(showLabels ? { labelfont: { size: 10 } } : {}),
      },
      showscale: true,
      colorbar: { thickness: 12, len: 0.8 },
      hoverongaps: false,
      // Carry neighbor values across null cells so a ragged grid still
      // draws a continuous response surface (rows-mode DOE data with
      // missing samples, sparse matrix-mode entries). Off-by-default
      // would force the author to know about this knob; on-by-default
      // matches the "show the response surface" intent.
      connectgaps: !!connectGaps,
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
        // y axis NOT reversed — contour conventions in engineering (and
        // Plotly examples) put low y at the bottom. Heatmap reads more
        // naturally with table-orientation; contour reads more naturally
        // as a math plot.
        tickfont: { size: 11 },
      },
    }
    const config = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['sendDataToCloud'],
    }
    Plotly.react(el, flatOrEmpty ? [] : [trace], layout, config)
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
    ncontours,
    coloring,
    showLines,
    showLabels,
    connectGaps,
    size,
    resizing,
    flatOrEmpty,
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
        // While the cell is being dragged we drop the plot entirely and
        // show a one-line placeholder — Plotly's contour re-paint cost
        // is high enough that keeping it visible during drag visibly
        // stutters (same trade-off Chart.jsx makes; heatmap leaves it
        // visible but contour is more expensive per repaint).
        <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground bg-muted/20 rounded-md">
          크기 조정 중…
        </div>
      ) : (
        <>
          <div ref={containerRef} className="absolute inset-0" />
          {flatOrEmpty && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-center text-[11px] text-muted-foreground bg-background/50 pointer-events-none">
              <div>
                등고선을 그리려면 셀에 변화 있는 값을 입력하세요
                <br />
                <span className="text-[10px]">
                  (모든 셀 값이 같거나 비어 있으면 표시할 등고선이 없음)
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Helpers (same shape as Heatmap.jsx — kept local rather than promoted to     //
// _shared because the contour/heatmap pair are the only consumers and the    //
// matrix normalization rules might diverge if either widget grows special    //
// behavior.)                                                                  //
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

/** Pivot a long-form list of `{x, y, z}` samples into the same
 *  `{ xLabels, yLabels, matrix }` shape the matrix-mode editor produces,
 *  so a single Plotly contour trace can render either input model.
 *
 *  Strategy:
 *    1. Drop rows missing any of x / y / z (or with non-numeric values).
 *    2. Take the union of unique x's and unique y's, numerically sorted,
 *       as the axes.
 *    3. For each sample, write `z` into the (yIdx, xIdx) cell. Duplicate
 *       (x, y) pairs are last-write-wins — the table UI already lets
 *       authors fix that by removing the earlier duplicate.
 *    4. Cells without a matching sample stay `null`. The contour
 *       algorithm tolerates null gaps; densely sampled grids contour
 *       cleanly, sparse ones may show truncated curves (the natural
 *       behavior of an incomplete field).
 */
function rowsToMatrix(rows) {
  const validRows = (Array.isArray(rows) ? rows : []).filter(
    (r) =>
      r != null &&
      Number.isFinite(r.x) &&
      Number.isFinite(r.y) &&
      Number.isFinite(r.z),
  )
  if (validRows.length === 0) {
    return { xLabels: [], yLabels: [], matrix: [] }
  }
  const xs = [...new Set(validRows.map((r) => r.x))].sort((a, b) => a - b)
  const ys = [...new Set(validRows.map((r) => r.y))].sort((a, b) => a - b)
  const xIdx = new Map(xs.map((v, i) => [v, i]))
  const yIdx = new Map(ys.map((v, i) => [v, i]))
  const matrix = ys.map(() => new Array(xs.length).fill(null))
  for (const r of validRows) {
    const i = yIdx.get(r.y)
    const j = xIdx.get(r.x)
    if (i != null && j != null) matrix[i][j] = r.z
  }
  return {
    xLabels: xs.map((v) => String(v)),
    yLabels: ys.map((v) => String(v)),
    matrix,
  }
}

function normalizeMatrix(raw, rows, cols, fallback) {
  if (!Array.isArray(raw) || raw.length === 0) return fallback
  // Clamp to (rows × cols), filling missing cells with null. Tolerates
  // pasted grids that are slightly off-shape from the labels.
  const out = []
  for (let r = 0; r < rows; r += 1) {
    const srcRow = Array.isArray(raw[r]) ? raw[r] : []
    const row = []
    for (let c = 0; c < cols; c += 1) {
      const v = srcRow[c]
      row.push(typeof v === 'number' && Number.isFinite(v) ? v : v == null ? null : null)
    }
    out.push(row)
  }
  return out
}
