/**
 * Waffle chart widget.
 *
 * A `cols × rows` grid of cells (default 10×10 = 100 cells, 1%/cell)
 * where each cell is colored by group. The chart reads as a pie that's
 * been unrolled into a percentage grid — every 1% is the same shape,
 * which makes comparing small shares much easier than a pie.
 *
 * Allocation uses the **largest-remainder method** so cell totals
 * always sum exactly to `cols × rows` — no rounding drift even on
 * lopsided data like `[33.3, 33.3, 33.4]`. We render directly to SVG
 * (Plotly has no native waffle trace).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  CaptionInput,
  DataTableActions,
  LabelField,
  PreviewLabel,
  captionSkipProps,
  captionPositionOf,
  toTsv,
} from './_shared'

const SHAPE_OPTIONS = [
  { value: 'square', label: '사각형' },
  { value: 'circle', label: '원' },
]

const FILL_OPTIONS = [
  { value: 'column', label: '아래→위 / 왼→오 (기본)' },
  { value: 'row', label: '왼→오 / 위→아래' },
]

const WAFFLE_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

// Default starter — a single placeholder so a fresh widget has an
// editable row without preloading demo data. "비우기" resets back to
// the same row.
const DEFAULT_ROWS = [{ label: 'Sample', value: 100 }]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function WafflePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="시장 점유율"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function WafflePreview({ props }) {
  // Mini 5×4 grid sketch — A=8 cells, B=6, C=4, D=2.
  const cells = []
  const palette = ['#6366f1', '#10b981', '#f59e0b', '#ef4444']
  const counts = [8, 6, 4, 2]
  let idx = 0
  for (let gi = 0; gi < counts.length; gi += 1) {
    for (let k = 0; k < counts[gi]; k += 1) {
      cells.push(palette[gi])
      idx += 1
    }
  }
  return (
    <div className="space-y-2">
      <PreviewLabel hint="와플 차트">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 25 20" className="w-16 h-14">
          {cells.map((c, i) => {
            const col = i % 5
            const row = Math.floor(i / 5)
            return (
              <rect
                key={i}
                x={col * 5 + 0.4}
                y={row * 5 + 0.4}
                width={4.2}
                height={4.2}
                rx={0.6}
                fill={c}
              />
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

export function WaffleEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const rows = useMemo(
    () =>
      Array.isArray(content?.rows) && content.rows.length > 0
        ? content.rows
        : DEFAULT_ROWS,
    [content?.rows],
  )
  const cols = Number.isFinite(content?.cols) ? Math.max(1, Math.min(50, content.cols)) : 10
  const gridRows = Number.isFinite(content?.grid_rows)
    ? Math.max(1, Math.min(50, content.grid_rows))
    : 10
  const shape = content?.shape === 'circle' ? 'circle' : 'square'
  const fillDirection = content?.fill_direction === 'row' ? 'row' : 'column'
  const showLegend = content?.show_legend !== false // default true
  const showValuePerCell = !!content?.show_value_per_cell
  const unit = content?.unit ?? ''

  function patch(next) {
    const merged = { ...(content ?? {}), rows, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.unit) delete merged.unit
    if (merged.cols == null || merged.cols === 10) delete merged.cols
    if (merged.grid_rows == null || merged.grid_rows === 10) delete merged.grid_rows
    if (!merged.shape || merged.shape === 'square') delete merged.shape
    if (!merged.fill_direction || merged.fill_direction === 'column') {
      delete merged.fill_direction
    }
    if (merged.show_legend === undefined || merged.show_legend === true) {
      delete merged.show_legend
    }
    if (!merged.show_value_per_cell) delete merged.show_value_per_cell
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

  const capPos = captionPositionOf(content)

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
          <WaffleCanvas
            rows={rows}
            cols={cols}
            gridRows={gridRows}
            shape={shape}
            fillDirection={fillDirection}
            showLegend={showLegend}
            showValuePerCell={showValuePerCell}
            unit={unit}
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
          <span className="text-muted-foreground">격자:</span>
          <Input
            type="number"
            min={1}
            max={50}
            value={cols}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ cols: Number.isFinite(v) ? Math.max(1, Math.min(50, v)) : 10 })
            }}
            className="h-7 w-16 text-xs"
            title="열 수 (가로 칸 수)"
          />
          <span className="text-muted-foreground">×</span>
          <Input
            type="number"
            min={1}
            max={50}
            value={gridRows}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ grid_rows: Number.isFinite(v) ? Math.max(1, Math.min(50, v)) : 10 })
            }}
            className="h-7 w-16 text-xs"
            title="행 수 (세로 칸 수)"
          />
          <span className="text-muted-foreground text-[10px]">
            ({cols * gridRows}칸)
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">모양:</span>
          <select
            value={shape}
            onChange={(e) => patch({ shape: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {SHAPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">채우기:</span>
          <select
            value={fillDirection}
            onChange={(e) => patch({ fill_direction: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {FILL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showLegend}
            onChange={(e) => patch({ show_legend: e.target.checked })}
          />
          <span className="text-muted-foreground">범례</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer" title="범례에 '1칸 = N 단위' 안내 표시">
          <input
            type="checkbox"
            checked={showValuePerCell}
            onChange={(e) => patch({ show_value_per_cell: e.target.checked })}
          />
          <span className="text-muted-foreground">셀당 값</span>
        </label>
        <div className="flex items-center gap-1" title="값 옆에 붙는 단위 (예: %, 건)">
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
          <WaffleCanvas
            rows={rows}
            cols={cols}
            gridRows={gridRows}
            shape={shape}
            fillDirection={fillDirection}
            showLegend={showLegend}
            showValuePerCell={showValuePerCell}
            unit={unit}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="와플 데이터"
              onCopy={() => {
                const header = ['label', 'value', 'color']
                const body = rows.map((r) => [
                  r?.label ?? '',
                  r?.value ?? '',
                  r?.color ?? '',
                ])
                return toTsv([header, ...body])
              }}
              onClear={() =>
                patch({ rows: [{ label: 'Sample', value: 100 }] })
              }
            />
          </div>
          <WaffleRowsTable
            rows={rows}
            onCellChange={setCell}
            onAdd={addRow}
            onRemove={removeRow}
            onMultiPaste={pasteAtTable}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            값은 절대 수치 또는 %. 자동으로 합계 대비 비율을 계산해서 격자 셀에 배정합니다. row 순서대로 채워지며 color 는 hex/CSS (선택).
          </p>
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

function WaffleRowsTable({ rows, onCellChange, onAdd, onRemove, onMultiPaste }) {
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
// Cell allocation (largest-remainder method)                                   //
// --------------------------------------------------------------------------- //

/**
 * Distribute `total` cells across groups whose raw values are
 * `values[]`. Returns an integer-cell count per group that always sums
 * to exactly `total` — Hamilton / largest-remainder method.
 *
 * Why this method: naive rounding (`round(v/sum * total)`) lets the
 * cell total drift above/below `total` whenever the fractional parts
 * don't add up to a clean integer. Largest-remainder is the standard
 * fix and is what most waffle-chart libraries use under the hood.
 */
function allocateCells(values, total) {
  const sum = values.reduce((acc, v) => acc + v, 0)
  if (!Number.isFinite(sum) || sum <= 0) {
    return values.map(() => 0)
  }
  const exact = values.map((v) => (v / sum) * total)
  const floors = exact.map((x) => Math.floor(x))
  const remainders = exact.map((x, i) => ({ i, frac: x - floors[i] }))
  let assigned = floors.reduce((acc, x) => acc + x, 0)
  // Distribute the leftover cells to the groups with the biggest
  // fractional remainders (Hamilton's method, exactly).
  let leftover = total - assigned
  remainders.sort((a, b) => b.frac - a.frac)
  const out = [...floors]
  for (const r of remainders) {
    if (leftover <= 0) break
    out[r.i] += 1
    leftover -= 1
  }
  return out
}

// --------------------------------------------------------------------------- //
// Canvas                                                                        //
// --------------------------------------------------------------------------- //

function WaffleCanvas({
  rows,
  cols = 10,
  gridRows = 10,
  shape = 'square',
  fillDirection = 'column',
  showLegend = true,
  showValuePerCell = false,
  unit = '',
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // Measure the cell so the SVG packing can fill it. autoFit makes
  // the chart area square (height tracks width); the legend lives
  // below in a fixed strip so the grid itself stays clean.
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

  const totalCells = Math.max(1, cols * gridRows)
  const counts = useMemo(
    () => allocateCells(safeRows.map((r) => r.value), totalCells),
    [safeRows, totalCells],
  )
  const totalValue = safeRows.reduce((acc, r) => acc + r.value, 0)
  // 1 cell = totalValue / totalCells units — handy for "셀당 값" labels.
  const valuePerCell = totalValue / totalCells

  // Color per group — author override wins, else palette.
  const colorOf = useMemo(
    () =>
      safeRows.map(
        (r, i) => r.color || WAFFLE_PALETTE[i % WAFFLE_PALETTE.length],
      ),
    [safeRows],
  )

  // Flatten the allocation into a per-cell { groupIdx } array in the
  // chosen fill order.
  const cellAssignment = useMemo(() => {
    const out = new Array(totalCells).fill(-1)
    let pos = 0
    counts.forEach((count, gi) => {
      for (let k = 0; k < count; k += 1) {
        if (pos < totalCells) out[pos++] = gi
      }
    })
    return out
  }, [counts, totalCells])

  // Convert a sequential index 0..totalCells-1 into (col, row) coords
  // based on the chosen fill direction.
  function cellCoord(idx) {
    if (fillDirection === 'column') {
      // Fill bottom-up, then move right one column. col-major with
      // y inverted so cells stack like a bar.
      const col = Math.floor(idx / gridRows)
      const rowFromBottom = idx % gridRows
      const row = gridRows - 1 - rowFromBottom
      return { col, row }
    }
    // 'row' — left-to-right, top-to-bottom.
    return { col: idx % cols, row: Math.floor(idx / cols) }
  }

  // Layout — reserve a fixed legend strip at the bottom (or hide).
  const legendH = showLegend ? 28 + Math.ceil(safeRows.length / 4) * 18 : 0
  const gridW = Math.max(40, size.w - 16)
  const gridH = Math.max(40, size.h - legendH - 16)
  // Each cell is the largest square that fits both axes; the grid is
  // centered in the available area so non-square grids don't stretch.
  const cellSide = Math.max(
    2,
    Math.min(gridW / cols, gridH / gridRows),
  )
  const gridDrawW = cellSide * cols
  const gridDrawH = cellSide * gridRows
  const gridX = (size.w - gridDrawW) / 2
  const gridY = (gridH - gridDrawH) / 2 + 8 // small top padding
  const cellPad = Math.max(1, cellSide * 0.1)

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
      {size.w > 0 && size.h > 0 && safeRows.length > 0 ? (
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          style={{ display: 'block' }}
        >
          {cellAssignment.map((gi, idx) => {
            const { col, row } = cellCoord(idx)
            const x = gridX + col * cellSide + cellPad / 2
            const y = gridY + row * cellSide + cellPad / 2
            const w = cellSide - cellPad
            // Empty cell (gi === -1) just means the data didn't fill
            // the grid — render as a faint placeholder so authors see
            // the full available area.
            const fill = gi >= 0 ? colorOf[gi] : '#e2e8f0'
            const opacity = gi >= 0 ? 0.95 : 0.4
            const common = {
              fill,
              fillOpacity: opacity,
              onMouseEnter: (e) => {
                if (gi < 0) return
                const r = safeRows[gi]
                const pct = totalValue > 0 ? (r.value / totalValue) * 100 : 0
                // 컨테이너 기준 로컬 좌표. fixed + clientX/Y 조합이
                // 부모 chain 의 CSS transform (react-grid-layout 의
                // grid item) 안에선 viewport 가 아닌 transformed box
                // 기준으로 잡혀 엉뚱한 위치로 튀어 나오던 문제 해결.
                const box = containerRef.current?.getBoundingClientRect()
                const localX = box ? e.clientX - box.left : e.clientX
                const localY = box ? e.clientY - box.top : e.clientY
                setHover({
                  x: localX,
                  y: localY,
                  label: r.label,
                  value: r.value,
                  pct,
                  cells: counts[gi],
                })
              },
              onMouseMove: (e) => {
                const box = containerRef.current?.getBoundingClientRect()
                const localX = box ? e.clientX - box.left : e.clientX
                const localY = box ? e.clientY - box.top : e.clientY
                setHover((h) => (h ? { ...h, x: localX, y: localY } : h))
              },
              onMouseLeave: () => setHover(null),
            }
            if (shape === 'circle') {
              return (
                <circle
                  key={idx}
                  cx={x + w / 2}
                  cy={y + w / 2}
                  r={w / 2}
                  {...common}
                />
              )
            }
            return (
              <rect
                key={idx}
                x={x}
                y={y}
                width={w}
                height={w}
                rx={Math.max(1, w * 0.12)}
                {...common}
              />
            )
          })}

          {/* Legend strip */}
          {showLegend && safeRows.length > 0 && (
            <g transform={`translate(8, ${size.h - legendH + 4})`}>
              {showValuePerCell && (
                <text
                  x={0}
                  y={10}
                  fontSize={10}
                  fill="#64748b"
                >
                  1칸 ≈ {formatNum(valuePerCell)}
                  {unit ? ` ${unit}` : ''}
                </text>
              )}
              {safeRows.map((r, i) => {
                // 4 chips per row in the legend strip.
                const col = i % 4
                const row = Math.floor(i / 4)
                const offsetY = (showValuePerCell ? 16 : 0) + row * 18
                const offsetX = col * Math.max(120, (size.w - 16) / 4)
                const pct = totalValue > 0 ? (r.value / totalValue) * 100 : 0
                return (
                  <g
                    key={i}
                    transform={`translate(${offsetX}, ${offsetY})`}
                  >
                    <rect
                      x={0}
                      y={0}
                      width={11}
                      height={11}
                      rx={2}
                      fill={colorOf[i]}
                    />
                    <text
                      x={16}
                      y={9.5}
                      fontSize={11}
                      fill="#1e293b"
                    >
                      {r.label} ({pct.toFixed(1)}%)
                    </text>
                  </g>
                )
              })}
            </g>
          )}
        </svg>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          데이터를 입력하면 와플 차트가 표시됩니다
        </div>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute z-50 rounded-md px-2 py-1.5 text-[11px] shadow-lg"
          style={{
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
          <div>비중: {hover.pct.toFixed(1)}%</div>
          <div>
            셀: {hover.cells} / {totalCells}
          </div>
        </div>
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

function formatNum(n) {
  if (n == null || !Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}억`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`
  if (abs % 1 === 0) return n.toLocaleString()
  return parseFloat(n.toFixed(1)).toLocaleString()
}
