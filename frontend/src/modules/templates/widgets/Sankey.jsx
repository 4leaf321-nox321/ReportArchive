/**
 * Sankey diagram widget — flow / transition / proportion-over-stages.
 *
 * Hybrid data model intentionally optimized for the common case:
 *
 *   links: [{source, target, value, color?}]   — required, 1차 시민
 *   nodes: [{label, color?}]                   — 선택, 노드 색/명시 라벨 override 용
 *
 * Trivial sankeys ("just type the flows") fit in a single rows table —
 * `nodes` stays empty and is derived from the union of link endpoints in
 * first-appearance order (matches what Plotly's `type: 'sankey'` needs).
 * Power users who want per-node colors or explicit ordering fill the
 * smaller secondary table.
 *
 * Self-loops (source === target) and links with non-positive value are
 * silently dropped before the trace is built — Plotly's sankey trace
 * can't render either cleanly, and surfacing the rejection would be
 * noise during quick iteration.
 *
 * Pattern follows Pie/Treemap: split pane (canvas left, tables right),
 * toolbar across the top, ResizeObserver + 200ms idle debounce to
 * suspend Plotly.react during RGL drags, Plotly.purge on unmount.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import Plotly from 'plotly.js-dist'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  CaptionInput,
  DataTableActions,
  LabelField,
  PreviewLabel,
  captionPositionOf,
  captionSkipProps,
  toTsv,
} from './_shared'

// --------------------------------------------------------------------------- //
// Constants                                                                     //
// --------------------------------------------------------------------------- //

const ARRANGEMENT_OPTIONS = [
  { value: 'snap', label: '스냅 (자동 정렬)' },
  { value: 'perpendicular', label: '직각' },
  { value: 'freeform', label: '자유 배치' },
  { value: 'fixed', label: '고정' },
]

const DEFAULT_LINKS = [
  { source: '수입', target: '고정비', value: 300 },
  { source: '수입', target: '변동비', value: 200 },
  { source: '수입', target: '저축', value: 500 },
  { source: '고정비', target: '주거', value: 180 },
  { source: '고정비', target: '통신', value: 60 },
  { source: '고정비', target: '보험', value: 60 },
]

// Categorical fallback palette — matches Pie/Treemap so the visual
// language stays consistent across the proportion widgets. Used to color
// nodes that haven't been overridden in the `nodes` table.
const NODE_FALLBACK_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#64748b',
]

// Default link tint — soft slate so the bands don't dominate over the
// node columns. Per-link color or source-node-tinted derivation can
// override this on a row-by-row basis.
const DEFAULT_LINK_COLOR = 'rgba(148, 163, 184, 0.45)'

// --------------------------------------------------------------------------- //
// Color helpers                                                                 //
// --------------------------------------------------------------------------- //

/** Hex (#rrggbb) → rgba string with the given alpha. Returns the input
 *  untouched if it isn't a 6-digit hex (already-rgba / named CSS colors
 *  fall through). */
function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return hex
  const m = hex.match(/^#([0-9a-fA-F]{6})$/)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function SankeyPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="자금 흐름"
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function SankeyPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="Sankey 다이어그램">{props.label || '(라벨 없음)'}</PreviewLabel>
      <div className="aspect-video rounded-md border border-dashed bg-muted/20 p-2 flex items-center justify-center">
        <svg viewBox="0 0 120 60" className="w-full h-full">
          {/* Left column nodes */}
          <rect x="6" y="8" width="6" height="18" fill="#6366f1" />
          <rect x="6" y="34" width="6" height="18" fill="#10b981" />
          {/* Right column nodes */}
          <rect x="108" y="6" width="6" height="14" fill="#f59e0b" />
          <rect x="108" y="24" width="6" height="14" fill="#ef4444" />
          <rect x="108" y="42" width="6" height="12" fill="#06b6d4" />
          {/* Flow bands (rough bezier) */}
          <path d="M12 12 C 60 12 60 10 108 10" stroke="rgba(99,102,241,0.45)" strokeWidth="6" fill="none" />
          <path d="M12 20 C 60 20 60 28 108 28" stroke="rgba(99,102,241,0.35)" strokeWidth="5" fill="none" />
          <path d="M12 38 C 60 38 60 32 108 32" stroke="rgba(16,185,129,0.45)" strokeWidth="5" fill="none" />
          <path d="M12 48 C 60 48 60 48 108 48" stroke="rgba(16,185,129,0.35)" strokeWidth="6" fill="none" />
        </svg>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function SankeyEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const capPos = captionPositionOf(content)

  const links = useMemo(
    () =>
      Array.isArray(content?.links) && content.links.length > 0
        ? content.links
        : DEFAULT_LINKS,
    [content?.links],
  )
  const nodes = useMemo(
    () => (Array.isArray(content?.nodes) ? content.nodes : []),
    [content?.nodes],
  )

  const arrangement =
    content?.arrangement ?? props?.arrangement ?? 'snap'
  const nodePad = Number.isFinite(content?.node_pad)
    ? content.node_pad
    : Number.isFinite(props?.node_pad)
      ? props.node_pad
      : 16
  const nodeThickness = Number.isFinite(content?.node_thickness)
    ? content.node_thickness
    : Number.isFinite(props?.node_thickness)
      ? props.node_thickness
      : 18
  const unit = content?.unit ?? props?.unit ?? ''

  function patch(next) {
    const merged = { ...(content ?? {}), links, nodes, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.unit) delete merged.unit
    if (!merged.arrangement || merged.arrangement === 'snap') {
      delete merged.arrangement
    }
    if (!Number.isFinite(merged.node_pad) || merged.node_pad === 16) {
      delete merged.node_pad
    }
    if (!Number.isFinite(merged.node_thickness) || merged.node_thickness === 18) {
      delete merged.node_thickness
    }
    if (Array.isArray(merged.links) && merged.links.length === 0) {
      delete merged.links
    }
    if (Array.isArray(merged.nodes) && merged.nodes.length === 0) {
      delete merged.nodes
    }
    onChange(merged)
  }

  // --- Links table actions -------------------------------------------------- //
  function setLinkCell(idx, field, value) {
    const next = links.map((r, i) => {
      if (i !== idx) return r
      if (field === 'value') {
        const n = value === '' || value == null ? null : Number(value)
        return { ...r, value: Number.isFinite(n) ? n : null }
      }
      return { ...r, [field]: value }
    })
    patch({ links: next })
  }
  function addLink() {
    patch({ links: [...links, { source: '', target: '', value: null }] })
  }
  function removeLink(idx) {
    if (links.length <= 1) return
    patch({ links: links.filter((_, i) => i !== idx) })
  }
  function pasteAtLinks(startRowIdx, startField, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    let body = grid
    const firstLower = (grid[0] || []).map((s) =>
      String(s ?? '').trim().toLowerCase(),
    )
    const headerHit = firstLower.some((s) =>
      ['source', 'target', 'value', 'color', '출발', '도착', '값', '색상', '시작', '끝'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['source', 'target', 'value', 'color']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...links]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ source: '', target: '', value: null })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = {
        ...(nextRows[startRowIdx + r] ?? { source: '', target: '', value: null }),
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
    patch({ links: nextRows })
  }

  // --- Nodes (override) table actions -------------------------------------- //
  function setNodeCell(idx, field, value) {
    const next = nodes.map((n, i) => (i === idx ? { ...n, [field]: value } : n))
    patch({ nodes: next })
  }
  function addNode() {
    patch({ nodes: [...nodes, { label: '', color: '' }] })
  }
  function removeNode(idx) {
    patch({ nodes: nodes.filter((_, i) => i !== idx) })
  }
  function pasteAtNodes(startRowIdx, startField, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    let body = grid
    const firstLower = (grid[0] || []).map((s) =>
      String(s ?? '').trim().toLowerCase(),
    )
    const headerHit = firstLower.some((s) =>
      ['label', 'color', '라벨', '이름', '색상'].includes(s),
    )
    if (headerHit && grid.length > 1) body = grid.slice(1)
    if (body.length === 0) return

    const fieldOrder = ['label', 'color']
    const startFieldIdx = Math.max(0, fieldOrder.indexOf(startField))
    const nextRows = [...nodes]
    const needRows = startRowIdx + body.length
    while (nextRows.length < needRows) {
      nextRows.push({ label: '', color: '' })
    }
    for (let r = 0; r < body.length; r += 1) {
      const target = { ...(nextRows[startRowIdx + r] ?? { label: '', color: '' }) }
      for (let c = 0; c < body[r].length; c += 1) {
        const fieldIdx = startFieldIdx + c
        if (fieldIdx >= fieldOrder.length) break
        const field = fieldOrder[fieldIdx]
        target[field] = String(body[r][c] ?? '').trim()
      }
      nextRows[startRowIdx + r] = target
    }
    patch({ nodes: nextRows })
  }

  // --- Read-only render ----------------------------------------------------- //
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
          <SankeyCanvas
            links={links}
            nodes={nodes}
            arrangement={arrangement}
            nodePad={nodePad}
            nodeThickness={nodeThickness}
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

  // --- Edit render ---------------------------------------------------------- //
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
          <span className="text-muted-foreground">정렬:</span>
          <select
            value={arrangement}
            onChange={(e) => patch({ arrangement: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {ARRANGEMENT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1" title="노드 사이 간격 (px)">
          <span className="text-muted-foreground">노드 간격:</span>
          <Input
            type="number"
            min={0}
            max={100}
            value={nodePad}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ node_pad: Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 16 })
            }}
            className="h-7 w-16 text-xs"
          />
        </div>
        <div className="flex items-center gap-1" title="노드 막대 두께 (px)">
          <span className="text-muted-foreground">노드 두께:</span>
          <Input
            type="number"
            min={4}
            max={80}
            value={nodeThickness}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({
                node_thickness: Number.isFinite(v) ? Math.max(4, Math.min(80, v)) : 18,
              })
            }}
            className="h-7 w-16 text-xs"
          />
        </div>
        <div className="flex items-center gap-1" title="값 옆에 붙는 단위 (예: 억원, MW, 명)">
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
          <SankeyCanvas
            links={links}
            nodes={nodes}
            arrangement={arrangement}
            nodePad={nodePad}
            nodeThickness={nodeThickness}
            unit={unit}
            autoFit={false}
          />
        </div>

        <div className="min-h-0 overflow-y-auto pr-1 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
              <div className="text-xs font-semibold text-muted-foreground">흐름 (links)</div>
              <DataTableActions
                label="Sankey 흐름 데이터"
                onCopy={() => {
                  const header = ['source', 'target', 'value', 'color']
                  const body = links.map((r) => [
                    r?.source ?? '',
                    r?.target ?? '',
                    r?.value ?? '',
                    r?.color ?? '',
                  ])
                  return toTsv([header, ...body])
                }}
                onClear={() => patch({ links: [] })}
              />
            </div>
            <SankeyLinksTable
              rows={links}
              onCellChange={setLinkCell}
              onAdd={addLink}
              onRemove={removeLink}
              onMultiPaste={pasteAtLinks}
            />
            <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
              source · target 은 노드 이름. 같은 쌍을 여러 번 적으면 두 번째 흐름으로 별도
              표시됩니다. value 가 비어있거나 0 이하인 행, source 와 target 이 같은 행은 자동
              제외. color 는 hex/CSS (선택). 엑셀 TSV 붙여넣기 지원.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
              <div className="text-xs font-semibold text-muted-foreground">
                노드 색 / 라벨 override (선택)
              </div>
              <DataTableActions
                label="Sankey 노드 메타"
                onCopy={() => {
                  const header = ['label', 'color']
                  const body = nodes.map((n) => [n?.label ?? '', n?.color ?? ''])
                  return toTsv([header, ...body])
                }}
                onClear={() => patch({ nodes: [] })}
              />
            </div>
            <SankeyNodesTable
              rows={nodes}
              onCellChange={setNodeCell}
              onAdd={addNode}
              onRemove={removeNode}
              onMultiPaste={pasteAtNodes}
            />
            <p className="text-[10px] text-muted-foreground italic mt-1 px-1">
              비워두면 흐름에서 자동으로 만들어집니다 (등장 순서대로 팔레트 색).
              여기 적은 label 은 흐름 표의 source/target 과 정확히 일치해야 적용됩니다.
            </p>
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

// --------------------------------------------------------------------------- //
// Tables                                                                        //
// --------------------------------------------------------------------------- //

function SankeyLinksTable({ rows, onCellChange, onAdd, onRemove, onMultiPaste }) {
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
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">source</th>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">target</th>
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
                  value={row?.source ?? ''}
                  onChange={(e) => onCellChange(ri, 'source', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'source')}
                  className="h-7 w-full text-[11px] border-0"
                />
              </td>
              <td className="border border-muted p-0">
                <Input
                  value={row?.target ?? ''}
                  onChange={(e) => onCellChange(ri, 'target', e.target.value)}
                  onPaste={(e) => handlePaste(e, ri, 'target')}
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
                  placeholder="(source 색)"
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

function SankeyNodesTable({ rows, onCellChange, onAdd, onRemove, onMultiPaste }) {
  function handlePaste(e, ri, field) {
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onMultiPaste?.(ri, field, text)
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/10 px-2 py-3 text-center">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAdd}>
          <Plus className="h-3 w-3 mr-1" /> 노드 override 추가
        </Button>
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr>
            <th className="border border-muted bg-muted/30 px-2 py-1 text-center font-medium">label</th>
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
                  onClick={() => onRemove(ri)}
                  title="행 삭제"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} className="text-center pt-1">
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
// Canvas (Plotly)                                                               //
// --------------------------------------------------------------------------- //

function SankeyCanvas({
  links,
  nodes,
  arrangement = 'snap',
  nodePad = 16,
  nodeThickness = 18,
  unit = '',
  autoFit = true,
}) {
  const containerRef = useRef(null)
  const [size, setSize] = useState(null)
  const [resizing, setResizing] = useState(false)
  const resizeTimerRef = useRef(null)

  // Drop self-loops, missing endpoints, non-positive values up front —
  // Plotly's sankey trace can't render any of these and forwarding them
  // either crashes the trace or shows degenerate bands.
  const safeLinks = useMemo(
    () =>
      (links ?? []).filter((l) => {
        const s = (l?.source ?? '').toString().trim()
        const t = (l?.target ?? '').toString().trim()
        if (!s || !t || s === t) return false
        if (!Number.isFinite(l?.value) || l.value <= 0) return false
        return true
      }),
    [links],
  )

  // Build the node table (label + color), keeping first-appearance
  // order so the column ordering is predictable. Overrides from the
  // `nodes` table are applied by label match — labels not present in
  // any link are still added (they show as isolated columns).
  const { plotlyNodes, indexByLabel } = useMemo(() => {
    const order = []
    const seen = new Set()
    const push = (label) => {
      if (!label || seen.has(label)) return
      seen.add(label)
      order.push(label)
    }
    for (const l of safeLinks) {
      push(String(l.source).trim())
      push(String(l.target).trim())
    }
    // Then include any extra `nodes` overrides whose label isn't tied to
    // a link (rare but keep them addressable).
    for (const n of nodes ?? []) {
      const lbl = (n?.label ?? '').toString().trim()
      if (lbl) push(lbl)
    }
    const overrideByLabel = new Map()
    for (const n of nodes ?? []) {
      const lbl = (n?.label ?? '').toString().trim()
      if (!lbl) continue
      overrideByLabel.set(lbl, n)
    }
    const colors = order.map(
      (lbl, i) =>
        (overrideByLabel.get(lbl)?.color || '').trim() ||
        NODE_FALLBACK_PALETTE[i % NODE_FALLBACK_PALETTE.length],
    )
    const idx = new Map()
    order.forEach((lbl, i) => idx.set(lbl, i))
    return {
      plotlyNodes: { labels: order, colors },
      indexByLabel: idx,
    }
  }, [safeLinks, nodes])

  // Resize burst suspend — same pattern as Pie/Heatmap/Treemap.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    let firstCall = true
    const measure = () => {
      const w = el.clientWidth
      if (w <= 0) return
      const next = autoFit ? Math.max(260, Math.min(960, w)) : w
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

  // Build & render the Plotly trace.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !size) return undefined
    if (resizing) return undefined

    if (safeLinks.length === 0) {
      Plotly.react(
        el,
        [],
        { autosize: true, margin: { l: 0, r: 0, t: 0, b: 0 } },
        { displaylogo: false },
      )
      return undefined
    }

    const sourceIdx = []
    const targetIdx = []
    const values = []
    const linkColors = []
    for (const l of safeLinks) {
      const s = indexByLabel.get(String(l.source).trim())
      const t = indexByLabel.get(String(l.target).trim())
      if (s == null || t == null) continue
      sourceIdx.push(s)
      targetIdx.push(t)
      values.push(l.value)
      const explicit = (l.color || '').trim()
      // Per-link override > source-node tint > neutral fallback. Tinting
      // by source node makes flows from the same origin visually
      // grouped without forcing the writer to enter a color per row.
      if (explicit) {
        linkColors.push(explicit)
      } else {
        const sourceColor = plotlyNodes.colors[s]
        linkColors.push(hexToRgba(sourceColor, 0.4) || DEFAULT_LINK_COLOR)
      }
    }

    const u = unit ? ` ${unit}` : ''
    const trace = {
      type: 'sankey',
      arrangement,
      orientation: 'h',
      valueformat: ',.4~r',
      valuesuffix: u,
      node: {
        label: plotlyNodes.labels,
        color: plotlyNodes.colors,
        pad: nodePad,
        thickness: nodeThickness,
        line: { color: 'rgba(15, 23, 42, 0.25)', width: 0.5 },
        hovertemplate:
          `<b>%{label}</b><br>유입+유출 합계: %{value}${u}<extra></extra>`,
      },
      link: {
        source: sourceIdx,
        target: targetIdx,
        value: values,
        color: linkColors,
        hovertemplate:
          `<b>%{source.label} → %{target.label}</b><br>값: %{value}${u}<extra></extra>`,
      },
    }
    const layout = {
      autosize: true,
      margin: { l: 8, r: 8, t: 8, b: 8 },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      font: { size: 12 },
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
    Plotly.react(el, [trace], layout, config)
    return undefined
  }, [
    safeLinks,
    plotlyNodes,
    indexByLabel,
    arrangement,
    nodePad,
    nodeThickness,
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
