import { useMemo } from 'react'

/**
 * Pure rendering of an annotation array on top of a host widget's
 * canvas. Lives as an SVG overlay that sits over (and slightly extends
 * past) the host canvas — the host widget hands us a coordinate
 * adapter that knows how to translate annotation geometry into pixel
 * coordinates relative to the layer's own box.
 *
 * Phase A: rendering only — no creation / selection / drag. The store
 * still drives what's drawn so future interaction phases can layer in
 * without changing the host integration.
 *
 *   <AnnotationLayer
 *     annotations={store.annotations}
 *     adapter={chartAdapter}
 *     selectedIds={store.selectedIds}
 *     onSelect={(id, additive) => store.setSelected(id, { additive })}
 *   />
 *
 * The adapter contract (see types in jsdoc below):
 *   toPx(geometry)        → object mapping the same field names to pixels
 *   bounds                → { x, y, width, height } of the drawable area
 *   supportedTypes        → array of type names the host knows how to anchor
 *   coordSpace            → 'data' / 'image_pct' / etc.
 *
 * The component is intentionally type-agnostic: it dispatches per
 * annotation.type to small drawer functions below. Adding a new type
 * = one entry in the dispatch + one drawer.
 */
export function AnnotationLayer({
  annotations,
  adapter,
  selectedIds,
  onSelect,
  readOnly = false,
}) {
  // Drop hidden + unsupported annotations before rendering. We accept
  // "unsupported" gracefully so a payload with an arrow annotation
  // still loads on a host that only supports lines — it just doesn't
  // draw those, never breaks the layer.
  const drawable = useMemo(() => {
    if (!Array.isArray(annotations) || !adapter) return []
    const supported = new Set(adapter.supportedTypes ?? [])
    return annotations.filter(
      (a) => !a.hidden && (supported.size === 0 || supported.has(a.type)),
    )
  }, [annotations, adapter])

  if (!adapter) return null
  const { x: bx, y: by, width: bw, height: bh } = adapter.bounds ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }
  if (bw <= 0 || bh <= 0) return null

  function handleClick(e, id) {
    if (readOnly) return
    e.stopPropagation()
    onSelect?.(id, { additive: e.shiftKey })
  }

  return (
    <svg
      // `pointer-events: none` on the SVG itself + `auto` on each shape
      // so clicks outside any annotation pass through to the host
      // widget (chart bars, image, etc.) unaffected.
      className="report-annotation-layer absolute inset-0 pointer-events-none"
      width={bw + bx * 2}
      height={bh + by * 2}
      aria-hidden={readOnly ? 'true' : undefined}
    >
      <AnnotationContents
        drawable={drawable}
        adapter={adapter}
        selectedIds={selectedIds}
        readOnly={readOnly}
        onSelect={onSelect}
      />
    </svg>
  )
}

/**
 * Inner rendering loop — pulled out so callers that already own an
 * <svg> (e.g. Recharts' Customized component, which renders inside the
 * chart's own SVG) can drop annotations into their existing tree
 * without nesting an extra <svg>.
 *
 *   <Customized component={(rcProps) => (
 *     <AnnotationContents
 *       drawable={annotations}
 *       adapter={chartAdapter}
 *       selectedIds={...}
 *       onSelect={...}
 *     />
 *   )} />
 */
export function AnnotationContents({
  drawable,
  adapter,
  selectedIds,
  readOnly,
  onSelect,
}) {
  if (!adapter) return null
  const bounds = adapter.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  function handleClick(e, id) {
    if (readOnly) return
    e.stopPropagation()
    onSelect?.(id, { additive: e.shiftKey })
  }
  return (
    <>
      {(drawable ?? []).map((a) => {
        const selected = selectedIds?.has(a.id) ?? false
        const draw = DRAWERS[a.type]
        if (!draw) return null
        return draw({
          key: a.id,
          annotation: a,
          adapter,
          bounds,
          selected,
          locked: !!a.locked,
          onClick: (e) => handleClick(e, a.id),
        })
      })}
    </>
  )
}

// --------------------------------------------------------------------------- //
// Per-type drawers.                                                            //
// Each is a tiny function that produces an <g> element. They share a few       //
// style helpers so the look stays consistent across types.                     //
// --------------------------------------------------------------------------- //

function resolveColor(a, fallback = '#6b7280') {
  return a.style?.color || fallback
}
function resolveOpacity(a, fallback) {
  return typeof a.style?.opacity === 'number' ? a.style.opacity : fallback
}
function resolveDash(a) {
  if (a.style?.border === 'dashed') return '6,4'
  if (a.style?.border === 'dotted') return '2,3'
  return undefined
}
function selectionRingProps(selected) {
  return selected
    ? { stroke: '#2563eb', strokeWidth: 1.5, strokeDasharray: '3,3' }
    : null
}

const DRAWERS = {
  vline({ key, annotation: a, adapter, bounds, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.x)) return null
    const color = resolveColor(a)
    const dash = resolveDash(a)
    const top = bounds.y
    const bot = bounds.y + bounds.height
    return (
      <g key={key} className="annotation annotation-vline" data-annotation-id={a.id}>
        {/* The wide invisible hitbox makes thin lines clickable. */}
        <line
          x1={px.x}
          y1={top}
          x2={px.x}
          y2={bot}
          stroke="transparent"
          strokeWidth={10}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={onClick}
        />
        <line
          x1={px.x}
          y1={top}
          x2={px.x}
          y2={bot}
          stroke={color}
          strokeWidth={selected ? 2.5 : 1.5}
          strokeDasharray={dash}
          opacity={resolveOpacity(a, 0.9)}
        />
        <AnnotationLabel
          annotation={a}
          x={px.x}
          y={top}
          color={color}
          anchor="middle"
        />
        {selected && (
          <circle
            cx={px.x}
            cy={(top + bot) / 2}
            r={3}
            fill={color}
            {...selectionRingProps(true)}
          />
        )}
      </g>
    )
  },

  hline({ key, annotation: a, adapter, bounds, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.y)) return null
    const color = resolveColor(a)
    const dash = resolveDash(a)
    const left = bounds.x
    const right = bounds.x + bounds.width
    return (
      <g key={key} className="annotation annotation-hline" data-annotation-id={a.id}>
        <line
          x1={left}
          y1={px.y}
          x2={right}
          y2={px.y}
          stroke="transparent"
          strokeWidth={10}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={onClick}
        />
        <line
          x1={left}
          y1={px.y}
          x2={right}
          y2={px.y}
          stroke={color}
          strokeWidth={selected ? 2.5 : 1.5}
          strokeDasharray={dash}
          opacity={resolveOpacity(a, 0.9)}
        />
        <AnnotationLabel
          annotation={a}
          x={right}
          y={px.y}
          color={color}
          anchor="end"
          dy={-4}
        />
      </g>
    )
  },

  vrange({ key, annotation: a, adapter, bounds, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.x_from) || !Number.isFinite(px?.x_to)) return null
    const left = Math.min(px.x_from, px.x_to)
    const right = Math.max(px.x_from, px.x_to)
    const color = resolveColor(a)
    return (
      <g key={key} className="annotation annotation-vrange" data-annotation-id={a.id}>
        <rect
          x={left}
          y={bounds.y}
          width={Math.max(1, right - left)}
          height={bounds.height}
          fill={color}
          opacity={resolveOpacity(a, 0.12)}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={onClick}
        />
        {/* Edge lines — selected state thickens them. */}
        <line
          x1={left}
          y1={bounds.y}
          x2={left}
          y2={bounds.y + bounds.height}
          stroke={color}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray={resolveDash(a)}
          opacity={0.7}
        />
        <line
          x1={right}
          y1={bounds.y}
          x2={right}
          y2={bounds.y + bounds.height}
          stroke={color}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray={resolveDash(a)}
          opacity={0.7}
        />
        <AnnotationLabel
          annotation={a}
          x={(left + right) / 2}
          y={bounds.y}
          color={color}
          anchor="middle"
        />
      </g>
    )
  },

  hrange({ key, annotation: a, adapter, bounds, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.y_from) || !Number.isFinite(px?.y_to)) return null
    const top = Math.min(px.y_from, px.y_to)
    const bot = Math.max(px.y_from, px.y_to)
    const color = resolveColor(a)
    return (
      <g key={key} className="annotation annotation-hrange" data-annotation-id={a.id}>
        <rect
          x={bounds.x}
          y={top}
          width={bounds.width}
          height={Math.max(1, bot - top)}
          fill={color}
          opacity={resolveOpacity(a, 0.12)}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={onClick}
        />
        <AnnotationLabel
          annotation={a}
          x={bounds.x + bounds.width}
          y={(top + bot) / 2}
          color={color}
          anchor="end"
          dy={4}
        />
      </g>
    )
  },

  point({ key, annotation: a, adapter, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.x) || !Number.isFinite(px?.y)) return null
    const color = resolveColor(a, '#ef4444')
    return (
      <g key={key} className="annotation annotation-point" data-annotation-id={a.id}>
        <circle
          cx={px.x}
          cy={px.y}
          r={selected ? 7 : 5}
          fill={color}
          stroke="#fff"
          strokeWidth={2}
          opacity={resolveOpacity(a, 0.95)}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={onClick}
        />
        <AnnotationLabel
          annotation={a}
          x={px.x}
          y={px.y - 10}
          color={color}
          anchor="middle"
        />
      </g>
    )
  },

  rect({ key, annotation: a, adapter, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (
      !Number.isFinite(px?.x_from) ||
      !Number.isFinite(px?.x_to) ||
      !Number.isFinite(px?.y_from) ||
      !Number.isFinite(px?.y_to)
    ) {
      return null
    }
    const left = Math.min(px.x_from, px.x_to)
    const right = Math.max(px.x_from, px.x_to)
    const top = Math.min(px.y_from, px.y_to)
    const bot = Math.max(px.y_from, px.y_to)
    const color = resolveColor(a)
    return (
      <g key={key} className="annotation annotation-rect" data-annotation-id={a.id}>
        <rect
          x={left}
          y={top}
          width={Math.max(1, right - left)}
          height={Math.max(1, bot - top)}
          fill={color}
          opacity={resolveOpacity(a, 0.12)}
          stroke={color}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray={resolveDash(a)}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={onClick}
        />
        <AnnotationLabel
          annotation={a}
          x={left}
          y={top}
          color={color}
          anchor="start"
          dy={-4}
        />
      </g>
    )
  },

  arrow({ key, annotation: a, adapter, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (
      !Number.isFinite(px?.from?.x) ||
      !Number.isFinite(px?.from?.y) ||
      !Number.isFinite(px?.to?.x) ||
      !Number.isFinite(px?.to?.y)
    ) {
      return null
    }
    const color = resolveColor(a)
    const markerId = `annot-arrow-${a.id}`
    return (
      <g key={key} className="annotation annotation-arrow" data-annotation-id={a.id}>
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        </defs>
        <line
          x1={px.from.x}
          y1={px.from.y}
          x2={px.to.x}
          y2={px.to.y}
          stroke="transparent"
          strokeWidth={10}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={onClick}
        />
        <line
          x1={px.from.x}
          y1={px.from.y}
          x2={px.to.x}
          y2={px.to.y}
          stroke={color}
          strokeWidth={selected ? 2.5 : 1.5}
          markerEnd={`url(#${markerId})`}
          opacity={resolveOpacity(a, 0.9)}
        />
        <AnnotationLabel
          annotation={a}
          x={(px.from.x + px.to.x) / 2}
          y={(px.from.y + px.to.y) / 2}
          color={color}
          anchor="middle"
          dy={-6}
        />
      </g>
    )
  },

  text({ key, annotation: a, adapter, selected, onClick }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.x) || !Number.isFinite(px?.y)) return null
    const color = resolveColor(a)
    return (
      <g key={key} className="annotation annotation-text" data-annotation-id={a.id}>
        <AnnotationLabel
          annotation={a}
          x={px.x}
          y={px.y}
          color={color}
          anchor="start"
          forceText
          onClick={onClick}
          selected={selected}
        />
      </g>
    )
  },
}

/** Tiny label renderer used by every drawer. Reads the annotation's
 *  label.text / label.position; positions itself with a backdrop rect
 *  so the text stays legible over colored fills. */
function AnnotationLabel({
  annotation,
  x,
  y,
  color,
  anchor = 'middle',
  dy = 0,
  forceText = false,
  onClick,
  selected,
}) {
  const text = annotation.label?.text
  if (!forceText && (!text || text.length === 0)) return null
  const display = text || '(라벨 없음)'
  // Approximate text width — enough for the backdrop pill to fit. Real
  // measurement would require a hidden <text> + getBBox; we accept the
  // approximation here since labels are usually short.
  const approxWidth = display.length * 6.5 + 8
  const labelY = y + dy - 8
  return (
    <g
      style={onClick ? { pointerEvents: 'auto', cursor: 'pointer' } : undefined}
      onClick={onClick}
    >
      <rect
        x={anchor === 'middle' ? x - approxWidth / 2 : anchor === 'end' ? x - approxWidth : x}
        y={labelY - 10}
        width={approxWidth}
        height={14}
        rx={3}
        fill="#fff"
        stroke={color}
        strokeWidth={selected ? 1.5 : 1}
        opacity={0.95}
      />
      <text
        x={x}
        y={labelY}
        fill={color}
        fontSize={11}
        fontWeight={600}
        textAnchor={anchor}
        dominantBaseline="middle"
        style={{ userSelect: 'none' }}
      >
        {display}
      </text>
    </g>
  )
}
