/**
 * Mind Map widget.
 *
 * Data shape is identical to Tree / Treemap / Packing
 * (`rows: [{label, parent, color}]`), so authors can switch
 * visualization on the same hierarchy without re-keying. Two
 * differentiators vs. Tree:
 *
 *   1. Layout — 'radial' puts the root at center with branches
 *      radiating 360°. 'horizontal' splits level-1 children
 *      left/right (XMind / MindNode style).
 *   2. Editing UX — the canvas itself is the primary input. Hover a
 *      node to reveal + (add child) and × (delete) buttons;
 *      double-click to edit the label inline; Tab/Enter/Delete
 *      shortcuts apply when a node is selected and the canvas has
 *      keyboard focus.
 *
 * Labels are the keys (matching Tree), so renaming a node rewrites
 * any child's `parent` pointer in lockstep.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { hierarchy as d3Hierarchy, tree as d3Tree } from 'd3-hierarchy'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  CaptionInput,
  DataTableActions,
  LabelField,
  PreviewLabel,
  captionSkipProps,
  toTsv,
} from './_shared'

const LAYOUT_OPTIONS = [
  { value: 'radial', label: '방사형 (360°)' },
  { value: 'horizontal', label: '좌우 분기' },
]
const BRANCH_STYLE_OPTIONS = [
  { value: 'taper', label: '점감 (굵음→얇음)' },
  { value: 'curve', label: '균일 곡선' },
]

const MM_GROUP_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#0ea5e9',
]
const MM_NEUTRAL = '#475569'
const MM_ROOT_COLOR = '#1e293b'

const DEFAULT_ROWS = [
  { label: '핵심 주제', parent: '' },
  { label: '아이디어 A', parent: '핵심 주제' },
  { label: '아이디어 B', parent: '핵심 주제' },
  { label: '아이디어 C', parent: '핵심 주제' },
  { label: 'A-1', parent: '아이디어 A' },
  { label: 'A-2', parent: '아이디어 A' },
  { label: 'B-1', parent: '아이디어 B' },
]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function MindMapPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="마인드맵"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function MindMapPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="마인드맵">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 60 40" className="w-24 h-16">
          {/* Radial preview sketch */}
          <path d="M30 20 Q40 14 50 10" stroke="#6366f1" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M30 20 Q40 26 50 30" stroke="#10b981" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M30 20 Q20 14 10 10" stroke="#f59e0b" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M30 20 Q20 26 10 30" stroke="#ef4444" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M50 10 Q54 8 58 6" stroke="#a5b4fc" strokeWidth="1" fill="none" strokeLinecap="round" />
          <path d="M10 30 Q6 32 2 34" stroke="#fca5a5" strokeWidth="1" fill="none" strokeLinecap="round" />
          <ellipse cx={30} cy={20} rx={7} ry={4} fill="#1e293b" />
          <text x={30} y={20} textAnchor="middle" dominantBaseline="middle" fontSize="3" fill="#fff" fontWeight={700}>주제</text>
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function MindMapEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const rows = useMemo(
    () =>
      Array.isArray(content?.rows) && content.rows.length > 0
        ? content.rows
        : DEFAULT_ROWS,
    [content?.rows],
  )
  const layout = content?.layout === 'horizontal' ? 'horizontal' : 'radial'
  const branchStyle = content?.branch_style === 'curve' ? 'curve' : 'taper'
  const colorByGroup = content?.color_by_group !== false // default true
  const showRootEmphasis = content?.show_root_emphasis !== false // default true

  // Interaction state lives in the Editor — the canvas is a controlled
  // component that gets the current selection + edit cursor via props
  // and calls back when the user changes them.
  const [selectedId, setSelectedId] = useState(null)
  const [editingId, setEditingId] = useState(null)

  function patch(next) {
    const merged = { ...(content ?? {}), rows, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.layout || merged.layout === 'radial') delete merged.layout
    if (!merged.branch_style || merged.branch_style === 'taper') {
      delete merged.branch_style
    }
    if (merged.color_by_group === undefined || merged.color_by_group === true) {
      delete merged.color_by_group
    }
    if (
      merged.show_root_emphasis === undefined ||
      merged.show_root_emphasis === true
    ) {
      delete merged.show_root_emphasis
    }
    if (Array.isArray(merged.rows) && merged.rows.length === 0) delete merged.rows
    onChange(merged)
  }

  function setCell(idx, field, value) {
    // Renaming via the table must propagate to children's `parent`
    // pointers (same rule as inline-edit on the canvas).
    if (field === 'label') {
      const oldLabel = rows[idx]?.label ?? ''
      const newLabel = value
      const next = rows.map((r, i) => {
        if (i === idx) return { ...r, label: newLabel }
        if (r.parent === oldLabel) return { ...r, parent: newLabel }
        return r
      })
      patch({ rows: next })
      return
    }
    const next = rows.map((r, i) => (i === idx ? { ...r, [field]: value } : r))
    patch({ rows: next })
  }
  function addRow() {
    const label = nextNewLabel(rows, '새 가지')
    patch({ rows: [...rows, { label, parent: '' }] })
  }
  function removeRowAt(idx) {
    if (rows.length <= 1) return
    patch({ rows: rows.filter((_, i) => i !== idx) })
  }

  // Canvas-driven editing ---------------------------------------------------

  function addChild(parentLabel) {
    const label = nextNewLabel(rows, '새 가지')
    patch({ rows: [...rows, { label, parent: parentLabel ?? '' }] })
    setSelectedId(label)
    setEditingId(label)
  }

  function addSibling(label) {
    const target = rows.find((r) => r.label === label)
    if (!target) return
    // Root has no parent so "sibling" would create another root —
    // fall back to "add child" to keep the flow predictable.
    if (!target.parent) {
      addChild(label)
      return
    }
    const newLabel = nextNewLabel(rows, '새 가지')
    patch({ rows: [...rows, { label: newLabel, parent: target.parent }] })
    setSelectedId(newLabel)
    setEditingId(newLabel)
  }

  function removeNode(label) {
    const target = rows.find((r) => r.label === label)
    if (!target) return
    // Collect all descendants too. Iterative BFS handles arbitrary
    // depth without recursion limits.
    const toDelete = new Set([label])
    let changed = true
    while (changed) {
      changed = false
      for (const r of rows) {
        if (r.parent && toDelete.has(r.parent) && !toDelete.has(r.label)) {
          toDelete.add(r.label)
          changed = true
        }
      }
    }
    const nextRows = rows.filter((r) => !toDelete.has(r.label))
    // Never leave the widget with zero nodes — refuse and ping selection.
    if (nextRows.length === 0) return
    patch({ rows: nextRows })
    // After deletion, jump selection up to the parent if it still
    // exists; otherwise fall back to the first surviving row.
    const next = nextRows.find((r) => r.label === target.parent) ?? nextRows[0]
    setSelectedId(next?.label ?? null)
    setEditingId(null)
  }

  function renameNode(oldLabel, rawNewLabel) {
    const newLabel = (rawNewLabel ?? '').trim()
    setEditingId(null)
    if (!newLabel || newLabel === oldLabel) return
    // Label collision — refuse rather than silently merging two
    // distinct nodes. Selection stays on the original.
    if (rows.some((r) => r.label === newLabel)) return
    const next = rows.map((r) => {
      let nx = r
      if (r.label === oldLabel) nx = { ...nx, label: newLabel }
      if (r.parent === oldLabel) nx = { ...nx, parent: newLabel }
      return nx
    })
    patch({ rows: next })
    setSelectedId(newLabel)
  }

  function pasteAtTable(startRowIdx, startField, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    let body = grid
    const firstLower = (grid[0] || []).map((s) =>
      String(s ?? '').trim().toLowerCase(),
    )
    const headerHit = firstLower.some((s) =>
      ['label', 'parent', 'color', '이름', '부모', '색상'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return
    const fieldOrder = ['label', 'parent', 'color']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...rows]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ label: '', parent: '' })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = { ...(nextRows[startRowIdx + r] ?? { label: '', parent: '' }) }
      for (let c = 0; c < body[r].length; c += 1) {
        const fieldIdx = startFieldIdx + c
        if (fieldIdx >= fieldOrder.length) break
        const field = fieldOrder[fieldIdx]
        target[field] = String(body[r][c] ?? '').trim()
      }
      nextRows[startRowIdx + r] = target
    }
    patch({ rows: nextRows })
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
          <MindMapCanvas
            rows={rows}
            layout={layout}
            branchStyle={branchStyle}
            colorByGroup={colorByGroup}
            showRootEmphasis={showRootEmphasis}
            autoFit={autoFit}
            readOnly
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
          <span className="text-muted-foreground">레이아웃:</span>
          <select
            value={layout}
            onChange={(e) => patch({ layout: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {LAYOUT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">가지:</span>
          <select
            value={branchStyle}
            onChange={(e) => patch({ branch_style: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {BRANCH_STYLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="끄면 모든 가지가 단일 색상"
        >
          <input
            type="checkbox"
            checked={colorByGroup}
            onChange={(e) => patch({ color_by_group: e.target.checked })}
          />
          <span className="text-muted-foreground">그룹 색상</span>
        </label>
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="루트를 padded 타원 + 굵은 글씨로 강조"
        >
          <input
            type="checkbox"
            checked={showRootEmphasis}
            onChange={(e) => patch({ show_root_emphasis: e.target.checked })}
          />
          <span className="text-muted-foreground">루트 강조</span>
        </label>
        <span className="ml-auto text-[10px] text-muted-foreground italic">
          캔버스 노드: 클릭=선택 · 더블클릭=편집 · <kbd>Tab</kbd>=자식 · <kbd>Enter</kbd>=형제 · <kbd>Del</kbd>=삭제
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          <MindMapCanvas
            rows={rows}
            layout={layout}
            branchStyle={branchStyle}
            colorByGroup={colorByGroup}
            showRootEmphasis={showRootEmphasis}
            autoFit={false}
            selectedId={selectedId}
            editingId={editingId}
            onSelect={setSelectedId}
            onStartEdit={setEditingId}
            onAddChild={addChild}
            onAddSibling={addSibling}
            onRemove={removeNode}
            onRename={renameNode}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="마인드맵 데이터"
              onCopy={() => {
                const header = ['label', 'parent', 'color']
                const body = rows.map((r) => [
                  r?.label ?? '',
                  r?.parent ?? '',
                  r?.color ?? '',
                ])
                return toTsv([header, ...body])
              }}
              onClear={() => {
                patch({ rows: [{ label: '핵심 주제', parent: '' }] })
                setSelectedId(null)
                setEditingId(null)
              }}
            />
          </div>
          <MindMapRowsTable
            rows={rows}
            onCellChange={setCell}
            onAdd={addRow}
            onRemove={removeRowAt}
            onMultiPaste={pasteAtTable}
            selectedId={selectedId}
            onSelectRow={(idx) => setSelectedId(rows[idx]?.label ?? null)}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            `parent` 는 다른 row 의 `label` 과 정확히 일치해야 합니다 (비워두면 루트). 캔버스에서 노드를 추가/편집해도 같은 데이터에 반영됩니다. 엑셀 TSV 붙여넣기 지원.
          </p>
        </div>
      </div>
    </div>
  )
}

function MindMapRowsTable({
  rows,
  onCellChange,
  onAdd,
  onRemove,
  onMultiPaste,
  selectedId,
  onSelectRow,
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
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">color</th>
            <th className="border border-muted bg-muted/30 w-7" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const isSelected = row?.label && row.label === selectedId
            return (
              <tr
                key={ri}
                className={isSelected ? 'bg-primary/10' : ''}
                onClick={() => onSelectRow?.(ri)}
              >
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
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(ri)
                    }}
                    title="행 삭제"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            )
          })}
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
// Canvas                                                                        //
// --------------------------------------------------------------------------- //

// Layout tuning constants ----------------------------------------------------
const RADIAL_RING_GAP = 110   // svg-units between depth rings
const HORIZ_LEVEL_GAP = 130   // svg-units between depth columns
const HORIZ_NODE_GAP = 30     // svg-units between sibling rows
const LABEL_FONT = 13
const ROOT_FONT = 14

function MindMapCanvas({
  rows,
  layout = 'radial',
  branchStyle = 'taper',
  colorByGroup = true,
  showRootEmphasis = true,
  autoFit = true,
  readOnly = false,
  selectedId = null,
  editingId = null,
  onSelect,
  onStartEdit,
  onAddChild,
  onAddSibling,
  onRemove,
  onRename,
}) {
  const containerRef = useRef(null)
  const svgRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hoverId, setHoverId] = useState(null)
  const [editDraft, setEditDraft] = useState('')

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const measure = () => {
      const w = el.clientWidth
      const h = autoFit ? Math.max(260, Math.min(720, w)) : el.clientHeight
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [autoFit])

  // Seed the draft buffer whenever editing starts.
  useEffect(() => {
    if (editingId == null) {
      setEditDraft('')
      return
    }
    setEditDraft(editingId)
  }, [editingId])

  // Sanitize rows + build hierarchy. Multiple roots get wrapped in a
  // synthetic root so a single layout pass handles them, and we mark
  // it for skipping at render time.
  const tree = useMemo(() => buildHierarchy(rows), [rows])

  // Compute (cx, cy) for every node in the canonical svg space.
  const positioned = useMemo(() => {
    if (!tree) return null
    if (layout === 'horizontal') return layoutHorizontal(tree)
    return layoutRadial(tree)
  }, [tree, layout])

  // Center the laid-out tree inside the available cell with margins.
  const transform = useMemo(() => {
    if (!positioned || size.w === 0) return null
    const margin = 16 + 40 // extra room for label text outside the bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of positioned.nodes) {
      if (positioned.syntheticRoot && n.depth === 0) continue
      if (n.cx < minX) minX = n.cx
      if (n.cx > maxX) maxX = n.cx
      if (n.cy < minY) minY = n.cy
      if (n.cy > maxY) maxY = n.cy
    }
    if (!Number.isFinite(minX)) return null
    minX -= margin; maxX += margin; minY -= margin; maxY += margin
    const w = maxX - minX, h = maxY - minY
    const availH = size.h || size.w
    const scale = Math.min(size.w / w, availH / h, 1.2)
    const dx = (size.w - w * scale) / 2 - minX * scale
    const dy = (availH - h * scale) / 2 - minY * scale
    return { scale, dx, dy }
  }, [positioned, size])

  // Group coloring — every level-1 child's subtree gets a palette color,
  // then descendants get the same hue lightened per depth.
  const colorOf = useMemo(() => {
    if (!positioned) return () => MM_NEUTRAL
    const { nodes, syntheticRoot } = positioned
    // Order the top-level children by their position in the rows array
    // so colors stay stable as the user edits.
    const groupOrder = []
    const groupSeen = new Set()
    for (const n of nodes) {
      if (n === positioned.root) continue
      if (syntheticRoot && n.depth === 0) continue
      const top = topAncestor(n)
      if (top && !groupSeen.has(top.data.name)) {
        groupSeen.add(top.data.name)
        groupOrder.push(top.data.name)
      }
    }
    return (n) => {
      // Per-row override wins regardless of grouping.
      if (n.data?.color) return n.data.color
      // Single-root case: central root gets its own ink color so it
      // visually anchors the whole map. Multi-root maps have no
      // "central" anchor — each root falls through to palette color.
      if (!syntheticRoot && n === positioned.root) return MM_ROOT_COLOR
      if (!colorByGroup) return MM_NEUTRAL
      const top = topAncestor(n)
      if (!top) return MM_NEUTRAL
      const idx = groupOrder.indexOf(top.data.name)
      const base = MM_GROUP_PALETTE[(idx < 0 ? 0 : idx) % MM_GROUP_PALETTE.length]
      // Top-of-group = base color; deeper levels lighten step-wise.
      // Mirrors the hand-drawn mind-map convention where leaves fade.
      const depthFromTop = Math.max(0, n.depth - 1)
      return lightenHex(base, Math.min(0.4, depthFromTop * 0.12))
    }
  }, [positioned, colorByGroup])

  // Keyboard shortcuts (Tab=child, Enter=sibling, Delete=remove) only
  // fire when a node is selected, the canvas has focus, and we're not
  // currently in inline-edit mode (input owns the keys then).
  function onCanvasKeyDown(e) {
    if (readOnly) return
    if (editingId != null) return
    if (selectedId == null) return
    if (e.key === 'Tab') {
      e.preventDefault()
      onAddChild?.(selectedId)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onAddSibling?.(selectedId)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      onRemove?.(selectedId)
    } else if (e.key === 'F2') {
      e.preventDefault()
      onStartEdit?.(selectedId)
    }
  }

  // Visible nodes/links exclude the synthetic root when present so the
  // user never sees the placeholder.
  const visibleNodes = positioned
    ? positioned.nodes.filter((n) => !(positioned.syntheticRoot && n.depth === 0))
    : []
  const visibleLinks = positioned
    ? positioned.links.filter((l) => !(positioned.syntheticRoot && l.source.depth === 0))
    : []

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-md border bg-background overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary/40"
      style={
        autoFit
          ? { height: size.w ? `${Math.max(260, Math.min(720, size.w))}px` : '20rem' }
          : { height: '100%', minHeight: '14rem' }
      }
      tabIndex={readOnly ? -1 : 0}
      onKeyDown={onCanvasKeyDown}
      onClick={(e) => {
        // Click on empty canvas area deselects.
        if (e.target === e.currentTarget || e.target === svgRef.current) {
          onSelect?.(null)
        }
      }}
    >
      {positioned && transform && size.w > 0 ? (
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h || size.w}
          viewBox={`0 0 ${size.w} ${size.h || size.w}`}
          style={{ display: 'block' }}
        >
          <g transform={`translate(${transform.dx},${transform.dy}) scale(${transform.scale})`}>
            {/* Branches first so labels draw on top. */}
            <g fill="none" strokeLinecap="round">
              {visibleLinks.map((l, i) => {
                const s = l.source
                const t = l.target
                const stroke = colorOf(l.target)
                const w =
                  branchStyle === 'taper'
                    ? Math.max(1.4, 6 - (t.depth - (positioned.syntheticRoot ? 1 : 0)) * 1.2)
                    : 1.6
                return (
                  <path
                    key={i}
                    d={branchPath(s, t, layout)}
                    stroke={stroke}
                    strokeOpacity={0.85}
                    strokeWidth={w}
                  />
                )
              })}
            </g>

            {/* Labels / nodes. */}
            <g>
              {visibleNodes.map((n) => {
                const isRoot =
                  positioned.syntheticRoot ? n.depth === 1 : n === positioned.root
                const isRootEmphasis = isRoot && showRootEmphasis
                const isSelected = n.data?.name === selectedId
                const isHover = n.data?.name === hoverId
                const isEditing = n.data?.name === editingId
                const color = isRootEmphasis ? MM_ROOT_COLOR : colorOf(n)
                const label = n.data?.name || ''
                const fontSize = isRoot ? ROOT_FONT : LABEL_FONT
                const textW = Math.max(40, label.length * fontSize * 0.62 + 18)
                const textH = fontSize + 12
                return (
                  <g
                    key={n.data?.name}
                    transform={`translate(${n.cx},${n.cy})`}
                    style={{ cursor: readOnly ? 'default' : 'pointer' }}
                    onMouseEnter={() => setHoverId(n.data?.name)}
                    onMouseLeave={() =>
                      setHoverId((h) => (h === n.data?.name ? null : h))
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelect?.(n.data?.name)
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (readOnly) return
                      onStartEdit?.(n.data?.name)
                    }}
                  >
                    {/* Background pill — only for root emphasis or hover/select highlight. */}
                    {isRootEmphasis ? (
                      <ellipse
                        cx={0}
                        cy={0}
                        rx={textW / 2 + 6}
                        ry={textH / 2 + 4}
                        fill={MM_ROOT_COLOR}
                        stroke={isSelected ? '#fbbf24' : 'none'}
                        strokeWidth={2}
                      />
                    ) : (
                      <rect
                        x={-textW / 2}
                        y={-textH / 2}
                        width={textW}
                        height={textH}
                        rx={4}
                        fill={isSelected || isHover ? color : 'transparent'}
                        fillOpacity={isSelected ? 0.18 : isHover ? 0.1 : 0}
                        stroke={isSelected ? color : 'none'}
                        strokeWidth={1.5}
                      />
                    )}
                    {/* Underline accent (mind-map style) for non-root nodes. */}
                    {!isRootEmphasis && (
                      <line
                        x1={-textW / 2}
                        y1={textH / 2 - 1}
                        x2={textW / 2}
                        y2={textH / 2 - 1}
                        stroke={color}
                        strokeOpacity={0.7}
                        strokeWidth={2}
                      />
                    )}

                    {!isEditing && (
                      <text
                        x={0}
                        y={1}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={fontSize}
                        fontWeight={isRoot ? 700 : 500}
                        fill={isRootEmphasis ? '#ffffff' : '#0f172a'}
                      >
                        {label || '...'}
                      </text>
                    )}
                    {isEditing && (
                      <foreignObject
                        x={-textW / 2}
                        y={-textH / 2}
                        width={textW}
                        height={textH}
                      >
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation()
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              onRename?.(label, editDraft)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              onStartEdit?.(null)
                            }
                          }}
                          onBlur={() => onRename?.(label, editDraft)}
                          style={{
                            width: '100%',
                            height: '100%',
                            fontSize: `${fontSize}px`,
                            fontWeight: isRoot ? 700 : 500,
                            textAlign: 'center',
                            border: '1px solid #94a3b8',
                            borderRadius: 4,
                            padding: '0 4px',
                            background: '#ffffff',
                            color: '#0f172a',
                            outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      </foreignObject>
                    )}

                    {/* Floating action buttons — visible on hover OR when selected. */}
                    {!readOnly && (isHover || isSelected) && !isEditing && (
                      <NodeActions
                        x={textW / 2 + 4}
                        y={-textH / 2}
                        canDelete={!(isRoot && !positioned.syntheticRoot)}
                        onAdd={(e) => {
                          e.stopPropagation()
                          onAddChild?.(n.data?.name)
                        }}
                        onDelete={(e) => {
                          e.stopPropagation()
                          onRemove?.(n.data?.name)
                        }}
                      />
                    )}
                  </g>
                )
              })}
            </g>
          </g>
        </svg>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          데이터를 입력하면 마인드맵이 표시됩니다
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Layout helpers                                                                //
// --------------------------------------------------------------------------- //

function buildHierarchy(rows) {
  const cleaned = (rows ?? []).filter((r) => (r?.label ?? '').trim().length > 0)
  if (cleaned.length === 0) return null
  const byLabel = new Map(cleaned.map((r) => [r.label, r]))
  const sanitized = cleaned.map((r) => ({
    ...r,
    parent: r.parent && byLabel.has(r.parent) ? r.parent : '',
  }))
  const sanitizedByLabel = new Map(sanitized.map((r) => [r.label, r]))
  const childrenOf = new Map()
  for (const r of sanitized) {
    const p = r.parent || '__root__'
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p).push(r.label)
  }
  const visiting = new Set()
  function build(label) {
    const row = sanitizedByLabel.get(label)
    if (visiting.has(label)) {
      return { name: label, color: row?.color || null, children: undefined }
    }
    visiting.add(label)
    const kids = (childrenOf.get(label) ?? []).map(build)
    visiting.delete(label)
    return {
      name: label,
      color: row?.color || null,
      children: kids.length > 0 ? kids : undefined,
    }
  }
  const rootLabels = childrenOf.get('__root__') ?? []
  const syntheticRoot = rootLabels.length !== 1
  const tree =
    rootLabels.length === 1
      ? build(rootLabels[0])
      : { name: '__root__', children: rootLabels.map(build) }
  return { d3Tree: d3Hierarchy(tree), syntheticRoot }
}

function layoutRadial({ d3Tree: hRoot, syntheticRoot }) {
  // d3.tree on a polar canvas: x = angle (0..2π), y = radial distance.
  const maxDepth = Math.max(1, hRoot.height)
  const radius = maxDepth * RADIAL_RING_GAP
  const layoutFn = d3Tree()
    .size([2 * Math.PI, radius])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.4) / Math.max(1, a.depth))
  layoutFn(hRoot)
  const nodes = []
  hRoot.each((n) => {
    const angle = n.x
    const r = n.y
    // Root → (0,0). Synthetic root also (0,0) but hidden later.
    n.cx = n.depth === 0 ? 0 : r * Math.sin(angle)
    n.cy = n.depth === 0 ? 0 : -r * Math.cos(angle)
    nodes.push(n)
  })
  const links = hRoot.links()
  return { root: hRoot, nodes, links, syntheticRoot }
}

function layoutHorizontal({ d3Tree: hRoot, syntheticRoot }) {
  // Split level-1 children left/right, run d3.tree on each side as a
  // standalone subtree, then place them mirrored around the root.
  const levelOne = hRoot.children ?? []
  if (levelOne.length === 0) {
    hRoot.cx = 0; hRoot.cy = 0
    return { root: hRoot, nodes: [hRoot], links: [], syntheticRoot }
  }
  // Even index → right, odd → left. Balances when counts are mixed.
  const right = [], left = []
  levelOne.forEach((c, i) => (i % 2 === 0 ? right : left).push(c))
  layoutSide(right, +1)
  layoutSide(left, -1)
  hRoot.cx = 0
  hRoot.cy = 0
  const nodes = []
  hRoot.each((n) => nodes.push(n))
  return { root: hRoot, nodes, links: hRoot.links(), syntheticRoot }
}

function layoutSide(children, sign) {
  if (children.length === 0) return
  // Build a throwaway hierarchy wrapping these children under a
  // dummy root, so d3.tree distributes them as siblings. We then
  // walk the dummy and real trees in lockstep to copy positions
  // back — children are in the same order on both sides, so a
  // parallel traversal works without needing key-matching.
  const dummy = d3Hierarchy({
    name: '__side__',
    children: children.map(extractPlainTree),
  })
  const layoutFn = d3Tree().nodeSize([HORIZ_NODE_GAP, HORIZ_LEVEL_GAP])
  layoutFn(dummy)
  // Center this side vertically around y=0 so left and right halves
  // are balanced relative to the (0,0) root.
  let minX = Infinity, maxX = -Infinity
  dummy.each((n) => {
    if (n.depth === 0) return
    if (n.x < minX) minX = n.x
    if (n.x > maxX) maxX = n.x
  })
  const yOffset = Number.isFinite(minX) ? -(minX + maxX) / 2 : 0
  function walk(real, fake) {
    real.cx = sign * fake.y
    real.cy = fake.x + yOffset
    const realKids = real.children ?? []
    const fakeKids = fake.children ?? []
    for (let i = 0; i < Math.min(realKids.length, fakeKids.length); i += 1) {
      walk(realKids[i], fakeKids[i])
    }
  }
  children.forEach((real, i) => walk(real, dummy.children[i]))
}

function extractPlainTree(node) {
  return {
    name: node.data?.name,
    color: node.data?.color || null,
    children: (node.children ?? []).map(extractPlainTree),
  }
}

function branchPath(s, t, layout) {
  // Cubic bezier whose control points pull toward the source's axis,
  // giving the branch an organic curve. For radial we sway from source
  // tangentially; for horizontal we offset along x.
  const dx = t.cx - s.cx
  const dy = t.cy - s.cy
  if (layout === 'horizontal') {
    const cx1 = s.cx + dx * 0.4
    const cx2 = t.cx - dx * 0.4
    return `M${s.cx},${s.cy} C${cx1},${s.cy} ${cx2},${t.cy} ${t.cx},${t.cy}`
  }
  // Radial: bezier with mid control point biased toward the source's
  // radial midpoint so branches arc outward instead of going straight.
  const mx = (s.cx + t.cx) / 2
  const my = (s.cy + t.cy) / 2
  // Pull controls toward origin proportional to distance — produces a
  // gentle outward arc.
  const ox = (mx - dy * 0.1)
  const oy = (my + dx * 0.1)
  return `M${s.cx},${s.cy} C${s.cx + dx * 0.2},${s.cy + dy * 0.2} ${ox},${oy} ${t.cx},${t.cy}`
}

function topAncestor(n) {
  // "Top of group" = the depth-1 ancestor of n.
  //   - single root: depth-0 root, depth-1 children are groups.
  //   - multi-root (synthetic root inserted at depth 0): depth-1
  //     real roots are themselves the groups.
  let cur = n
  while (cur && cur.depth > 1) cur = cur.parent
  if (!cur || cur.depth !== 1) return null
  return cur
}

// --------------------------------------------------------------------------- //
// Floating per-node action buttons                                              //
// --------------------------------------------------------------------------- //

function NodeActions({ x, y, canDelete, onAdd, onDelete }) {
  // Two stacked tiny SVG buttons next to the node. Pure SVG (no
  // HTML overlay) so they live inside the same transform and scale
  // correctly with the canvas.
  return (
    <g transform={`translate(${x},${y})`} style={{ pointerEvents: 'all' }}>
      <g transform="translate(0,0)" onClick={onAdd} style={{ cursor: 'pointer' }}>
        <circle r={9} fill="#10b981" stroke="#ffffff" strokeWidth={1.5} />
        <path d="M -4 0 L 4 0 M 0 -4 L 0 4" stroke="#ffffff" strokeWidth={1.6} strokeLinecap="round" />
        <title>자식 노드 추가 (Tab)</title>
      </g>
      {canDelete && (
        <g transform="translate(0,22)" onClick={onDelete} style={{ cursor: 'pointer' }}>
          <circle r={9} fill="#ef4444" stroke="#ffffff" strokeWidth={1.5} />
          <path d="M -4 -4 L 4 4 M -4 4 L 4 -4" stroke="#ffffff" strokeWidth={1.6} strokeLinecap="round" />
          <title>노드 삭제 (Del)</title>
        </g>
      )}
    </g>
  )
}

// --------------------------------------------------------------------------- //
// Misc helpers                                                                  //
// --------------------------------------------------------------------------- //

function nextNewLabel(rows, base) {
  const taken = new Set((rows ?? []).map((r) => (r?.label ?? '').trim()))
  if (!taken.has(base)) return base
  for (let i = 2; i < 9999; i += 1) {
    const cand = `${base} ${i}`
    if (!taken.has(cand)) return cand
  }
  return `${base} ${Date.now()}`
}

function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}

function lightenHex(hex, amount) {
  // amount in [0,1]. Naive RGB blend toward white.
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  let r = (n >> 16) & 0xff
  let g = (n >> 8) & 0xff
  let b = n & 0xff
  r = Math.round(r + (255 - r) * amount)
  g = Math.round(g + (255 - g) * amount)
  b = Math.round(b + (255 - b) * amount)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

