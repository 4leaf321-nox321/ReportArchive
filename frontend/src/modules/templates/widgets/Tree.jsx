/**
 * Tree diagram widget.
 *
 * Data model is the same long-form `rows: [{label, parent, subtitle,
 * color}]` shape Treemap and Packing use — same hierarchy, just a
 * different rendering. We feed the rows through `d3-hierarchy.tree()`
 * to compute (x, y) positions, then draw nodes and edges as plain
 * SVG. Layout responds to `orientation`, edge shape, node shape, and
 * group-coloring toggles from the toolbar.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { hierarchy as d3Hierarchy, tree as d3Tree } from 'd3-hierarchy'
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

const ORIENTATION_OPTIONS = [
  { value: 'vertical', label: '세로 (루트=상단)' },
  { value: 'horizontal', label: '가로 (루트=왼쪽)' },
]
const NODE_SHAPE_OPTIONS = [
  { value: 'rect', label: '사각형' },
  { value: 'circle', label: '원' },
]
const EDGE_STYLE_OPTIONS = [
  { value: 'curve', label: '곡선' },
  { value: 'step', label: '직각' },
  { value: 'straight', label: '직선' },
]

const TREE_GROUP_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]
const TREE_NEUTRAL = '#475569'

// Default starter — small org-chart shape so the fresh widget actually
// renders a recognizable tree.
const DEFAULT_ROWS = [
  { label: '루트', parent: '' },
  { label: 'A', parent: '루트' },
  { label: 'B', parent: '루트' },
  { label: 'A-1', parent: 'A' },
  { label: 'A-2', parent: 'A' },
]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function TreePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="조직도"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function TreePreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="트리 다이어그램">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 60 40" className="w-20 h-14">
          <path d="M30 8 Q30 16 14 22" stroke="#94a3b8" strokeWidth="0.6" fill="none" />
          <path d="M30 8 Q30 16 46 22" stroke="#94a3b8" strokeWidth="0.6" fill="none" />
          <path d="M14 24 Q14 30 8 34" stroke="#94a3b8" strokeWidth="0.6" fill="none" />
          <path d="M14 24 Q14 30 20 34" stroke="#94a3b8" strokeWidth="0.6" fill="none" />
          <rect x={24} y={4} width={12} height={6} rx={1} fill="#6366f1" />
          <rect x={8} y={20} width={12} height={6} rx={1} fill="#10b981" />
          <rect x={40} y={20} width={12} height={6} rx={1} fill="#f59e0b" />
          <rect x={3} y={32} width={10} height={5} rx={1} fill="#a5b4fc" />
          <rect x={15} y={32} width={10} height={5} rx={1} fill="#a5b4fc" />
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function TreeEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const rows = useMemo(
    () =>
      Array.isArray(content?.rows) && content.rows.length > 0
        ? content.rows
        : DEFAULT_ROWS,
    [content?.rows],
  )
  const capPos = captionPositionOf(content)
  const orientation = content?.orientation === 'horizontal' ? 'horizontal' : 'vertical'
  const nodeShape = content?.node_shape === 'circle' ? 'circle' : 'rect'
  const edgeStyle = ['curve', 'step', 'straight'].includes(content?.edge_style)
    ? content.edge_style
    : 'curve'
  const colorByGroup = content?.color_by_group !== false // default true
  const nodePadX = Number.isFinite(content?.node_padding_x)
    ? content.node_padding_x
    : 24
  const nodePadY = Number.isFinite(content?.node_padding_y)
    ? content.node_padding_y
    : 28

  function patch(next) {
    const merged = { ...(content ?? {}), rows, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.orientation || merged.orientation === 'vertical') {
      delete merged.orientation
    }
    if (!merged.node_shape || merged.node_shape === 'rect') delete merged.node_shape
    if (!merged.edge_style || merged.edge_style === 'curve') delete merged.edge_style
    if (merged.color_by_group === undefined || merged.color_by_group === true) {
      delete merged.color_by_group
    }
    if (merged.node_padding_x == null || merged.node_padding_x === 24) {
      delete merged.node_padding_x
    }
    if (merged.node_padding_y == null || merged.node_padding_y === 28) {
      delete merged.node_padding_y
    }
    if (Array.isArray(merged.rows) && merged.rows.length === 0) delete merged.rows
    onChange(merged)
  }

  function setCell(idx, field, value) {
    const next = rows.map((r, i) => (i === idx ? { ...r, [field]: value } : r))
    patch({ rows: next })
  }
  function addRow() {
    patch({ rows: [...rows, { label: '', parent: '' }] })
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
      ['label', 'parent', 'subtitle', 'color', '이름', '부모', '부제', '색상'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['label', 'parent', 'subtitle', 'color']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...rows]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ label: '', parent: '' })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = {
        ...(nextRows[startRowIdx + r] ?? { label: '', parent: '' }),
      }
      for (let c = 0; c < body[r].length; c += 1) {
        const fieldIdx = startFieldIdx + c
        if (fieldIdx >= fieldOrder.length) break
        const field = fieldOrder[fieldIdx]
        const raw = body[r][c]
        target[field] = String(raw ?? '').trim()
      }
      nextRows[startRowIdx + r] = target
    }
    patch({ rows: nextRows })
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
          <TreeCanvas
            rows={rows}
            orientation={orientation}
            nodeShape={nodeShape}
            edgeStyle={edgeStyle}
            colorByGroup={colorByGroup}
            nodePadX={nodePadX}
            nodePadY={nodePadY}
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
          <span className="text-muted-foreground">방향:</span>
          <select
            value={orientation}
            onChange={(e) => patch({ orientation: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {ORIENTATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">노드:</span>
          <select
            value={nodeShape}
            onChange={(e) => patch({ node_shape: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {NODE_SHAPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">엣지:</span>
          <select
            value={edgeStyle}
            onChange={(e) => patch({ edge_style: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {EDGE_STYLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="끄면 모든 노드가 단일 색상"
        >
          <input
            type="checkbox"
            checked={colorByGroup}
            onChange={(e) => patch({ color_by_group: e.target.checked })}
          />
          <span className="text-muted-foreground">그룹 색상</span>
        </label>
        <div className="flex items-center gap-1" title="형제 노드 간 가로 간격 (px)">
          <span className="text-muted-foreground">간격 X:</span>
          <Input
            type="number"
            min={0}
            max={80}
            value={nodePadX}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ node_padding_x: Number.isFinite(v) ? v : 24 })
            }}
            className="h-7 w-14 text-xs"
          />
        </div>
        <div className="flex items-center gap-1" title="부모-자식 간 세로 간격 (px)">
          <span className="text-muted-foreground">간격 Y:</span>
          <Input
            type="number"
            min={0}
            max={80}
            value={nodePadY}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ node_padding_y: Number.isFinite(v) ? v : 28 })
            }}
            className="h-7 w-14 text-xs"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          <TreeCanvas
            rows={rows}
            orientation={orientation}
            nodeShape={nodeShape}
            edgeStyle={edgeStyle}
            colorByGroup={colorByGroup}
            nodePadX={nodePadX}
            nodePadY={nodePadY}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div className="text-xs font-semibold text-muted-foreground">데이터</div>
            <DataTableActions
              label="트리 데이터"
              onCopy={() => {
                const header = ['label', 'parent', 'subtitle', 'color']
                const body = rows.map((r) => [
                  r?.label ?? '',
                  r?.parent ?? '',
                  r?.subtitle ?? '',
                  r?.color ?? '',
                ])
                return toTsv([header, ...body])
              }}
              onClear={() => patch({ rows: [{ label: '루트', parent: '' }] })}
            />
          </div>
          <TreeRowsTable
            rows={rows}
            onCellChange={setCell}
            onAdd={addRow}
            onRemove={removeRow}
            onMultiPaste={pasteAtTable}
          />
          <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
            `parent` 는 다른 row 의 `label` 과 정확히 일치해야 합니다 (비워두면 루트). 부모가 데이터에 없으면 그 row 는 자동으로 루트로 강등. `subtitle` 은 노드 아래 작은 부제. 엑셀 TSV 붙여넣기 지원.
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

function TreeRowsTable({ rows, onCellChange, onAdd, onRemove, onMultiPaste }) {
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
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">subtitle</th>
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
                <Input
                  value={row?.subtitle ?? ''}
                  onChange={(e) => onCellChange(ri, 'subtitle', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'subtitle')}
                  className="h-7 w-full text-[11px] border-0"
                  placeholder="(선택)"
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

const NODE_W = 110
const NODE_H = 38

function TreeCanvas({
  rows,
  orientation = 'vertical',
  nodeShape = 'rect',
  edgeStyle = 'curve',
  colorByGroup = true,
  nodePadX = 24,
  nodePadY = 28,
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // Measure the cell to size the SVG canvas. autoFit makes the cell
  // square (tree usually reads better square-ish than wide).
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

  // Build the hierarchy with cycle guards (mirrors Packing). Multiple
  // roots get wrapped in a synthetic root so d3.tree can lay them out
  // side-by-side, and we hide the synthetic node when drawing.
  const layout = useMemo(() => {
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
    const buildVisiting = new Set()
    function buildNode(label) {
      const row = sanitizedByLabel.get(label)
      if (buildVisiting.has(label)) {
        return { name: label, color: row?.color || null, subtitle: row?.subtitle || null, children: undefined }
      }
      buildVisiting.add(label)
      const kids = (childrenOf.get(label) ?? []).map(buildNode)
      buildVisiting.delete(label)
      return {
        name: label,
        color: row?.color || null,
        subtitle: row?.subtitle || null,
        children: kids.length > 0 ? kids : undefined,
      }
    }
    const rootLabels = childrenOf.get('__root__') ?? []
    const syntheticRoot = rootLabels.length !== 1
    const tree =
      rootLabels.length === 1
        ? buildNode(rootLabels[0])
        : {
            name: '__root__',
            children: rootLabels.map(buildNode),
          }
    const h = d3Hierarchy(tree)
    // d3.tree needs explicit node size in svg units. Tracking node
    // box + padding as the cell size lets the layout reserve room
    // for the rendered rect/circle without overlap.
    const nodeSize =
      orientation === 'vertical'
        ? [NODE_W + nodePadX, NODE_H + nodePadY]
        : [NODE_H + nodePadY, NODE_W + nodePadX]
    const layoutFn = d3Tree().nodeSize(nodeSize)
    layoutFn(h)
    return { root: h, syntheticRoot }
  }, [rows, orientation, nodePadX, nodePadY])

  // Compute the bounding box of all real (non-synthetic) nodes so we
  // can translate them into the available SVG area with a margin.
  const transform = useMemo(() => {
    if (!layout || size.w === 0) return null
    const margin = 12
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    layout.root.each((n) => {
      if (layout.syntheticRoot && n.depth === 0) return
      const nx = orientation === 'vertical' ? n.x : n.y
      const ny = orientation === 'vertical' ? n.y : n.x
      if (nx < minX) minX = nx
      if (nx > maxX) maxX = nx
      if (ny < minY) minY = ny
      if (ny > maxY) maxY = ny
    })
    if (!Number.isFinite(minX)) return null
    // Pad the bounds by half a node so the node box never gets
    // clipped at the canvas edge.
    minX -= NODE_W / 2 + margin
    maxX += NODE_W / 2 + margin
    minY -= NODE_H / 2 + margin
    maxY += NODE_H / 2 + margin
    const treeW = maxX - minX
    const treeH = maxY - minY
    const sx = size.w / treeW
    const sy = (size.h || size.w) / treeH
    const scale = Math.min(sx, sy, 1)
    const dx = (size.w - treeW * scale) / 2 - minX * scale
    const dy = ((size.h || size.w) - treeH * scale) / 2 - minY * scale
    return { scale, dx, dy }
  }, [layout, size, orientation])

  // Group ancestors (treemap-style coloring). Walks up until just
  // below the (real or synthetic) root.
  const groupColor = useMemo(() => {
    if (!layout) return () => TREE_NEUTRAL
    const { root, syntheticRoot } = layout
    function topAncestor(n) {
      let cur = n
      while (
        cur.parent &&
        (syntheticRoot ? cur.parent.depth > 0 : cur.parent.parent)
      ) {
        cur = cur.parent
      }
      return cur
    }
    const groupOrder = []
    const seen = new Set()
    root.each((n) => {
      if (n === root) return
      const g = topAncestor(n)
      if (!seen.has(g.data.name)) {
        seen.add(g.data.name)
        groupOrder.push(g.data.name)
      }
    })
    return (n) => {
      if (!colorByGroup) return TREE_NEUTRAL
      const g = topAncestor(n)
      const idx = groupOrder.indexOf(g.data.name)
      return TREE_GROUP_PALETTE[
        (idx < 0 ? 0 : idx) % TREE_GROUP_PALETTE.length
      ]
    }
  }, [layout, colorByGroup])

  /** Convert a logical (x, y) from d3.tree into rendered SVG coords
   *  factoring in orientation and the computed transform. */
  function project(n) {
    if (orientation === 'vertical') return { x: n.x, y: n.y }
    return { x: n.y, y: n.x }
  }

  /** Edge path string in the chosen style. Source/target are projected
   *  parent/child SVG coords. */
  function edgePath(s, t) {
    if (edgeStyle === 'straight') return `M${s.x},${s.y} L${t.x},${t.y}`
    if (edgeStyle === 'step') {
      // Right-angle elbow at the midpoint of the perpendicular axis —
      // classic org-chart connector. Mid-line shifts depending on
      // orientation so the elbow turns in the natural direction.
      if (orientation === 'vertical') {
        const my = (s.y + t.y) / 2
        return `M${s.x},${s.y} L${s.x},${my} L${t.x},${my} L${t.x},${t.y}`
      }
      const mx = (s.x + t.x) / 2
      return `M${s.x},${s.y} L${mx},${s.y} L${mx},${t.y} L${t.x},${t.y}`
    }
    // 'curve' — single cubic bezier between source and target with
    // control points pulled toward the parent's axis. Same shape
    // d3.linkVertical / linkHorizontal produce, but inlined so we
    // don't pull in d3-shape just for this.
    if (orientation === 'vertical') {
      const my = (s.y + t.y) / 2
      return `M${s.x},${s.y} C${s.x},${my} ${t.x},${my} ${t.x},${t.y}`
    }
    const mx = (s.x + t.x) / 2
    return `M${s.x},${s.y} C${mx},${s.y} ${mx},${t.y} ${t.x},${t.y}`
  }

  const visibleNodes = layout
    ? layout.root.descendants().filter((n) => !(layout.syntheticRoot && n.depth === 0))
    : []
  const visibleLinks = layout
    ? layout.root
        .links()
        .filter((l) => !(layout.syntheticRoot && l.source.depth === 0))
    : []

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
      {layout && transform && size.w > 0 ? (
        <svg
          width={size.w}
          height={size.h || size.w}
          viewBox={`0 0 ${size.w} ${size.h || size.w}`}
          style={{ display: 'block' }}
        >
          <g transform={`translate(${transform.dx},${transform.dy}) scale(${transform.scale})`}>
            {/* Edges first so nodes draw on top. */}
            <g fill="none" stroke="#94a3b8" strokeWidth={1.4}>
              {visibleLinks.map((l, i) => {
                const s = project(l.source)
                const t = project(l.target)
                return <path key={i} d={edgePath(s, t)} />
              })}
            </g>
            {/* Nodes — rect or circle with multi-line label. */}
            <g>
              {visibleNodes.map((n, i) => {
                const p = project(n)
                const color = n.data?.color || groupColor(n)
                const label = n.data?.name || ''
                const subtitle = n.data?.subtitle || ''
                if (nodeShape === 'circle') {
                  const r = Math.max(NODE_H / 2, 20)
                  return (
                    <g key={i} transform={`translate(${p.x},${p.y})`}>
                      <circle r={r} fill={color} fillOpacity={0.95} stroke="#ffffff" strokeWidth={1.5} />
                      <text
                        x={0}
                        y={subtitle ? -3 : 1}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={12}
                        fontWeight={700}
                        fill="#ffffff"
                        style={{ textShadow: '0 1px 2px rgba(0,0,0,0.35)' }}
                      >
                        {label}
                      </text>
                      {subtitle && (
                        <text
                          x={0}
                          y={11}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize={10}
                          fill="rgba(255,255,255,0.85)"
                        >
                          {subtitle}
                        </text>
                      )}
                    </g>
                  )
                }
                // rect
                return (
                  <g key={i} transform={`translate(${p.x - NODE_W / 2},${p.y - NODE_H / 2})`}>
                    <rect
                      x={0}
                      y={0}
                      width={NODE_W}
                      height={NODE_H}
                      rx={5}
                      fill={color}
                      fillOpacity={0.95}
                      stroke="#ffffff"
                      strokeWidth={1.5}
                    />
                    <text
                      x={NODE_W / 2}
                      y={subtitle ? NODE_H / 2 - 4 : NODE_H / 2 + 1}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={12}
                      fontWeight={700}
                      fill="#ffffff"
                      style={{ textShadow: '0 1px 2px rgba(0,0,0,0.35)' }}
                    >
                      {label}
                    </text>
                    {subtitle && (
                      <text
                        x={NODE_W / 2}
                        y={NODE_H / 2 + 10}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={10}
                        fill="rgba(255,255,255,0.85)"
                      >
                        {subtitle}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </g>
        </svg>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          데이터를 입력하면 트리가 표시됩니다
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
