/**
 * Treemap widget — hierarchical area chart.
 *
 * Data model is a flat long-form list of `{ label, parent, value, color }`
 * rows; Plotly internally reconstructs the tree by matching each row's
 * `parent` field to another row's `label` (or "" for root nodes). Same
 * UX pattern as Contour's "x · y · z 행" mode — a simple multi-column
 * table with paste/copy/clear support.
 *
 * Render goes through Plotly's `treemap` trace with `branchvalues:
 * 'remainder'` by default so parent values auto-rollup from leaves.
 * Colorscale is optional — when unset Plotly picks from its categorical
 * palette; when set, each cell's `value` is mapped through the scale.
 * Per-row `color` strings (hex / CSS) win over the colorscale on that
 * specific cell.
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
  captionPositionOf,
  toTsv,
} from './_shared'

const COLORSCALE_OPTIONS = [
  { value: '', label: '(자동 — 최상위 그룹별 색상)' },
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

const TEXT_INFO_OPTIONS = [
  { value: 'label', label: '라벨만' },
  { value: 'label+value', label: '라벨 + 값' },
  { value: 'label+value+percent_parent', label: '라벨 + 값 + 부모 대비 %' },
  { value: 'label+value+percent_root', label: '라벨 + 값 + 전체 대비 %' },
  { value: 'label+percent_root', label: '라벨 + 전체 대비 %' },
  { value: 'value', label: '값만' },
  { value: 'none', label: '표시 안 함' },
]

const BRANCH_VALUE_OPTIONS = [
  { value: 'remainder', label: '리프 합계' },
  { value: 'total', label: '직접 입력' },
]

// 1-depth seed showing the typical "category → subcategories" layout
// so a freshly inserted widget renders something. Heatmap-style 0 grid
// would just show a single blank box.
const DEFAULT_ROWS = [
  { label: '전체', parent: '', value: null },
  { label: 'A', parent: '전체', value: 30 },
  { label: 'B', parent: '전체', value: 20 },
  { label: 'C', parent: '전체', value: 15 },
]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function TreemapPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="비용 분해"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function TreemapPreview({ props }) {
  // Mini nested-rectangle hint.
  return (
    <div className="space-y-2">
      <PreviewLabel hint="계층 면적 차트">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 100 60" className="w-24 h-14">
          <rect x="2" y="2" width="60" height="56" fill="#3b82f6" opacity="0.85" />
          <rect x="64" y="2" width="34" height="34" fill="#10b981" opacity="0.85" />
          <rect x="64" y="38" width="34" height="20" fill="#f59e0b" opacity="0.85" />
          <rect x="4" y="4" width="28" height="28" fill="#1e3a8a" opacity="0.85" />
          <rect x="34" y="4" width="26" height="28" fill="#1d4ed8" opacity="0.85" />
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function TreemapEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const rows = useMemo(
    () => (Array.isArray(content?.rows) && content.rows.length > 0 ? content.rows : DEFAULT_ROWS),
    [content?.rows],
  )
  const colorscale = content?.colorscale ?? ''
  const reverseScale = content?.reverse_scale ?? false
  const textInfo = content?.text_info ?? 'label+value+percent_parent'
  const branchvalues = content?.branchvalues ?? 'remainder'
  // Suffix appended to numeric values in cell labels + hover (e.g.
  // "억원", "%", "건"). Free-form string the author types in once;
  // applied everywhere by the canvas via texttemplate.
  const unit = content?.unit ?? ''

  // Rows that someone else references as their `parent` — these are
  // the non-leaf nodes whose values get auto-computed in aggregate mode.
  const labelsWithChildren = useMemo(() => {
    const set = new Set()
    for (const r of rows) {
      const p = (r?.parent ?? '').trim()
      if (p) set.add(p)
    }
    return set
  }, [rows])
  // Bottom-up roll-up — same numbers Plotly will see when aggregate
  // mode is active. We expose them so the table can show the computed
  // sum on disabled parent rows ("값이 자동 계산됨"의 시각적 증거).
  const computedValues = useMemo(() => aggregateRowValues(rows), [rows])
  const isAggregateMode = branchvalues !== 'total'

  function patch(next) {
    const merged = { ...(content ?? {}), rows, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.colorscale) delete merged.colorscale
    if (!merged.reverse_scale) delete merged.reverse_scale
    if (!merged.text_info || merged.text_info === 'label+value+percent_parent') {
      delete merged.text_info
    }
    if (!merged.branchvalues || merged.branchvalues === 'remainder') {
      delete merged.branchvalues
    }
    if (!merged.unit) delete merged.unit
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
    patch({ rows: [...rows, { label: '', parent: '', value: null }] })
  }
  function removeRow(idx) {
    if (rows.length <= 1) return
    patch({ rows: rows.filter((_, i) => i !== idx) })
  }

  /** Multi-cell paste — same convention as Contour's xyz table:
   *  - First TSV row dropped if it looks like a header (label / parent /
   *    value / color tokens).
   *  - Subsequent rows fill xyz table starting at (startRowIdx,
   *    startField); extra columns past `color` are ignored.
   *  - Table auto-extends when the paste exceeds current row count.
   */
  function pasteAtTable(startRowIdx, startField, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    let body = grid
    const firstLower = (grid[0] || []).map((s) =>
      String(s ?? '').trim().toLowerCase(),
    )
    const headerHit = firstLower.some((s) =>
      ['label', 'parent', 'value', 'color', '이름', '부모', '값', '색상'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['label', 'parent', 'value', 'color']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...rows]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ label: '', parent: '', value: null })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = { ...(nextRows[startRowIdx + r] ?? { label: '', parent: '', value: null }) }
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
          <TreemapCanvas
            rows={rows}
            colorscale={colorscale}
            reverseScale={reverseScale}
            textInfo={textInfo}
            branchvalues={branchvalues}
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
        {colorscale && (
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={reverseScale}
              onChange={(e) => patch({ reverse_scale: e.target.checked })}
            />
            <span className="text-muted-foreground">색 반전</span>
          </label>
        )}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">표시:</span>
          <select
            value={textInfo}
            onChange={(e) => patch({ text_info: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {TEXT_INFO_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div
          className="flex items-center gap-1"
          title="리프 합계: 부모 값이 자식 합으로 자동 계산. 직접 입력: 부모 row 의 value 를 그대로 사용."
        >
          <span className="text-muted-foreground">부모 값:</span>
          <select
            value={branchvalues}
            onChange={(e) => patch({ branchvalues: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {BRANCH_VALUE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div
          className="flex items-center gap-1"
          title="셀 라벨과 호버에 값 옆에 붙는 단위 문자열 (예: 억원, %, kg)"
        >
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
          <TreemapCanvas
            rows={rows}
            colorscale={colorscale}
            reverseScale={reverseScale}
            textInfo={textInfo}
            branchvalues={branchvalues}
            unit={unit}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="트리맵 데이터"
              onCopy={() => {
                const header = ['label', 'parent', 'value', 'color']
                const body = rows.map((r) => [
                  r?.label ?? '',
                  r?.parent ?? '',
                  r?.value ?? '',
                  r?.color ?? '',
                ])
                return toTsv([header, ...body])
              }}
              onClear={() => patch({ rows: [] })}
            />
          </div>
          <TreemapRowsTable
            rows={rows}
            onCellChange={setCell}
            onAdd={addRow}
            onRemove={removeRow}
            onMultiPaste={pasteAtTable}
            labelsWithChildren={labelsWithChildren}
            computedValues={computedValues}
            isAggregateMode={isAggregateMode}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            `parent` 는 다른 row 의 `label` 또는 비워두면 루트. value 가 빈 부모는 자식 합으로 자동 계산. color 는 hex 또는 CSS 컬러 문자열(선택). 엑셀 TSV 붙여넣기 지원.
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

// 4-column (label / parent / value / color) input table for treemap rows.
function TreemapRowsTable({
  rows,
  onCellChange,
  onAdd,
  onRemove,
  onMultiPaste,
  labelsWithChildren,
  computedValues,
  isAggregateMode,
}) {
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
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">parent</th>
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
                  value={row?.parent ?? ''}
                  onChange={(e) => onCellChange(ri, 'parent', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'parent')}
                  className="h-7 w-full text-[11px] border-0"
                  placeholder="(루트면 비움)"
                />
              </td>
              <td className="border border-muted p-0">
                {(() => {
                  // Parent rows in aggregate mode: value is computed
                  // from the row's children, so disable manual input
                  // (mimics the "값이 자동으로 계산됨" affordance the
                  // user asked for). Leaf rows + direct-input mode keep
                  // the editable input.
                  const isAuto =
                    isAggregateMode &&
                    labelsWithChildren?.has(row?.label)
                  if (isAuto) {
                    const computed = computedValues?.[ri]
                    return (
                      <Input
                        type="text"
                        disabled
                        readOnly
                        value={
                          Number.isFinite(computed) ? `Σ ${computed}` : 'Σ ?'
                        }
                        className="h-7 w-full text-[11px] text-center border-0 bg-muted/40 text-muted-foreground italic"
                        title="자식 합으로 자동 계산 — 부모 값 직접 입력은 '부모 값: 직접 입력' 으로 전환하세요"
                      />
                    )
                  }
                  return (
                    <Input
                      type="number"
                      value={row?.value === null || row?.value === undefined ? '' : row.value}
                      onChange={(e) => onCellChange(ri, 'value', e.target.value)}
                      onPaste={(e) => handlePaste(e, ri, 'value')}
                      className="h-7 w-full text-[11px] text-center border-0"
                    />
                  )
                })()}
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
            <td colSpan={5} className="text-center pt-1">
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

function TreemapCanvas({
  rows,
  colorscale = '',
  reverseScale = false,
  textInfo = 'label+value+percent_parent',
  branchvalues = 'remainder',
  unit = '',
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState(null)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)

  // Filter out incomplete rows (no label) at render time. Authors can
  // type freely in the table; we just skip rows the trace can't use.
  const validRows = useMemo(
    () => (rows ?? []).filter((r) => (r?.label ?? '').toString().trim().length > 0),
    [rows],
  )

  // Plotly's treemap requires every `parent` to point at an existing
  // `label` (or be ""). Drop dangling parents so a half-typed row
  // doesn't blank out the whole chart with a "missing branch" error.
  const safeRows = useMemo(() => {
    const labels = new Set(validRows.map((r) => r.label))
    return validRows.map((r) => ({
      ...r,
      parent: r.parent && !labels.has(r.parent) ? '' : (r.parent || ''),
    }))
  }, [validRows])

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
    if (safeRows.length === 0) {
      Plotly.react(el, [], { autosize: true, margin: { l: 0, r: 0, t: 0, b: 0 } }, { displaylogo: false })
      return undefined
    }
    const labels = safeRows.map((r) => r.label)
    const parents = safeRows.map((r) => r.parent ?? '')
    // Two value pipelines:
    //   - 'remainder' (UI label "리프 합계"): every parent's value is the
    //     sum of its children's aggregated values; leaves keep their own.
    //     This is what users almost always want — they fill in the leaves
    //     and parents auto-roll-up. We then ship `branchvalues: 'total'`
    //     so Plotly treats those computed sums as authoritative.
    //   - 'total' (UI label "직접 입력"): raw values straight from the
    //     table. Parents whose explicit value < sum(children) will render
    //     as Plotly-warns; that's the author's intent.
    const useAggregate = branchvalues !== 'total'
    const values = useAggregate
      ? aggregateRowValues(safeRows)
      : safeRows.map((r) => (Number.isFinite(r.value) ? r.value : 0))
    const explicitColors = safeRows.map((r) => r.color || null)
    const hasExplicit = explicitColors.some((c) => c)

    // Coloring rules:
    //   1. `colorscale` set       → map cell values through the scale
    //      (numerical "heatmap-like" view; per-row color still wins).
    //   2. `colorscale` missing   → group-by-top-ancestor coloring (every
    //      descendant of a top-level group shares the group's hue, so
    //      grouping reads at a glance). Per-row color still wins.
    //
    // Plotly's built-in categorical palette gives every leaf a different
    // color regardless of parent, which is what the user reported makes
    // grouping meaningless — `assignGroupColors` fixes that.
    const groupColors = colorscale ? null : assignGroupColors(safeRows)
    const marker = colorscale
      ? {
          colorscale,
          colors: explicitColors.map((c, i) => (c ?? values[i])),
          reversescale: !!reverseScale,
          showscale: !hasExplicit,
          colorbar: { thickness: 12, len: 0.8 },
          line: { width: 2, color: '#ffffff' },
        }
      : {
          colors: explicitColors.map((c, i) => c || groupColors[i]),
          line: { width: 2, color: '#ffffff' },
        }

    // Plotly's default `textinfo`/`hovertemplate` percentages are
    // rendered as "13.45678%" — too noisy at thumbnail size. Map each
    // text_info option to a d3-format `texttemplate` that locks the
    // percentage to a single decimal (.1%) and uses %{value} for raw
    // numbers. Unit (if any) is concatenated onto the value so cells
    // read like "30 억원" / "12.5 %" instead of bare numerics.
    const u = unit ? ` ${unit}` : ''
    const TEXT_TEMPLATES = {
      label: '%{label}',
      'label+value': `%{label}<br>%{value}${u}`,
      'label+value+percent_parent':
        `%{label}<br>%{value}${u}<br>%{percentParent:.1%}`,
      'label+value+percent_root':
        `%{label}<br>%{value}${u}<br>%{percentRoot:.1%}`,
      'label+percent_root': '%{label}<br>%{percentRoot:.1%}',
      value: `%{value}${u}`,
      none: '',
    }
    const textTemplate = TEXT_TEMPLATES[textInfo] ?? TEXT_TEMPLATES['label+value+percent_parent']

    const trace = {
      type: 'treemap',
      labels,
      parents,
      values,
      // Always send 'total' to Plotly — when the user picked the
      // "remainder" UI option we already pre-summed parents above, so
      // Plotly never has to do its own arithmetic across our data.
      branchvalues: 'total',
      ...(textInfo === 'none'
        ? { textinfo: 'none' }
        : { texttemplate: textTemplate, textinfo: 'none' }),
      ...(marker ? { marker } : {}),
      // Pathbar = breadcrumb shown at the top during drill-in. Matches
      // the KPI dashboard treemap's drilldown UX with a single Plotly
      // toggle. `edgeshape: '>'` is the chevron style; thickness +
      // textfont kept generous so the up-navigation chevron is a
      // visible, finger-friendly target (the default 12px / 24px was
      // too tiny to hit comfortably).
      pathbar: {
        visible: true,
        thickness: 40,
        edgeshape: '>',
        side: 'top',
        textfont: {
          size: 15,
          color: '#0f172a',
          family: 'system-ui, -apple-system, sans-serif',
        },
      },
      // Small gap between siblings so the dividing white edge reads
      // cleanly — same trick the reference treemap uses for the
      // "tiles separated by frame" look.
      tiling: { pad: 3 },
      textfont: {
        family: 'system-ui, -apple-system, sans-serif',
        size: 13,
        color: '#ffffff',
      },
      // Parent boxes get a slightly larger/bolder header so the
      // hierarchy reads at a glance.
      textposition: 'middle center',
      hoverlabel: {
        bgcolor: 'rgba(15, 23, 42, 0.96)',
        bordercolor: 'rgba(255, 255, 255, 0.08)',
        font: { color: '#ffffff', size: 12 },
      },
      hovertemplate:
        `<b>%{label}</b><br>값: %{value}${u}<br>부모 대비: %{percentParent:.1%}<br>전체 대비: %{percentRoot:.1%}<extra></extra>`,
    }
    const layout = {
      autosize: true,
      // top margin reserves room for the pathbar (thickness:40) plus
      // a small breathing strip so the chevron isn't pinned to the
      // edge of the cell or hidden under the parent card chrome.
      margin: { l: 8, r: 8, t: 56, b: 8 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
    }
    const config = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['sendDataToCloud'],
    }
    Plotly.react(el, [trace], layout, config)
    return undefined
  }, [
    safeRows,
    colorscale,
    reverseScale,
    textInfo,
    branchvalues,
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

// Categorical palette for the "group by top ancestor" coloring mode.
// Same hue family as the KPI-dashboard treemap reference (indigo /
// emerald / amber / red / violet / cyan / pink / teal / orange / slate)
// — distinct enough at glance with plenty of contrast for white text.
const TREEMAP_GROUP_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

/**
 * Assign each row a color based on its top-level ancestor so the tree
 * reads as colored groups instead of a value-ranked gradient. Rules:
 *
 *   - If the data has exactly one root (a row with `parent === ""` or
 *     pointing nowhere), the *children* of that root are treated as the
 *     groups — the root itself gets a neutral gray. That's the common
 *     "전체 → 사업부 → ..." shape.
 *   - If there are multiple roots, the roots themselves are the groups.
 *   - Each row picks up its group's color, so all descendants of a
 *     group share the same hue. Plotly's per-sibling padding still
 *     keeps individual cells visually separated.
 *
 * Returns a `colors[]` array aligned to the input `rows` order, ready to
 * drop into the trace's `marker.colors`.
 */
function assignGroupColors(rows) {
  const byLabel = new Map(rows.map((r) => [r.label, r]))
  const isRoot = (r) => {
    const p = r.parent ?? ''
    return p === '' || !byLabel.has(p)
  }
  const roots = rows.filter(isRoot).map((r) => r.label)
  const singleRoot = roots.length === 1

  function groupOf(label) {
    let cur = byLabel.get(label)
    if (!cur) return null
    const chain = []
    // Walk to the topmost ancestor we can find in the data.
    const seen = new Set()
    while (cur && !seen.has(cur.label)) {
      seen.add(cur.label)
      chain.push(cur.label)
      const p = cur.parent ?? ''
      if (!p || !byLabel.has(p)) break
      cur = byLabel.get(p)
    }
    if (chain.length === 0) return null
    // Single-root: the one row just below the root.
    if (singleRoot && chain.length >= 2) return chain[chain.length - 2]
    return chain[chain.length - 1]
  }

  // Stable group order = first-appearance in the rows array.
  const groupOrder = []
  const groupSet = new Set()
  for (const r of rows) {
    const g = groupOf(r.label)
    if (g != null && !groupSet.has(g)) {
      groupSet.add(g)
      groupOrder.push(g)
    }
  }
  const colorByGroup = new Map()
  groupOrder.forEach((g, i) => {
    colorByGroup.set(g, TREEMAP_GROUP_PALETTE[i % TREEMAP_GROUP_PALETTE.length])
  })

  return rows.map((r) => {
    if (singleRoot && roots.includes(r.label)) return '#e2e8f0' // root neutral
    const g = groupOf(r.label)
    return colorByGroup.get(g) ?? TREEMAP_GROUP_PALETTE[0]
  })
}

/**
 * Bottom-up aggregation. For each row we return the value Plotly should
 * see:
 *   - If the row has children, its value is the sum of those children's
 *     aggregated values (the explicit input on a parent row is ignored
 *     so authors can leave parents blank and have the tree roll up).
 *   - If the row is a leaf, we use its explicit value or 0.
 *
 * Used in tandem with `branchvalues: 'total'` on the trace — Plotly
 * then treats parents as authoritative totals and we never hit the
 * "remainder" arithmetic that needs parents to equal sum-of-children
 * exactly.
 */
function aggregateRowValues(rows) {
  const byLabel = new Map()
  const childrenOf = new Map()
  for (const r of rows) {
    byLabel.set(r.label, r)
    const p = r.parent ?? ''
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(r.label)
  }
  const cache = new Map()
  // 'COMPUTING' sentinel = 이 노드의 compute 가 진행 중. 같은 노드가 자기
  // 호출 스택 위에서 다시 들어오면 cycle 이므로 0 반환하고 끊는다.
  // 가장 흔한 발생: "행 추가" 직후 새 행이 label='' parent='' 로 들어
  // 가서, childrenOf.get('') 에 '' 가 들어가고 → compute('') 가 자기
  // 자식 ''를 다시 호출 → Maximum call stack size exceeded. 빈/사이클
  // 데이터에 대한 방어.
  const COMPUTING = Symbol('computing')
  function compute(label) {
    if (cache.has(label)) {
      const v = cache.get(label)
      return v === COMPUTING ? 0 : v
    }
    cache.set(label, COMPUTING)
    // 자기 자신을 자식으로 갖는 self-loop (label === parent) 도 같은 사유로
    // 제거. cycle guard 가 잡긴 하지만 한 단계 일찍 잘라 성능 / 가독성 ↑.
    const kids = (childrenOf.get(label) ?? []).filter((k) => k !== label)
    const row = byLabel.get(label)
    let val
    if (kids.length === 0) {
      val = Number.isFinite(row?.value) ? row.value : 0
    } else {
      val = kids.reduce((acc, k) => acc + compute(k), 0)
    }
    cache.set(label, val)
    return val
  }
  return rows.map((r) => compute(r.label))
}

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
