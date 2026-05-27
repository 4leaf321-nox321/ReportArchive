/**
 * Network graph widget.
 *
 * General node-and-edge graph: arbitrary edges, possibly cyclic,
 * directed or undirected. Unlike tree/packing/treemap (long-form
 * `rows` with parent), networks require an explicit nodes[] + edges[]
 * model.
 *
 * Layouts:
 *   force    — d3-force simulation; user can drag nodes around. After
 *              the sim stabilizes (or on drag end), the resulting (x,y)
 *              are persisted back to `content.nodes[i]` so reopening
 *              the report reproduces the same arrangement and the
 *              export pipeline (html2canvas / docx) snapshots the
 *              user's intended layout.
 *   circular — nodes evenly spaced on a circle
 *   grid     — nodes on a square lattice
 *   radial   — nodes grouped by `group` on concentric rings (rings
 *              ordered by group size desc; mixed-group neighbours
 *              cross naturally between rings)
 *
 * Edge integrity (source/target → existing node.id) and dedupe are
 * enforced at render time only — mirroring the Tree widget's
 * frontend-only cycle guard. Backend JSON Schema can't express
 * cross-field references in pure jsonschema.
 *
 * Self-loops (source === target) are skipped — supporting them needs
 * a separate arc path renderer that isn't worth the cost for v1.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceCollide,
} from 'd3-force'
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
  { value: 'force', label: 'Force-directed (물리 시뮬레이션)' },
  { value: 'circular', label: '원형 배치' },
  { value: 'grid', label: '격자 배치' },
  { value: 'radial', label: '방사형 (그룹별 동심원)' },
]
const NODE_SHAPE_OPTIONS = [
  { value: 'circle', label: '원' },
  { value: 'rect', label: '사각형' },
]

const NETWORK_GROUP_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]
const NETWORK_NEUTRAL = '#475569'

// Force defaults — tuned for ~4-30 node graphs to spread cleanly in
// the panel's typical 320-500 px canvas. d3-force's library defaults
// (link=30, charge=-30) collapse everything into a tight cluster;
// these are closer to what the common d3 gallery examples use.
const DEFAULT_LINK_DISTANCE = 90
const DEFAULT_CHARGE_STRENGTH = -400
const DEFAULT_NODE_SIZE_MIN = 6
const DEFAULT_NODE_SIZE_MAX = 22

// Default starter — small triangle so a fresh widget renders something
// recognizable instead of an empty canvas.
const DEFAULT_NODES = [
  { id: 'A', label: 'A', group: '그룹1' },
  { id: 'B', label: 'B', group: '그룹1' },
  { id: 'C', label: 'C', group: '그룹2' },
  { id: 'D', label: 'D', group: '그룹2' },
]
const DEFAULT_EDGES = [
  { source: 'A', target: 'B' },
  { source: 'B', target: 'C' },
  { source: 'C', target: 'D' },
  { source: 'D', target: 'A' },
  { source: 'A', target: 'C' },
]

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function NetworkPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="네트워크"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function NetworkPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="네트워크 그래프">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center p-3">
        <svg viewBox="0 0 60 40" className="w-20 h-14">
          <line x1={12} y1={10} x2={30} y2={20} stroke="#94a3b8" strokeWidth="0.6" />
          <line x1={30} y1={20} x2={50} y2={12} stroke="#94a3b8" strokeWidth="0.6" />
          <line x1={30} y1={20} x2={22} y2={32} stroke="#94a3b8" strokeWidth="0.6" />
          <line x1={30} y1={20} x2={44} y2={30} stroke="#94a3b8" strokeWidth="0.6" />
          <line x1={12} y1={10} x2={22} y2={32} stroke="#94a3b8" strokeWidth="0.6" />
          <circle cx={12} cy={10} r={3} fill="#6366f1" />
          <circle cx={30} cy={20} r={3.8} fill="#10b981" />
          <circle cx={50} cy={12} r={2.6} fill="#f59e0b" />
          <circle cx={22} cy={32} r={2.6} fill="#ef4444" />
          <circle cx={44} cy={30} r={2.4} fill="#8b5cf6" />
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function NetworkEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const nodes = useMemo(
    () =>
      Array.isArray(content?.nodes) && content.nodes.length > 0
        ? content.nodes
        : DEFAULT_NODES,
    [content?.nodes],
  )
  const edges = useMemo(
    () =>
      Array.isArray(content?.edges) && content.edges.length > 0
        ? content.edges
        : DEFAULT_EDGES,
    [content?.edges],
  )
  const layout = LAYOUT_OPTIONS.some((o) => o.value === content?.layout)
    ? content.layout
    : 'force'
  const nodeShape = content?.node_shape === 'rect' ? 'rect' : 'circle'
  const directed = content?.directed === true
  const showLabels = content?.show_labels !== false // default true
  const showEdgeLabels = content?.show_edge_labels === true
  const colorByGroup = content?.color_by_group !== false // default true
  const nodeSizeByValue = content?.node_size_by_value !== false // default true
  const linkDistance = Number.isFinite(content?.link_distance)
    ? content.link_distance
    : DEFAULT_LINK_DISTANCE
  const chargeStrength = Number.isFinite(content?.charge_strength)
    ? content.charge_strength
    : DEFAULT_CHARGE_STRENGTH
  const nodeSizeMin = Number.isFinite(content?.node_size_min)
    ? content.node_size_min
    : DEFAULT_NODE_SIZE_MIN
  const nodeSizeMax = Number.isFinite(content?.node_size_max)
    ? content.node_size_max
    : DEFAULT_NODE_SIZE_MAX

  // patch() — single onChange writer that prunes defaults so saved
  // content stays compact (matches Tree's pattern).
  const patch = useCallback(
    (next) => {
      const merged = { ...(content ?? {}), nodes, edges, ...next }
      if (!merged.caption) delete merged.caption
      if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
      if (!merged.layout || merged.layout === 'force') delete merged.layout
      if (!merged.node_shape || merged.node_shape === 'circle') {
        delete merged.node_shape
      }
      if (!merged.directed) delete merged.directed
      if (merged.show_labels === undefined || merged.show_labels === true) {
        delete merged.show_labels
      }
      if (!merged.show_edge_labels) delete merged.show_edge_labels
      if (merged.color_by_group === undefined || merged.color_by_group === true) {
        delete merged.color_by_group
      }
      if (
        merged.node_size_by_value === undefined ||
        merged.node_size_by_value === true
      ) {
        delete merged.node_size_by_value
      }
      if (
        merged.link_distance == null ||
        merged.link_distance === DEFAULT_LINK_DISTANCE
      ) {
        delete merged.link_distance
      }
      if (
        merged.charge_strength == null ||
        merged.charge_strength === DEFAULT_CHARGE_STRENGTH
      ) {
        delete merged.charge_strength
      }
      if (
        merged.node_size_min == null ||
        merged.node_size_min === DEFAULT_NODE_SIZE_MIN
      ) {
        delete merged.node_size_min
      }
      if (
        merged.node_size_max == null ||
        merged.node_size_max === DEFAULT_NODE_SIZE_MAX
      ) {
        delete merged.node_size_max
      }
      if (Array.isArray(merged.nodes) && merged.nodes.length === 0) {
        delete merged.nodes
      }
      if (Array.isArray(merged.edges) && merged.edges.length === 0) {
        delete merged.edges
      }
      onChange(merged)
    },
    [content, nodes, edges, onChange],
  )

  // Position persister — receives a Map<id, {x, y, fixed?}> from the
  // canvas and writes the coordinates back into nodes[]. Called on
  // drag end and when the force simulation reaches alpha~0.
  const persistPositions = useCallback(
    (positionMap) => {
      const next = nodes.map((n) => {
        const p = positionMap.get(n.id)
        if (!p) return n
        const merged = { ...n, x: p.x, y: p.y }
        if (p.fixed) merged.fixed = true
        else if ('fixed' in merged) delete merged.fixed
        return merged
      })
      patch({ nodes: next })
    },
    [nodes, patch],
  )

  function setNodeCell(idx, field, value) {
    const next = nodes.map((n, i) => (i === idx ? { ...n, [field]: value } : n))
    patch({ nodes: next })
  }
  function setEdgeCell(idx, field, value) {
    const next = edges.map((e, i) => (i === idx ? { ...e, [field]: value } : e))
    patch({ edges: next })
  }
  function addNode() {
    const baseIds = new Set(nodes.map((n) => n.id))
    let i = nodes.length + 1
    while (baseIds.has(`N${i}`)) i += 1
    patch({ nodes: [...nodes, { id: `N${i}`, label: `N${i}` }] })
  }
  function removeNode(idx) {
    if (nodes.length <= 1) return
    const removedId = nodes[idx]?.id
    const nextNodes = nodes.filter((_, i) => i !== idx)
    // Cascade: drop edges that reference the removed node.
    const nextEdges = edges.filter(
      (e) => e.source !== removedId && e.target !== removedId,
    )
    patch({ nodes: nextNodes, edges: nextEdges })
  }
  function addEdge() {
    const firstId = nodes[0]?.id ?? ''
    const secondId = nodes[1]?.id ?? firstId
    patch({ edges: [...edges, { source: firstId, target: secondId }] })
  }
  function removeEdge(idx) {
    patch({ edges: edges.filter((_, i) => i !== idx) })
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
          <NetworkCanvas
            nodes={nodes}
            edges={edges}
            layout={layout}
            nodeShape={nodeShape}
            directed={directed}
            showLabels={showLabels}
            showEdgeLabels={showEdgeLabels}
            colorByGroup={colorByGroup}
            nodeSizeByValue={nodeSizeByValue}
            nodeSizeMin={nodeSizeMin}
            nodeSizeMax={nodeSizeMax}
            linkDistance={linkDistance}
            chargeStrength={chargeStrength}
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
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="엣지에 화살표를 표시 (엣지별 `directed` 가 있으면 그것을 우선)"
        >
          <input
            type="checkbox"
            checked={directed}
            onChange={(e) => patch({ directed: e.target.checked })}
          />
          <span className="text-muted-foreground">방향 (화살표)</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => patch({ show_labels: e.target.checked })}
          />
          <span className="text-muted-foreground">노드 라벨</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showEdgeLabels}
            onChange={(e) => patch({ show_edge_labels: e.target.checked })}
          />
          <span className="text-muted-foreground">엣지 라벨</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer" title="끄면 모든 노드가 단일 색상">
          <input
            type="checkbox"
            checked={colorByGroup}
            onChange={(e) => patch({ color_by_group: e.target.checked })}
          />
          <span className="text-muted-foreground">그룹 색상</span>
        </label>
        <label
          className="flex items-center gap-1 cursor-pointer"
          title="노드의 `value` 에 비례하여 반경을 조정"
        >
          <input
            type="checkbox"
            checked={nodeSizeByValue}
            onChange={(e) => patch({ node_size_by_value: e.target.checked })}
          />
          <span className="text-muted-foreground">값별 크기</span>
        </label>
        {layout === 'force' && (
          <>
            <div className="flex items-center gap-1" title="엣지 스프링 길이 (px)">
              <span className="text-muted-foreground">엣지 길이:</span>
              <Input
                type="number"
                min={10}
                max={400}
                value={linkDistance}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  patch({
                    link_distance: Number.isFinite(v) ? v : DEFAULT_LINK_DISTANCE,
                  })
                }}
                className="h-7 w-16 text-xs"
              />
            </div>
            <div
              className="flex items-center gap-1"
              title="노드 반발력 (음수일수록 멀어짐)"
            >
              <span className="text-muted-foreground">반발력:</span>
              <Input
                type="number"
                min={-2000}
                max={0}
                value={chargeStrength}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  patch({
                    charge_strength: Number.isFinite(v) ? v : DEFAULT_CHARGE_STRENGTH,
                  })
                }}
                className="h-7 w-16 text-xs"
              />
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        <div className="min-h-0 flex flex-col">
          <NetworkCanvas
            nodes={nodes}
            edges={edges}
            layout={layout}
            nodeShape={nodeShape}
            directed={directed}
            showLabels={showLabels}
            showEdgeLabels={showEdgeLabels}
            colorByGroup={colorByGroup}
            nodeSizeByValue={nodeSizeByValue}
            nodeSizeMin={nodeSizeMin}
            nodeSizeMax={nodeSizeMax}
            linkDistance={linkDistance}
            chargeStrength={chargeStrength}
            autoFit={false}
            onPersistPositions={persistPositions}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1 space-y-3">
          {/* Nodes panel */}
          <div>
            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
              <div className="text-xs font-semibold text-muted-foreground">노드</div>
              <DataTableActions
                label="노드 데이터"
                onCopy={() => {
                  const header = ['id', 'label', 'group', 'value', 'color']
                  const body = nodes.map((n) => [
                    n?.id ?? '',
                    n?.label ?? '',
                    n?.group ?? '',
                    n?.value ?? '',
                    n?.color ?? '',
                  ])
                  return toTsv([header, ...body])
                }}
                onClear={() =>
                  patch({ nodes: [{ id: 'A', label: 'A' }], edges: [] })
                }
              />
            </div>
            <NodesTable
              nodes={nodes}
              onCellChange={setNodeCell}
              onAdd={addNode}
              onRemove={removeNode}
              onMultiPaste={(rIdx, field, text) =>
                pasteNodes(rIdx, field, text, nodes, (next) => patch({ nodes: next }))
              }
            />
            <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
              `id` 는 엣지가 참조하므로 유일해야 합니다. `value` 는 값별 크기 옵션에 사용. 엑셀 TSV 붙여넣기 지원.
            </p>
          </div>

          {/* Edges panel */}
          <div>
            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
              <div className="text-xs font-semibold text-muted-foreground">엣지</div>
              <DataTableActions
                label="엣지 데이터"
                onCopy={() => {
                  const header = ['source', 'target', 'weight', 'label', 'directed', 'color']
                  const body = edges.map((e) => [
                    e?.source ?? '',
                    e?.target ?? '',
                    e?.weight ?? '',
                    e?.label ?? '',
                    e?.directed == null ? '' : String(e.directed),
                    e?.color ?? '',
                  ])
                  return toTsv([header, ...body])
                }}
                onClear={() => patch({ edges: [] })}
              />
            </div>
            <EdgesTable
              edges={edges}
              nodeIds={nodes.map((n) => n.id)}
              directed={directed}
              onCellChange={setEdgeCell}
              onAdd={addEdge}
              onRemove={removeEdge}
              onMultiPaste={(rIdx, field, text) =>
                pasteEdges(rIdx, field, text, edges, (next) => patch({ edges: next }))
              }
            />
            <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
              `source`/`target` 은 노드 `id` 와 일치해야 합니다. 매칭 안 되는 엣지는 자동으로 숨김. 셀프 루프 (source=target) 도 숨김.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Node / Edge tables                                                            //
// --------------------------------------------------------------------------- //

function NodesTable({ nodes, onCellChange, onAdd, onRemove, onMultiPaste }) {
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
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">id</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">label</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">group</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">value</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">color</th>
            <th className="border border-muted bg-muted/30 w-7" />
          </tr>
        </thead>
        <tbody>
          {nodes.map((row, ri) => (
            <tr key={ri}>
              <td className="border border-muted p-0">
                <Input
                  value={row?.id ?? ''}
                  onChange={(e) => onCellChange(ri, 'id', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'id')}
                  className="h-7 w-full text-[11px] border-0 font-mono"
                />
              </td>
              <td className="border border-muted p-0">
                <Input
                  value={row?.label ?? ''}
                  onChange={(e) => onCellChange(ri, 'label', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'label')}
                  className="h-7 w-full text-[11px] border-0"
                  placeholder="(id 사용)"
                />
              </td>
              <td className="border border-muted p-0">
                <Input
                  value={row?.group ?? ''}
                  onChange={(e) => onCellChange(ri, 'group', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'group')}
                  className="h-7 w-full text-[11px] border-0"
                  placeholder="(선택)"
                />
              </td>
              <td className="border border-muted p-0">
                <Input
                  type="number"
                  value={row?.value ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    onCellChange(ri, 'value', v === '' ? undefined : Number(v))
                  }}
                  onPaste={(e) => handlePaste(e, ri, 'value')}
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
                  disabled={nodes.length <= 1}
                  onClick={() => onRemove(ri)}
                  title="노드 삭제 (연결된 엣지도 함께 삭제)"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={6} className="text-center pt-1">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAdd}>
                <Plus className="h-3 w-3 mr-1" /> 노드 추가
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function EdgesTable({ edges, nodeIds, directed, onCellChange, onAdd, onRemove, onMultiPaste }) {
  function handlePaste(e, ri, field) {
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onMultiPaste?.(ri, field, text)
  }
  const idSet = new Set(nodeIds)
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">source</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">target</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">weight</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">label</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium" title="이 엣지의 화살표 여부">↗</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">color</th>
            <th className="border border-muted bg-muted/30 w-7" />
          </tr>
        </thead>
        <tbody>
          {edges.map((row, ri) => {
            const srcOrphan = row?.source && !idSet.has(row.source)
            const tgtOrphan = row?.target && !idSet.has(row.target)
            return (
              <tr key={ri}>
                <td className="border border-muted p-0">
                  <Input
                    value={row?.source ?? ''}
                    onChange={(e) => onCellChange(ri, 'source', e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, 'source')}
                    className={`h-7 w-full text-[11px] border-0 font-mono ${srcOrphan ? 'text-destructive' : ''}`}
                    title={srcOrphan ? '존재하지 않는 노드 id' : undefined}
                  />
                </td>
                <td className="border border-muted p-0">
                  <Input
                    value={row?.target ?? ''}
                    onChange={(e) => onCellChange(ri, 'target', e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, 'target')}
                    className={`h-7 w-full text-[11px] border-0 font-mono ${tgtOrphan ? 'text-destructive' : ''}`}
                    title={tgtOrphan ? '존재하지 않는 노드 id' : undefined}
                  />
                </td>
                <td className="border border-muted p-0">
                  <Input
                    type="number"
                    value={row?.weight ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      onCellChange(ri, 'weight', v === '' ? undefined : Number(v))
                    }}
                    onPaste={(e) => handlePaste(e, ri, 'weight')}
                    className="h-7 w-full text-[11px] border-0"
                    placeholder="(선택)"
                  />
                </td>
                <td className="border border-muted p-0">
                  <Input
                    value={row?.label ?? ''}
                    onChange={(e) => onCellChange(ri, 'label', e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, 'label')}
                    className="h-7 w-full text-[11px] border-0"
                    placeholder="(선택)"
                  />
                </td>
                <td className="border border-muted p-0 text-center">
                  <select
                    value={String(row?.directed == null ? directed : row.directed)}
                    onChange={(e) => {
                      onCellChange(ri, 'directed', e.target.value === 'true')
                    }}
                    className="h-7 w-full text-[11px] bg-transparent"
                    title="이 엣지의 화살표"
                  >
                    <option value="true">→</option>
                    <option value="false">—</option>
                  </select>
                </td>
                <td className="border border-muted p-0">
                  <Input
                    value={row?.color ?? ''}
                    onChange={(e) => onCellChange(ri, 'color', e.target.value)}
                    onPaste={(e) => handlePaste(e, ri, 'color')}
                    className="h-7 w-full text-[11px] border-0"
                    placeholder="#94a3b8"
                  />
                </td>
                <td className="text-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive"
                    onClick={() => onRemove(ri)}
                    title="엣지 삭제"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            )
          })}
          <tr>
            <td colSpan={7} className="text-center pt-1">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAdd}>
                <Plus className="h-3 w-3 mr-1" /> 엣지 추가
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Canvas — d3-force simulation + drag + hover highlight + pan/zoom              //
// --------------------------------------------------------------------------- //

function NetworkCanvas({
  nodes,
  edges,
  layout,
  nodeShape,
  directed,
  showLabels,
  showEdgeLabels,
  colorByGroup,
  nodeSizeByValue,
  nodeSizeMin,
  nodeSizeMax,
  linkDistance,
  chargeStrength,
  autoFit,
  readOnly,
  onPersistPositions,
}) {
  const containerRef = useRef(null)
  const svgRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // The d3 simulation lives across many React renders and stores its
  // 'end' / 'tick' handlers as closures. Those closures must call the
  // *latest* onPersistPositions, otherwise an out-of-date handler will
  // patch with stale `content` (e.g. before the user toggled
  // node_shape) and silently undo the change. The ref tracks the
  // latest prop so the sim closure never sees a frozen one.
  const persistRef = useRef(onPersistPositions)
  useEffect(() => {
    persistRef.current = onPersistPositions
  })

  // Measure cell → SVG size. autoFit makes the cell square (matches
  // Tree pattern; networks read best squareish).
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

  // Sanitize input: dedupe nodes by id (last wins), drop orphan /
  // self-loop edges, dedupe edges. Stable across renders so the d3
  // simulation can hold onto the same node objects.
  const { sanitizedNodes, sanitizedEdges } = useMemo(() => {
    const byId = new Map()
    for (const n of nodes ?? []) {
      if (!n?.id) continue
      byId.set(n.id, n)
    }
    const sn = [...byId.values()]
    const idSet = new Set(byId.keys())
    const seenEdge = new Set()
    const se = []
    for (const e of edges ?? []) {
      if (!e?.source || !e?.target) continue
      if (e.source === e.target) continue
      if (!idSet.has(e.source) || !idSet.has(e.target)) continue
      // Dedupe respecting widget-level directedness: if any per-edge
      // override is true, treat as directed for dedupe.
      const isDirected = e.directed === true || (e.directed == null && directed)
      const key = isDirected
        ? `>${e.source}${e.target}`
        : `-${[e.source, e.target].sort().join('')}`
      if (seenEdge.has(key)) continue
      seenEdge.add(key)
      se.push(e)
    }
    return { sanitizedNodes: sn, sanitizedEdges: se }
  }, [nodes, edges, directed])

  // Structural fingerprint — restart the force sim only when the
  // graph's *structure* (node ids + edge endpoints) changes, never
  // when positions get persisted back into `content.nodes[].x/y`.
  // Without this, the persist → nodes-ref-change → useEffect-restart
  // cycle makes the canvas oscillate forever.
  const structuralKey = useMemo(() => {
    const ids = sanitizedNodes.map((n) => n.id).join('|')
    const eks = sanitizedEdges
      .map((e) => `${e.source}>${e.target}`)
      .join('|')
    return `${ids}//${eks}`
  }, [sanitizedNodes, sanitizedEdges])

  // Group → color map. Stable order = first-seen order.
  const groupColor = useMemo(() => {
    if (!colorByGroup) return () => NETWORK_NEUTRAL
    const order = []
    const seen = new Set()
    for (const n of sanitizedNodes) {
      const g = n.group || ''
      if (!seen.has(g)) {
        seen.add(g)
        order.push(g)
      }
    }
    return (groupName) => {
      const g = groupName || ''
      const idx = order.indexOf(g)
      return NETWORK_GROUP_PALETTE[
        (idx < 0 ? 0 : idx) % NETWORK_GROUP_PALETTE.length
      ]
    }
  }, [sanitizedNodes, colorByGroup])

  // Value → radius scale.
  const radiusFor = useMemo(() => {
    if (!nodeSizeByValue) return () => (nodeSizeMin + nodeSizeMax) / 2
    let lo = Infinity
    let hi = -Infinity
    for (const n of sanitizedNodes) {
      if (Number.isFinite(n.value)) {
        if (n.value < lo) lo = n.value
        if (n.value > hi) hi = n.value
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
      return () => (nodeSizeMin + nodeSizeMax) / 2
    }
    return (v) => {
      if (!Number.isFinite(v)) return (nodeSizeMin + nodeSizeMax) / 2
      const t = (v - lo) / (hi - lo)
      return nodeSizeMin + t * (nodeSizeMax - nodeSizeMin)
    }
  }, [sanitizedNodes, nodeSizeByValue, nodeSizeMin, nodeSizeMax])

  // ----- Position state ----- //
  // Pos map = the rendering source of truth. The force sim writes
  // every tick; static layouts write once. Drag handler also writes.
  // Initialized from saved (x, y) + falls back to layout computation.
  const w = size.w || 320
  const h = size.h || size.w || 320
  const [posVersion, setPosVersion] = useState(0)
  const posRef = useRef(new Map()) // id → { x, y, fx?, fy? }
  const simRef = useRef(null)
  const liveNodesRef = useRef([]) // d3-force mutates these in place

  // Compute non-force layouts deterministically. Force layout is
  // handled by the effect below.
  useEffect(() => {
    if (layout === 'force' || w === 0) return undefined
    const cx = w / 2
    const cy = h / 2
    const pos = new Map()
    if (layout === 'circular') {
      const r = Math.min(w, h) / 2 - Math.max(nodeSizeMax, 30)
      sanitizedNodes.forEach((n, i) => {
        const theta = (i / Math.max(1, sanitizedNodes.length)) * Math.PI * 2
        pos.set(n.id, { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) })
      })
    } else if (layout === 'grid') {
      const count = sanitizedNodes.length
      const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
      const rows = Math.max(1, Math.ceil(count / cols))
      const stepX = (w - 2 * nodeSizeMax) / Math.max(1, cols - 1 || 1)
      const stepY = (h - 2 * nodeSizeMax) / Math.max(1, rows - 1 || 1)
      sanitizedNodes.forEach((n, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const x = cols === 1 ? cx : nodeSizeMax + col * stepX
        const y = rows === 1 ? cy : nodeSizeMax + row * stepY
        pos.set(n.id, { x, y })
      })
    } else if (layout === 'radial') {
      const groups = new Map()
      for (const n of sanitizedNodes) {
        const g = n.group || ''
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g).push(n)
      }
      const groupArr = [...groups.entries()].sort(
        (a, b) => b[1].length - a[1].length,
      )
      const maxR = Math.min(w, h) / 2 - Math.max(nodeSizeMax, 30)
      groupArr.forEach((entry, gi) => {
        const ring = groupArr.length === 1 ? maxR : (maxR * (gi + 1)) / groupArr.length
        const members = entry[1]
        members.forEach((n, i) => {
          const theta = (i / Math.max(1, members.length)) * Math.PI * 2
          pos.set(n.id, { x: cx + ring * Math.cos(theta), y: cy + ring * Math.sin(theta) })
        })
      })
    }
    posRef.current = pos
    setPosVersion((v) => v + 1)
  }, [layout, sanitizedNodes, w, h, nodeSizeMax])

  // Force simulation. Recreated when layout switches to 'force' or
  // when nodes/edges change. Saved positions seed the sim so a
  // reopened report doesn't re-shuffle.
  useEffect(() => {
    if (layout !== 'force' || w === 0) return undefined
    // Build mutable node objects d3-force can write x/y onto. Seed
    // from saved coords when present so re-mounts reproduce the
    // user-arranged layout.
    const live = sanitizedNodes.map((n) => {
      const seed = posRef.current.get(n.id)
      const sx = Number.isFinite(seed?.x)
        ? seed.x
        : Number.isFinite(n.x)
        ? n.x
        : w / 2 + (Math.random() - 0.5) * 80
      const sy = Number.isFinite(seed?.y)
        ? seed.y
        : Number.isFinite(n.y)
        ? n.y
        : h / 2 + (Math.random() - 0.5) * 80
      const r = radiusFor(n.value)
      return {
        id: n.id,
        x: sx,
        y: sy,
        r,
        // Pin nodes flagged as `fixed` so the sim keeps them in place.
        fx: n.fixed ? sx : null,
        fy: n.fixed ? sy : null,
      }
    })
    liveNodesRef.current = live
    // d3-force mutates the links array to swap string id refs for
    // node object refs. Use a fresh copy each run.
    const links = sanitizedEdges.map((e) => ({ ...e }))

    const sim = forceSimulation(live)
      .force(
        'link',
        forceLink(links)
          .id((d) => d.id)
          .distance((d) =>
            Number.isFinite(d?.weight) && d.weight > 0
              ? Math.max(20, linkDistance / d.weight)
              : linkDistance,
          ),
      )
      .force('charge', forceManyBody().strength(chargeStrength))
      .force('center', forceCenter(w / 2, h / 2))
      .force(
        'collide',
        forceCollide().radius((d) => d.r + 2),
      )
      .alpha(1)
      .alphaDecay(0.05)

    simRef.current = sim

    // Tick handler writes to posRef so React re-renders the SVG
    // through `posVersion` bumps. We bump on every tick — force
    // graphs are small enough (< 500 nodes) that the per-frame cost
    // is fine, and the d3-force engine already gates ticks via rAF.
    sim.on('tick', () => {
      const pos = new Map()
      for (const n of live) {
        pos.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy })
      }
      posRef.current = pos
      setPosVersion((v) => v + 1)
    })

    // When the sim cools, persist the final positions so a reload /
    // export sees the same layout. Read the persister through the ref
    // so the latest prop is invoked — using the closure variable here
    // would freeze in an old `content` snapshot and silently revert
    // unrelated edits (e.g. a node_shape toggle) on the next cool.
    sim.on('end', () => {
      const persist = persistRef.current
      if (!persist) return
      const out = new Map()
      for (const n of live) {
        const fixed = n.fx != null && n.fy != null
        out.set(n.id, { x: n.x, y: n.y, fixed })
      }
      persist(out)
    })

    return () => {
      sim.stop()
      sim.on('tick', null)
      sim.on('end', null)
      simRef.current = null
    }
    // Depend on the *structural* key (ids + endpoints) instead of the
    // sanitized arrays so the sim is preserved across position
    // persist cycles. Without this, every persist → content update →
    // new sanitizedNodes ref → effect re-run → sim recreate (alpha=1)
    // → another persist… the canvas would wiggle forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, structuralKey, w, h, linkDistance, chargeStrength])

  // ----- Pan / zoom transform ----- //
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 })
  const panRef = useRef(null)

  function onWheel(e) {
    if (!svgRef.current) return
    e.preventDefault()
    const rect = svgRef.current.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setView((cur) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const nextScale = Math.max(0.2, Math.min(4, cur.scale * factor))
      // Zoom toward pointer: keep the world-space point under the
      // cursor stationary by adjusting tx/ty around it.
      const wx = (px - cur.tx) / cur.scale
      const wy = (py - cur.ty) / cur.scale
      return {
        scale: nextScale,
        tx: px - wx * nextScale,
        ty: py - wy * nextScale,
      }
    })
  }
  function onBgPointerDown(e) {
    if (e.button !== 0) return
    e.preventDefault()
    panRef.current = { x: e.clientX, y: e.clientY, view }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onBgPointerMove(e) {
    if (!panRef.current) return
    const dx = e.clientX - panRef.current.x
    const dy = e.clientY - panRef.current.y
    setView({
      ...panRef.current.view,
      tx: panRef.current.view.tx + dx,
      ty: panRef.current.view.ty + dy,
    })
  }
  function onBgPointerUp(e) {
    if (!panRef.current) return
    panRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) { /* noop */ }
  }

  // ----- Node drag ----- //
  const dragRef = useRef(null)
  function clientToWorld(e) {
    const rect = svgRef.current.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale,
    }
  }
  function onNodePointerDown(e, nodeId) {
    if (readOnly) return
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const wp = clientToWorld(e)
    if (layout === 'force' && simRef.current) {
      const live = liveNodesRef.current.find((n) => n.id === nodeId)
      if (live) {
        live.fx = wp.x
        live.fy = wp.y
        simRef.current.alphaTarget(0.3).restart()
      }
    } else {
      // Static layouts: drag updates posRef directly.
      const cur = posRef.current.get(nodeId)
      if (cur) {
        posRef.current.set(nodeId, { ...cur, x: wp.x, y: wp.y })
        setPosVersion((v) => v + 1)
      }
    }
    dragRef.current = {
      id: nodeId,
      pointerId: e.pointerId,
      shiftKey: e.shiftKey,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onNodePointerMove(e) {
    if (!dragRef.current) return
    const wp = clientToWorld(e)
    const nodeId = dragRef.current.id
    if (layout === 'force' && simRef.current) {
      const live = liveNodesRef.current.find((n) => n.id === nodeId)
      if (live) {
        live.fx = wp.x
        live.fy = wp.y
      }
    } else {
      const cur = posRef.current.get(nodeId)
      if (cur) {
        posRef.current.set(nodeId, { ...cur, x: wp.x, y: wp.y })
        setPosVersion((v) => v + 1)
      }
    }
  }
  function onNodePointerUp(e) {
    if (!dragRef.current) return
    const { id, shiftKey, pointerId } = dragRef.current
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(pointerId) } catch (_) { /* noop */ }
    if (layout === 'force' && simRef.current) {
      const live = liveNodesRef.current.find((n) => n.id === id)
      if (live) {
        // Shift-release pins the node (fx/fy stay); plain release
        // unpins so the sim can re-relax around it.
        if (!shiftKey) {
          live.fx = null
          live.fy = null
        }
      }
      simRef.current.alphaTarget(0).alpha(0.1).restart()
    }
    // Persist current position immediately (drag-end checkpoint),
    // marking the node fixed when the user shift-released.
    if (onPersistPositions) {
      const out = new Map()
      if (layout === 'force' && simRef.current) {
        for (const n of liveNodesRef.current) {
          out.set(n.id, {
            x: n.x,
            y: n.y,
            fixed: n.fx != null && n.fy != null,
          })
        }
      } else {
        for (const [nid, p] of posRef.current.entries()) {
          out.set(nid, { x: p.x, y: p.y })
        }
      }
      onPersistPositions(out)
    }
  }

  // ----- Hover highlight ----- //
  const [hoverId, setHoverId] = useState(null)
  // Adjacency: id → Set<neighbour id>. Used to decide which nodes
  // and edges keep full opacity while hovering.
  const adjacency = useMemo(() => {
    const m = new Map()
    for (const n of sanitizedNodes) m.set(n.id, new Set())
    for (const e of sanitizedEdges) {
      m.get(e.source)?.add(e.target)
      m.get(e.target)?.add(e.source)
    }
    return m
  }, [sanitizedNodes, sanitizedEdges])

  function nodeOpacity(id) {
    if (!hoverId) return 1
    if (id === hoverId) return 1
    return adjacency.get(hoverId)?.has(id) ? 1 : 0.18
  }
  function edgeOpacity(edge) {
    if (!hoverId) return 1
    return edge.source === hoverId || edge.target === hoverId ? 1 : 0.12
  }

  // posVersion just exists to trigger re-render. We use it implicitly
  // by reading posRef.current.
  void posVersion

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
      {size.w > 0 && sanitizedNodes.length > 0 ? (
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h || size.w}
          viewBox={`0 0 ${size.w} ${size.h || size.w}`}
          style={{ display: 'block', cursor: panRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
          onWheel={onWheel}
          onPointerDown={onBgPointerDown}
          onPointerMove={onBgPointerMove}
          onPointerUp={onBgPointerUp}
          onPointerCancel={onBgPointerUp}
        >
          <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
            {/* Edges first so nodes draw on top.
                Arrowheads are rendered as explicit triangle paths
                rather than via SVG <marker> + marker-end. Markers are
                the spec-correct approach but are flaky in practice:
                `url(#id)` fragment refs sometimes fail to resolve
                inside SPA routes, and `markerUnits="userSpaceOnUse"`
                combined with a parent <g transform> + viewBox can
                collapse to zero size in some renderers. Explicit
                paths share the line's transform / color / opacity
                trivially and need no global state. */}
            <g>
              {sanitizedEdges.map((e, i) => {
                const s = posRef.current.get(e.source)
                const t = posRef.current.get(e.target)
                if (!s || !t) return null
                const isDirected = e.directed === true || (e.directed == null && directed)
                const strokeWidth =
                  Number.isFinite(e.weight) && e.weight > 0
                    ? Math.min(5, 1 + Math.log10(1 + e.weight))
                    : 1.2
                // Pull the endpoint back by the target node radius so
                // the arrowhead sits at the node boundary, not inside it.
                let x2 = t.x
                let y2 = t.y
                let ux = 0
                let uy = 0
                let lineLen = 0
                if (isDirected) {
                  const tNode = sanitizedNodes.find((n) => n.id === e.target)
                  const tr = radiusFor(tNode?.value) + 2
                  const dx = t.x - s.x
                  const dy = t.y - s.y
                  lineLen = Math.sqrt(dx * dx + dy * dy)
                  if (lineLen > 0.001) {
                    ux = dx / lineLen
                    uy = dy / lineLen
                    x2 = t.x - ux * tr
                    y2 = t.y - uy * tr
                  }
                }
                const edgeColor = e.color || '#94a3b8'
                // Arrowhead geometry: an isoceles triangle with tip at
                // (x2, y2) pointing along the line direction. Base
                // corners are `arrowLen` units back along the line
                // and `arrowHalfWidth` perpendicular each side. Drawn
                // only when the line is long enough that the arrow
                // wouldn't reach back past the source node.
                let arrowPath = null
                if (isDirected && lineLen > 0.001) {
                  const arrowLen = 12
                  const arrowHalfWidth = 5
                  const bx = x2 - ux * arrowLen
                  const by = y2 - uy * arrowLen
                  // Perpendicular to (ux, uy):
                  const perpX = -uy
                  const perpY = ux
                  const lx = bx + perpX * arrowHalfWidth
                  const ly = by + perpY * arrowHalfWidth
                  const rx = bx - perpX * arrowHalfWidth
                  const ry = by - perpY * arrowHalfWidth
                  arrowPath = `M${x2.toFixed(2)},${y2.toFixed(2)} L${lx.toFixed(2)},${ly.toFixed(2)} L${rx.toFixed(2)},${ry.toFixed(2)} Z`
                }
                return (
                  <g key={i} style={{ opacity: edgeOpacity(e) }}>
                    <line
                      x1={s.x}
                      y1={s.y}
                      x2={x2}
                      y2={y2}
                      stroke={edgeColor}
                      strokeWidth={strokeWidth}
                    />
                    {arrowPath && (
                      <path d={arrowPath} fill={edgeColor} stroke="none" />
                    )}
                    {showEdgeLabels && e.label && (
                      <text
                        x={(s.x + x2) / 2}
                        y={(s.y + y2) / 2 - 4}
                        textAnchor="middle"
                        fontSize={10}
                        fill="#64748b"
                        style={{ pointerEvents: 'none' }}
                      >
                        {e.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
            {/* Nodes */}
            <g>
              {sanitizedNodes.map((n) => {
                const p = posRef.current.get(n.id)
                if (!p) return null
                const color = n.color || groupColor(n.group)
                const r = radiusFor(n.value)
                const label = n.label || n.id
                const isPinned = p.fx != null && p.fy != null
                const opacity = nodeOpacity(n.id)
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    style={{ opacity, cursor: readOnly ? 'default' : 'grab' }}
                    onPointerDown={(e) => onNodePointerDown(e, n.id)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={onNodePointerUp}
                    onPointerCancel={onNodePointerUp}
                    onMouseEnter={() => setHoverId(n.id)}
                    onMouseLeave={() => setHoverId((cur) => (cur === n.id ? null : cur))}
                  >
                    {nodeShape === 'rect' ? (
                      <rect
                        x={-r}
                        y={-r * 0.7}
                        width={r * 2}
                        height={r * 1.4}
                        rx={3}
                        fill={color}
                        stroke={isPinned ? '#1f2937' : '#ffffff'}
                        strokeWidth={isPinned ? 2 : 1.5}
                      />
                    ) : (
                      <circle
                        r={r}
                        fill={color}
                        stroke={isPinned ? '#1f2937' : '#ffffff'}
                        strokeWidth={isPinned ? 2 : 1.5}
                      />
                    )}
                    {showLabels && (
                      <text
                        x={0}
                        y={r + 11}
                        textAnchor="middle"
                        fontSize={11}
                        fontWeight={500}
                        fill="#1f2937"
                        style={{ pointerEvents: 'none' }}
                      >
                        {label}
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
          노드를 추가하면 네트워크가 표시됩니다
        </div>
      )}
      {!readOnly && layout === 'force' && (
        <div className="absolute bottom-1 right-2 text-[9px] text-muted-foreground/80 pointer-events-none">
          드래그 = 이동 · Shift+드래그 종료 = 고정 · 휠 = 줌
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// TSV paste helpers                                                             //
// --------------------------------------------------------------------------- //

function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}

function pasteNodes(startRowIdx, startField, text, currentNodes, write) {
  const grid = parseTsv(text)
  if (grid.length === 0) return
  let body = grid
  const firstLower = (grid[0] || []).map((s) =>
    String(s ?? '').trim().toLowerCase(),
  )
  const headerHit = firstLower.some((s) =>
    ['id', 'label', 'group', 'value', 'color'].includes(s),
  )
  if (headerHit && grid.length > 1) body = grid.slice(1)
  if (body.length === 0) return
  const fieldOrder = ['id', 'label', 'group', 'value', 'color']
  const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
  const next = [...currentNodes]
  const needRows = startRowIdx + body.length
  while (next.length < needRows) next.push({ id: '', label: '' })
  for (let r = 0; r < body.length; r += 1) {
    const target = { ...(next[startRowIdx + r] ?? { id: '' }) }
    for (let c = 0; c < body[r].length; c += 1) {
      const fieldIdx = startFieldIdx + c
      if (fieldIdx >= fieldOrder.length) break
      const field = fieldOrder[fieldIdx]
      const raw = String(body[r][c] ?? '').trim()
      if (field === 'value') {
        target.value = raw === '' ? undefined : Number(raw)
      } else {
        target[field] = raw
      }
    }
    next[startRowIdx + r] = target
  }
  write(next)
}

function pasteEdges(startRowIdx, startField, text, currentEdges, write) {
  const grid = parseTsv(text)
  if (grid.length === 0) return
  let body = grid
  const firstLower = (grid[0] || []).map((s) =>
    String(s ?? '').trim().toLowerCase(),
  )
  const headerHit = firstLower.some((s) =>
    ['source', 'target', 'weight', 'label', 'directed', 'color'].includes(s),
  )
  if (headerHit && grid.length > 1) body = grid.slice(1)
  if (body.length === 0) return
  const fieldOrder = ['source', 'target', 'weight', 'label', 'directed', 'color']
  const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
  const next = [...currentEdges]
  const needRows = startRowIdx + body.length
  while (next.length < needRows) next.push({ source: '', target: '' })
  for (let r = 0; r < body.length; r += 1) {
    const target = { ...(next[startRowIdx + r] ?? { source: '', target: '' }) }
    for (let c = 0; c < body[r].length; c += 1) {
      const fieldIdx = startFieldIdx + c
      if (fieldIdx >= fieldOrder.length) break
      const field = fieldOrder[fieldIdx]
      const raw = String(body[r][c] ?? '').trim()
      if (field === 'weight') {
        target.weight = raw === '' ? undefined : Number(raw)
      } else if (field === 'directed') {
        if (raw === '') target.directed = undefined
        else if (raw.toLowerCase() === 'true') target.directed = true
        else if (raw.toLowerCase() === 'false') target.directed = false
      } else {
        target[field] = raw
      }
    }
    next[startRowIdx + r] = target
  }
  write(next)
}
