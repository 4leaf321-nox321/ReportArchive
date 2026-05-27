/**
 * Density widget — overlaid 1D KDE curves per group.
 *
 * Each group is a flat array of measurements. A Gaussian KDE is computed
 * client-side (Silverman's rule by default; manual override available)
 * and the curves are rendered on a shared x-axis via Plotly so writers
 * can compare distribution shape across time or A/B groups at a glance.
 *
 * Optional raw-data marks: `rug` draws short ticks at y=0, `jitter`
 * scatters dots in a small band just under the baseline. Both keep the
 * curves themselves untouched.
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

const BANDWIDTH_OPTIONS = [
  { value: 'auto', label: '자동 (Silverman)' },
  { value: 'manual', label: '수동' },
]

const DOT_OPTIONS = [
  { value: 'none', label: '없음' },
  { value: 'rug', label: 'rug (눈금)' },
  { value: 'jitter', label: 'jitter (점)' },
]

const DENSITY_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

// Default seed — single placeholder group with a few values so a fresh
// widget renders something instead of an empty canvas.
const DEFAULT_GROUPS = [
  { name: '그룹 A', color: DENSITY_PALETTE[0], values: [1, 2, 2, 3, 3, 3, 4, 4, 5] },
]

const DEFAULT_SAMPLES = 192

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function DensityPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="밀도 곡선"
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

export function DensityPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="밀도 곡선">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 80 40" className="w-28 h-16">
          {/* Two overlapping bell curves */}
          <path
            d="M2,36 C12,36 16,8 28,8 C40,8 44,36 54,36 L54,36 L2,36 Z"
            fill="#6366f1"
            fillOpacity="0.18"
            stroke="#6366f1"
            strokeWidth="0.8"
          />
          <path
            d="M22,36 C32,36 38,12 50,12 C62,12 66,36 78,36 L78,36 L22,36 Z"
            fill="#10b981"
            fillOpacity="0.18"
            stroke="#10b981"
            strokeWidth="0.8"
          />
          {/* baseline + a few rug ticks */}
          <line x1="2" y1="36" x2="78" y2="36" stroke="#9ca3af" strokeWidth="0.4" />
          {[8, 14, 22, 28, 36, 44, 52, 58, 66].map((x, i) => (
            <line
              key={i}
              x1={x}
              y1="36"
              x2={x}
              y2="38.5"
              stroke={i % 2 === 0 ? '#6366f1' : '#10b981'}
              strokeWidth="0.5"
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

export function DensityEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const groups = useMemo(
    () =>
      Array.isArray(content?.groups) && content.groups.length > 0
        ? content.groups
        : DEFAULT_GROUPS,
    [content?.groups],
  )
  const bandwidthMode = content?.bandwidth_mode === 'manual' ? 'manual' : 'auto'
  const bandwidth = Number.isFinite(content?.bandwidth) ? content.bandwidth : null
  const samples = Number.isFinite(content?.samples) ? content.samples : DEFAULT_SAMPLES
  const xMin = Number.isFinite(content?.x_min) ? content.x_min : null
  const xMax = Number.isFinite(content?.x_max) ? content.x_max : null
  const fill = content?.fill !== false  // default true
  const showDots = DOT_OPTIONS.some((o) => o.value === content?.show_dots)
    ? content.show_dots
    : 'rug'
  const dotOpacity = Number.isFinite(content?.dot_opacity) ? content.dot_opacity : 0.55
  const xAxisTitle = content?.x_axis_title ?? props?.x_axis_title ?? ''
  const yAxisTitle = content?.y_axis_title ?? props?.y_axis_title ?? ''
  const unit = content?.unit ?? ''

  function patch(next) {
    const merged = { ...(content ?? {}), groups, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.unit) delete merged.unit
    if (!merged.x_axis_title) delete merged.x_axis_title
    if (!merged.y_axis_title) delete merged.y_axis_title
    if (!merged.bandwidth_mode || merged.bandwidth_mode === 'auto') {
      delete merged.bandwidth_mode
      delete merged.bandwidth
    }
    if (merged.bandwidth_mode === 'manual'
        && (!Number.isFinite(merged.bandwidth) || merged.bandwidth <= 0)) {
      delete merged.bandwidth
    }
    if (!Number.isFinite(merged.samples) || merged.samples === DEFAULT_SAMPLES) {
      delete merged.samples
    }
    if (merged.x_min == null || !Number.isFinite(merged.x_min)) delete merged.x_min
    if (merged.x_max == null || !Number.isFinite(merged.x_max)) delete merged.x_max
    if (merged.fill !== false) delete merged.fill  // default true
    if (!merged.show_dots || merged.show_dots === 'rug') delete merged.show_dots
    if (!Number.isFinite(merged.dot_opacity) || merged.dot_opacity === 0.55) {
      delete merged.dot_opacity
    }
    if (Array.isArray(merged.groups) && merged.groups.length === 0) delete merged.groups
    onChange(merged)
  }

  function setRangeBound(which, raw) {
    if (raw === '' || raw == null) {
      patch({ [which]: null })
      return
    }
    const n = Number(raw)
    patch({ [which]: Number.isFinite(n) ? n : null })
  }

  function setGroupMeta(idx, field, value) {
    const next = groups.map((g, i) =>
      i === idx ? { ...g, [field]: value } : g,
    )
    patch({ groups: next })
  }
  function setCell(colIdx, rowIdx, raw) {
    const val = raw === '' || raw == null ? null : Number(raw)
    const finalVal = Number.isFinite(val) ? val : null
    const nextGroups = groups.map((g, i) => {
      if (i !== colIdx) return g
      const values = [...(g.values ?? [])]
      while (values.length <= rowIdx) values.push(null)
      values[rowIdx] = finalVal
      return { ...g, values }
    })
    patch({ groups: nextGroups })
  }
  function addGroup() {
    const color = DENSITY_PALETTE[groups.length % DENSITY_PALETTE.length]
    patch({ groups: [...groups, { name: '', color, values: [] }] })
  }
  function removeGroup(idx) {
    if (groups.length <= 1) return
    patch({ groups: groups.filter((_, i) => i !== idx) })
  }

  /** Wide-form TSV paste — the natural Excel-range shape: row 0 may be
   *  group-name headers (detected when every cell in row 0 is non-numeric)
   *  and each column below it is one group's values. Paste origin
   *  (startRow, startCol) lets the writer paste into any cell of the
   *  table; missing columns are auto-appended so a 5-group paste into
   *  an empty table just works.
   */
  function pasteGrid(startRow, startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    // Header detection: row 0 must have at least one non-empty cell and
    // every non-empty cell must be non-numeric (group names). Otherwise
    // treat the entire grid as value rows.
    const firstRow = grid[0] ?? []
    const firstRowCells = firstRow.map((c) => String(c ?? '').trim())
    const nonEmptyFirst = firstRowCells.filter((s) => s.length > 0)
    const allNonNumeric =
      nonEmptyFirst.length > 0
      && nonEmptyFirst.every((s) => !Number.isFinite(Number(s)))
    const hasHeader = allNonNumeric && grid.length > 1
    const headerRow = hasHeader ? firstRowCells : null
    const bodyRows = hasHeader ? grid.slice(1) : grid

    // Widen the groups array to fit the paste range. New groups get a
    // default palette color and a blank name (overwritten below if the
    // paste included a header).
    const widestRow = grid.reduce((m, r) => Math.max(m, r.length), 0)
    const neededCols = startCol + widestRow
    const nextGroups = [...groups]
    while (nextGroups.length < neededCols) {
      const i = nextGroups.length
      nextGroups.push({
        name: '',
        color: DENSITY_PALETTE[i % DENSITY_PALETTE.length],
        values: [],
      })
    }
    if (headerRow) {
      for (let c = 0; c < headerRow.length; c += 1) {
        const name = headerRow[c]
        if (name) {
          nextGroups[startCol + c] = {
            ...nextGroups[startCol + c],
            name,
          }
        }
      }
    }
    // Materialize the body rows into per-column values arrays. We mutate
    // a working copy keyed by col so we don't rebuild the array for
    // every cell.
    const workingValues = nextGroups.map((g) => [...(g.values ?? [])])
    for (let r = 0; r < bodyRows.length; r += 1) {
      const row = bodyRows[r] ?? []
      const targetRow = startRow + r
      for (let c = 0; c < row.length; c += 1) {
        const targetCol = startCol + c
        const raw = String(row[c] ?? '').trim()
        const n = raw === '' ? null : Number(raw)
        const finalVal = Number.isFinite(n) ? n : null
        const arr = workingValues[targetCol]
        while (arr.length <= targetRow) arr.push(null)
        arr[targetRow] = finalVal
      }
    }
    for (let c = 0; c < nextGroups.length; c += 1) {
      nextGroups[c] = { ...nextGroups[c], values: workingValues[c] }
    }
    patch({ groups: nextGroups })
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
          <DensityCanvas
            groups={groups}
            bandwidthMode={bandwidthMode}
            bandwidth={bandwidth}
            samples={samples}
            xMin={xMin}
            xMax={xMax}
            fill={fill}
            showDots={showDots}
            dotOpacity={dotOpacity}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
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
          <span className="text-muted-foreground">대역폭:</span>
          <select
            value={bandwidthMode}
            onChange={(e) => patch({ bandwidth_mode: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {BANDWIDTH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {bandwidthMode === 'manual' && (
            <Input
              type="number"
              step="any"
              min={0}
              value={bandwidth ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (v === '') {
                  patch({ bandwidth: null })
                  return
                }
                const n = Number(v)
                patch({ bandwidth: Number.isFinite(n) && n > 0 ? n : null })
              }}
              placeholder="h"
              className="h-7 w-16 text-xs"
              title="작을수록 뾰족 / 클수록 매끈"
            />
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">원데이터:</span>
          <select
            value={showDots}
            onChange={(e) => patch({ show_dots: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {DOT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {showDots !== 'none' && (
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={dotOpacity}
              onChange={(e) => {
                const v = Number(e.target.value)
                patch({ dot_opacity: Number.isFinite(v) ? v : 0.55 })
              }}
              className="h-7 w-16 text-xs"
              title="원데이터 점 투명도 (0=숨김, 1=불투명)"
            />
          )}
        </div>
        <div className="flex items-center gap-1" title="곡선을 면으로 채울지 여부">
          <span className="text-muted-foreground">채우기:</span>
          <input
            type="checkbox"
            checked={fill}
            onChange={(e) => patch({ fill: e.target.checked })}
            className="h-3.5 w-3.5"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">샘플 수:</span>
          <Input
            type="number"
            min={16}
            max={1024}
            step={32}
            value={samples}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({
                samples: Number.isFinite(v)
                  ? Math.max(16, Math.min(1024, Math.round(v)))
                  : DEFAULT_SAMPLES,
              })
            }}
            className="h-7 w-16 text-xs"
            title="곡선 폴리라인의 점 개수"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">X 제목:</span>
          <Input
            value={xAxisTitle}
            onChange={(e) => patch({ x_axis_title: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-24 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Y 제목:</span>
          <Input
            value={yAxisTitle}
            onChange={(e) => patch({ y_axis_title: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-24 text-xs"
          />
        </div>
        <div className="flex items-center gap-1" title="값 옆에 붙는 단위 (예: mm, kg, %)">
          <span className="text-muted-foreground">단위:</span>
          <Input
            value={unit}
            onChange={(e) => patch({ unit: e.target.value })}
            placeholder="(없음)"
            className="h-7 w-16 text-xs"
          />
        </div>
        <div className="flex items-center gap-1" title="X 축 범위. 비우면 자동.">
          <span className="text-muted-foreground">X 범위:</span>
          <Input
            type="number"
            value={xMin == null ? '' : xMin}
            onChange={(e) => setRangeBound('x_min', e.target.value)}
            placeholder="min"
            className="h-7 w-16 text-xs"
          />
          <span className="text-muted-foreground">~</span>
          <Input
            type="number"
            value={xMax == null ? '' : xMax}
            onChange={(e) => setRangeBound('x_max', e.target.value)}
            placeholder="max"
            className="h-7 w-16 text-xs"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          <DensityCanvas
            groups={groups}
            bandwidthMode={bandwidthMode}
            bandwidth={bandwidth}
            samples={samples}
            xMin={xMin}
            xMax={xMax}
            fill={fill}
            showDots={showDots}
            dotOpacity={dotOpacity}
            xAxisTitle={xAxisTitle}
            yAxisTitle={yAxisTitle}
            unit={unit}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">그룹별 값</div>
            <DataTableActions
              label="밀도 곡선 데이터"
              onCopy={() => {
                // Wide-form export — same shape the table renders, so a
                // round-trip copy/paste through Excel preserves the layout.
                const header = groups.map((g) => g.name ?? '')
                const maxLen = groups.reduce(
                  (m, g) => Math.max(m, (g.values ?? []).length),
                  0,
                )
                const body = []
                for (let r = 0; r < maxLen; r += 1) {
                  body.push(
                    groups.map((g) => {
                      const v = g.values?.[r]
                      return Number.isFinite(v) ? v : ''
                    }),
                  )
                }
                return toTsv([header, ...body])
              }}
              onClear={() =>
                patch({
                  groups: [
                    { name: '그룹 A', color: DENSITY_PALETTE[0], values: [0] },
                  ],
                })
              }
            />
          </div>
          <DensityGroupsTable
            groups={groups}
            onMetaChange={setGroupMeta}
            onCellChange={setCell}
            onAddGroup={addGroup}
            onRemoveGroup={removeGroup}
            onGridPaste={pasteGrid}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            엑셀 범위(그룹명을 1행으로, 아래는 값)를 복사해 아무 셀에나 붙여넣으면
            컬럼이 자동으로 그룹으로 잡힙니다. 헤더 없이 숫자 범위만 붙여넣어도 됩니다.
          </p>
        </div>
      </div>
    </div>
  )
}

/** Spreadsheet-style data grid — columns are groups, cells are
 *  individual values. Matches Excel's natural layout so a range copy
 *  drops straight in. Header row holds the color picker, the group
 *  name, and a delete-column button; the body has one number input per
 *  cell with a paste handler that fans TSV out across columns/rows. */
function DensityGroupsTable({
  groups,
  onMetaChange,
  onCellChange,
  onAddGroup,
  onRemoveGroup,
  onGridPaste,
}) {
  const maxValueRows = groups.reduce(
    (m, g) => Math.max(m, (g?.values ?? []).length),
    0,
  )
  // Always render an extra blank row so typing into the bottom doesn't
  // require an explicit "add row" click. Minimum 6 rows so a fresh
  // widget shows visible cells to paste into.
  const renderRows = Math.max(maxValueRows + 1, 6)

  function handlePaste(e, rowIdx, colIdx) {
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    // Single-cell paste: let the native input handler take it (no TSV
    // delimiters to fan out across columns/rows).
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onGridPaste?.(rowIdx, colIdx, text)
  }

  return (
    <div className="overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr>
            {groups.map((g, ci) => (
              <th
                key={ci}
                className="border border-muted bg-muted/30 px-1 py-1 min-w-[88px] align-top"
              >
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={normalizeColor(g?.color, ci)}
                    onChange={(e) => onMetaChange(ci, 'color', e.target.value)}
                    className="h-5 w-5 cursor-pointer rounded border border-muted-foreground/20 bg-transparent p-0"
                    title="그룹 색"
                  />
                  <Input
                    value={g?.name ?? ''}
                    onChange={(e) => onMetaChange(ci, 'name', e.target.value)}
                    onPaste={(e) => handlePaste(e, 0, ci)}
                    placeholder={`그룹 ${ci + 1}`}
                    className="h-6 flex-1 text-[11px] font-medium border-0 bg-transparent px-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 text-destructive shrink-0"
                    disabled={groups.length <= 1}
                    onClick={() => onRemoveGroup(ci)}
                    title="그룹(컬럼) 삭제"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </th>
            ))}
            <th className="border border-muted bg-muted/30 w-8 align-middle text-center">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={onAddGroup}
                title="그룹(컬럼) 추가"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: renderRows }).map((_, ri) => (
            <tr key={ri}>
              {groups.map((g, ci) => {
                const cell = g?.values?.[ri]
                const display =
                  cell === null || cell === undefined || !Number.isFinite(cell)
                    ? ''
                    : cell
                return (
                  <td key={ci} className="border border-muted p-0">
                    <Input
                      type="number"
                      value={display}
                      onChange={(e) => onCellChange(ci, ri, e.target.value)}
                      onPaste={(e) => handlePaste(e, ri, ci)}
                      className="h-7 w-full text-[11px] text-right border-0 font-mono"
                    />
                  </td>
                )
              })}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Canvas                                                                        //
// --------------------------------------------------------------------------- //

function DensityCanvas({
  groups,
  bandwidthMode = 'auto',
  bandwidth = null,
  samples = DEFAULT_SAMPLES,
  xMin = null,
  xMax = null,
  fill = true,
  showDots = 'rug',
  dotOpacity = 0.55,
  xAxisTitle = '',
  yAxisTitle = '',
  unit = '',
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState(null)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)

  // Only groups with usable values survive — KDE needs ≥ 1 finite
  // number; bandwidth math degrades to a fixed width when std=0.
  const safeGroups = useMemo(() => {
    const out = []
    for (const g of groups ?? []) {
      const name = (g?.name ?? '').toString().trim() || `(이름 없음)`
      const values = (g?.values ?? []).filter((v) => Number.isFinite(v))
      if (values.length === 0) continue
      out.push({ name, color: g?.color, values })
    }
    return out
  }, [groups])

  // Shared x-range across all groups so the curves are directly
  // comparable. Manual bounds win; auto pads ±2σ-ish for clean tails.
  const xDomain = useMemo(() => {
    if (safeGroups.length === 0) return null
    let dataMin = Infinity
    let dataMax = -Infinity
    for (const g of safeGroups) {
      for (const v of g.values) {
        if (v < dataMin) dataMin = v
        if (v > dataMax) dataMax = v
      }
    }
    if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return null
    const span = dataMax - dataMin
    const pad = span > 0 ? span * 0.15 : Math.max(Math.abs(dataMin) * 0.1, 1)
    const lo = Number.isFinite(xMin) ? xMin : dataMin - pad
    const hi = Number.isFinite(xMax) ? xMax : dataMax + pad
    if (hi <= lo) return [lo, lo + 1]
    return [lo, hi]
  }, [safeGroups, xMin, xMax])

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
    if (safeGroups.length === 0 || !xDomain) {
      Plotly.react(
        el,
        [],
        { autosize: true, margin: { l: 8, r: 8, t: 8, b: 8 } },
        { displaylogo: false },
      )
      return undefined
    }

    const u = unit ? ` ${unit}` : ''
    const xs = linspace(xDomain[0], xDomain[1], Math.max(16, Math.min(1024, samples)))
    const data = []
    let peakDensity = 0
    const computed = safeGroups.map((g, i) => {
      const color = normalizeColor(g.color, i)
      const h =
        bandwidthMode === 'manual' && Number.isFinite(bandwidth) && bandwidth > 0
          ? bandwidth
          : silvermanBandwidth(g.values)
      const ys = xs.map((x) => gaussianKde(g.values, x, h))
      for (const y of ys) {
        if (y > peakDensity) peakDensity = y
      }
      return { g, color, h, ys }
    })

    for (const { g, color, h, ys } of computed) {
      data.push({
        type: 'scatter',
        mode: 'lines',
        name: g.name,
        x: xs,
        y: ys,
        line: { color, width: 2, shape: 'spline', smoothing: 0.6 },
        fill: fill ? 'tozeroy' : 'none',
        fillcolor: fill ? toRgba(color, 0.18) : undefined,
        hovertemplate:
          `<b>${escapeHtml(g.name)}</b><br>` +
          `값: %{x:.3g}${u}<br>` +
          `밀도: %{y:.3g}<br>` +
          `n=${g.values.length}, h=${h.toPrecision(3)}<extra></extra>`,
      })
    }

    // Raw-data marks — drawn UNDER the baseline so they never sit on
    // top of the curves. The band below 0 is divided into one horizontal
    // strip per group so dots / rug ticks belonging to different groups
    // don't pile on top of each other when their x-ranges overlap.
    // Strip order matches the legend (group 0 nearest to the baseline).
    if (showDots !== 'none' && peakDensity > 0) {
      const band = peakDensity * 0.08
      const N = safeGroups.length
      // Reserve a small margin on either edge of `band` so the top strip
      // doesn't touch the baseline and the bottom doesn't sink into the
      // axis ticks. The strips evenly fill the rest.
      const yTop = -band * 0.08
      const yBot = -band * 0.95
      const stripHeight = (yBot - yTop) / Math.max(1, N)  // negative
      for (let gi = 0; gi < safeGroups.length; gi += 1) {
        const g = safeGroups[gi]
        const color = normalizeColor(g.color, gi)
        const xPoints = g.values
        // Strip bounds for this group (yHi closer to baseline, yLo deeper).
        const yHi = yTop + stripHeight * gi
        const yLo = yTop + stripHeight * (gi + 1)
        const yMid = (yHi + yLo) / 2
        const halfHeight = Math.abs(yHi - yLo) / 2
        let yPoints
        let symbol
        let sizePx
        if (showDots === 'rug') {
          // All ticks of a group share its strip midline so each group
          // reads as a single rug row.
          yPoints = xPoints.map(() => yMid)
          symbol = 'line-ns-open'
          // Cap rug-tick height so a tall strip (few groups) doesn't
          // produce comically long ticks; small strip shrinks naturally.
          sizePx = Math.max(5, Math.min(12, halfHeight * 800))
        } else {
          // Jitter stays inside its own strip — deterministic pseudo-
          // random so dots don't shuffle on every re-render.
          yPoints = xPoints.map((_, idx) => {
            const r = pseudoRandom(
              idx * 9301 + gi * 7919 + g.values.length * 49297,
            )
            // Keep dots away from the strip edges (0.1 inset each side)
            // so neighboring groups stay visually separated.
            const t = 0.1 + 0.8 * r
            return yHi + (yLo - yHi) * t
          })
          symbol = 'circle'
          sizePx = 4
        }
        data.push({
          type: 'scatter',
          mode: 'markers',
          name: `${g.name} (raw)`,
          x: xPoints,
          y: yPoints,
          marker: {
            color,
            size: sizePx,
            symbol,
            opacity: Math.max(0, Math.min(1, dotOpacity)),
            line: { color, width: showDots === 'rug' ? 1.2 : 0 },
          },
          showlegend: false,
          hovertemplate:
            `<b>${escapeHtml(g.name)}</b><br>` +
            `값: %{x:.3g}${u}<extra></extra>`,
        })
      }
    }

    const layout = {
      autosize: true,
      margin: { l: 56, r: 24, t: 16, b: 44 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      xaxis: {
        title: xAxisTitle ? { text: xAxisTitle, font: { size: 12 } } : undefined,
        tickfont: { size: 11 },
        range: xDomain,
        zeroline: false,
      },
      yaxis: {
        title: yAxisTitle
          ? { text: yAxisTitle, font: { size: 12 } }
          : { text: '밀도', font: { size: 12 } },
        tickfont: { size: 11 },
        zeroline: true,
        zerolinecolor: 'rgba(0,0,0,0.25)',
        zerolinewidth: 1,
        // Reserve a small slice below 0 for raw-data marks when shown.
        rangemode: showDots !== 'none' ? 'normal' : 'tozero',
      },
      legend: {
        orientation: 'h',
        y: -0.18,
        font: { size: 11 },
      },
      hovermode: 'closest',
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
    safeGroups,
    xDomain,
    bandwidthMode,
    bandwidth,
    samples,
    fill,
    showDots,
    dotOpacity,
    xAxisTitle,
    yAxisTitle,
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
// Math helpers                                                                  //
// --------------------------------------------------------------------------- //

/** Silverman's rule of thumb for Gaussian KDE bandwidth.
 *  h = 0.9 * min(σ, IQR/1.34) * n^(-1/5)
 *  Degenerates gracefully when n < 2 or σ = 0 — falls back to a tiny
 *  width derived from the value's magnitude so the curve still draws.
 */
function silvermanBandwidth(values) {
  const n = values.length
  if (n < 2) {
    const v = Math.abs(values[0] ?? 1)
    return Math.max(v * 0.05, 0.1)
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((s, v) => s + v, 0) / n
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
  const std = Math.sqrt(variance)
  const q1 = quantileSorted(sorted, 0.25)
  const q3 = quantileSorted(sorted, 0.75)
  const iqr = q3 - q1
  const spread =
    std > 0 && iqr > 0
      ? Math.min(std, iqr / 1.34)
      : std > 0
      ? std
      : iqr > 0
      ? iqr / 1.34
      : 1
  const h = 0.9 * spread * Math.pow(n, -1 / 5)
  return h > 0 ? h : 0.1
}

function quantileSorted(sorted, q) {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  const frac = pos - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

const _SQRT2PI = Math.sqrt(2 * Math.PI)

function gaussianKde(values, x, h) {
  if (!(h > 0)) return 0
  let acc = 0
  for (const v of values) {
    const u = (x - v) / h
    acc += Math.exp(-0.5 * u * u)
  }
  return acc / (values.length * h * _SQRT2PI)
}

function linspace(lo, hi, n) {
  if (n <= 1) return [lo]
  const out = new Array(n)
  const step = (hi - lo) / (n - 1)
  for (let i = 0; i < n; i += 1) out[i] = lo + step * i
  return out
}

/** Deterministic 0..1 pseudo-random — same seed gives same value so
 *  jittered dots stay still across re-renders. */
function pseudoRandom(seed) {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

// --------------------------------------------------------------------------- //
// Color helpers                                                                 //
// --------------------------------------------------------------------------- //

function normalizeColor(raw, fallbackIdx) {
  if (typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw)) return raw
  return DENSITY_PALETTE[(fallbackIdx ?? 0) % DENSITY_PALETTE.length]
}

function toRgba(hex, alpha) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return `rgba(99, 102, 241, ${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c])
}

// --------------------------------------------------------------------------- //
// Text helpers                                                                  //
// --------------------------------------------------------------------------- //

function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}
