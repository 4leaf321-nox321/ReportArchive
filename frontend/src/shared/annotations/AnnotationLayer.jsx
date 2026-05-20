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
  // Drop unsupported types; keep hidden ones only in edit mode (the
  // user needs to be able to find + un-hide them). In read-only /
  // export mode, hidden truly means gone. Unsupported types are
  // accepted silently so a payload with an arrow still loads on a
  // host that only supports lines — it just doesn't draw those.
  const drawable = useMemo(() => {
    if (!Array.isArray(annotations) || !adapter) return []
    const supported = new Set(adapter.supportedTypes ?? [])
    return annotations.filter(
      (a) =>
        (!a.hidden || !readOnly) &&
        (supported.size === 0 || supported.has(a.type)),
    )
  }, [annotations, adapter, readOnly])

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
  // Optional richer interaction layer (drag-to-move + double-click
  // label edit). When provided, drawers use it INSTEAD of the simple
  // onSelect/onClick wiring — the interaction hook handles selection
  // itself (on pointerup with no movement) so we don't double-fire.
  interactions,
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
        const node = draw({
          key: a.id,
          annotation: a,
          adapter,
          bounds,
          selected,
          locked: !!a.locked,
          onClick: (e) => handleClick(e, a.id),
          interactions,
        })
        // Hidden annotations only reach this branch in edit mode (the
        // useMemo above strips them in readOnly). Render as a faded
        // ghost so the user can still find + click them to un-hide.
        if (a.hidden) {
          return (
            <g key={a.id} opacity={0.25} style={{ pointerEvents: 'auto' }}>
              {node}
            </g>
          )
        }
        return node
      })}
    </>
  )
}

/** Build the props for an annotation's body shape (line / rect /
 *  circle). When the host provides an interactions hook, the body
 *  becomes draggable (mousedown starts a drag, mouseup selects when
 *  no movement happened). Otherwise it stays click-to-select for the
 *  legacy code path used by hosts that haven't migrated. */
function bodyHandlers({ annotation, interactions, onClick }) {
  if (interactions?.onBodyPointerDown && !annotation.locked) {
    return {
      onPointerDown: (e) => interactions.onBodyPointerDown(annotation, e),
      style: { pointerEvents: 'auto', cursor: 'move' },
    }
  }
  return {
    onClick,
    style: {
      pointerEvents: 'auto',
      cursor: annotation.locked ? 'not-allowed' : 'pointer',
    },
  }
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

/** Endpoint handle drawn at one corner / edge of a selected range
 *  annotation. Pointer-down forwards to the interaction hook with the
 *  geometry field name so the resize updates only that field.
 *
 *  Renders null when the host has no interactions hook (view-only)
 *  or when the annotation is locked — same gating the body uses. */
function ResizeHandle({ annotation, handle, x, y, color, interactions, cursor = 'move' }) {
  if (!interactions?.onHandlePointerDown) return null
  if (annotation.locked) return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return (
    <circle
      cx={x}
      cy={y}
      r={5}
      fill="#fff"
      stroke={color}
      strokeWidth={2}
      style={{ pointerEvents: 'auto', cursor }}
      onPointerDown={(e) => {
        e.stopPropagation()
        interactions.onHandlePointerDown(annotation, handle, e)
      }}
    />
  )
}

const DRAWERS = {
  vline({ key, annotation: a, adapter, bounds, selected, onClick, interactions }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.x)) return null
    const color = resolveColor(a)
    const dash = resolveDash(a)
    const top = bounds.y
    const bot = bounds.y + bounds.height
    const hb = bodyHandlers({ annotation: a, interactions, onClick })
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
          {...hb}
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
          interactions={interactions}
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

  hline({ key, annotation: a, adapter, bounds, selected, onClick, interactions }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.y)) return null
    const color = resolveColor(a)
    const dash = resolveDash(a)
    const left = bounds.x
    const right = bounds.x + bounds.width
    const hb = bodyHandlers({ annotation: a, interactions, onClick })
    return (
      <g key={key} className="annotation annotation-hline" data-annotation-id={a.id}>
        <line
          x1={left}
          y1={px.y}
          x2={right}
          y2={px.y}
          stroke="transparent"
          strokeWidth={10}
          {...hb}
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
          interactions={interactions}
        />
      </g>
    )
  },

  vrange({ key, annotation: a, adapter, bounds, selected, onClick, interactions }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.x_from) || !Number.isFinite(px?.x_to)) return null
    const left = Math.min(px.x_from, px.x_to)
    const right = Math.max(px.x_from, px.x_to)
    const color = resolveColor(a)
    const hb = bodyHandlers({ annotation: a, interactions, onClick })
    return (
      <g key={key} className="annotation annotation-vrange" data-annotation-id={a.id}>
        <rect
          x={left}
          y={bounds.y}
          width={Math.max(1, right - left)}
          height={bounds.height}
          fill={color}
          opacity={resolveOpacity(a, 0.12)}
          {...hb}
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
          interactions={interactions}
        />
        {selected && (
          <>
            <ResizeHandle
              annotation={a}
              handle="x_from"
              x={px.x_from}
              y={bounds.y + bounds.height / 2}
              color={color}
              interactions={interactions}
              cursor="ew-resize"
            />
            <ResizeHandle
              annotation={a}
              handle="x_to"
              x={px.x_to}
              y={bounds.y + bounds.height / 2}
              color={color}
              interactions={interactions}
              cursor="ew-resize"
            />
          </>
        )}
      </g>
    )
  },

  hrange({ key, annotation: a, adapter, bounds, selected, onClick, interactions }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.y_from) || !Number.isFinite(px?.y_to)) return null
    const top = Math.min(px.y_from, px.y_to)
    const bot = Math.max(px.y_from, px.y_to)
    const color = resolveColor(a)
    const hb = bodyHandlers({ annotation: a, interactions, onClick })
    return (
      <g key={key} className="annotation annotation-hrange" data-annotation-id={a.id}>
        <rect
          x={bounds.x}
          y={top}
          width={bounds.width}
          height={Math.max(1, bot - top)}
          fill={color}
          opacity={resolveOpacity(a, 0.12)}
          {...hb}
        />
        <AnnotationLabel
          annotation={a}
          x={bounds.x + bounds.width}
          y={(top + bot) / 2}
          color={color}
          anchor="end"
          dy={4}
          interactions={interactions}
        />
        {selected && (
          <>
            <ResizeHandle
              annotation={a}
              handle="y_from"
              x={bounds.x + bounds.width / 2}
              y={px.y_from}
              color={color}
              interactions={interactions}
              cursor="ns-resize"
            />
            <ResizeHandle
              annotation={a}
              handle="y_to"
              x={bounds.x + bounds.width / 2}
              y={px.y_to}
              color={color}
              interactions={interactions}
              cursor="ns-resize"
            />
          </>
        )}
      </g>
    )
  },

  point({ key, annotation: a, adapter, selected, onClick, interactions }) {
    const px = adapter.toPx(a.geometry)
    if (!Number.isFinite(px?.x) || !Number.isFinite(px?.y)) return null
    const color = resolveColor(a, '#ef4444')
    const hb = bodyHandlers({ annotation: a, interactions, onClick })
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
          {...hb}
        />
        <AnnotationLabel
          annotation={a}
          x={px.x}
          y={px.y - 10}
          color={color}
          anchor="middle"
          interactions={interactions}
        />
      </g>
    )
  },

  rect({ key, annotation: a, adapter, selected, onClick, interactions }) {
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
    const hb = bodyHandlers({ annotation: a, interactions, onClick })
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
          {...hb}
        />
        <AnnotationLabel
          annotation={a}
          x={left}
          y={top}
          color={color}
          anchor="start"
          dy={-4}
          interactions={interactions}
        />
        {selected && (
          <>
            {/* Four corner handles. Each handle name encodes the TWO
                data-coord fields it owns so a corner drag moves both
                axes together. Pixel position follows the actual field
                values — not min/max — so a temporarily-inverted rect
                keeps each handle attached to its field. */}
            <ResizeHandle
              annotation={a}
              handle="x_from_y_from"
              x={px.x_from}
              y={px.y_from}
              color={color}
              interactions={interactions}
              cursor="nwse-resize"
            />
            <ResizeHandle
              annotation={a}
              handle="x_to_y_from"
              x={px.x_to}
              y={px.y_from}
              color={color}
              interactions={interactions}
              cursor="nesw-resize"
            />
            <ResizeHandle
              annotation={a}
              handle="x_from_y_to"
              x={px.x_from}
              y={px.y_to}
              color={color}
              interactions={interactions}
              cursor="nesw-resize"
            />
            <ResizeHandle
              annotation={a}
              handle="x_to_y_to"
              x={px.x_to}
              y={px.y_to}
              color={color}
              interactions={interactions}
              cursor="nwse-resize"
            />
          </>
        )}
      </g>
    )
  },

  arrow({ key, annotation: a, adapter, selected, onClick, interactions }) {
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
    // Compute a manual triangle head instead of relying on SVG's
    // <marker>. Markers with dynamic attributes (size / color
    // changing between selected ↔ unselected) were occasionally
    // failing to re-render in browsers — the line would still
    // reference url(#...) but the head wouldn't paint, leaving an
    // invisible tip. A plain <polygon> derived from the line
    // direction is bulletproof: no defs, no URL indirection.
    const dx = px.to.x - px.from.x
    const dy = px.to.y - px.from.y
    const lineLen = Math.hypot(dx, dy)
    const strokeW = selected ? 3 : 2
    const headLen = selected ? 20 : 18
    const headHalfWidth = selected ? 10 : 9
    // Fall back to no head when the arrow has zero length (mid-drag /
    // degenerate state) so we don't divide by zero.
    let head = null
    let lineEndX = px.to.x
    let lineEndY = px.to.y
    if (lineLen > 0.001) {
      const ux = dx / lineLen
      const uy = dy / lineLen
      // Base center: head's flat side, offset along the line away
      // from the tip. We also pull the LINE end back to this point so
      // the line stroke doesn't poke through the triangle (matters
      // for dashed / dotted styles).
      const bcx = px.to.x - headLen * ux
      const bcy = px.to.y - headLen * uy
      lineEndX = bcx
      lineEndY = bcy
      // Perpendicular unit vector (-uy, ux) — gives the base corners
      // on either side of the line.
      const pxv = -uy
      const pyv = ux
      const blx = bcx + headHalfWidth * pxv
      const bly = bcy + headHalfWidth * pyv
      const brx = bcx - headHalfWidth * pxv
      const bry = bcy - headHalfWidth * pyv
      head = `${px.to.x},${px.to.y} ${blx},${bly} ${brx},${bry}`
    }
    return (
      <g key={key} className="annotation annotation-arrow" data-annotation-id={a.id}>
        <line
          x1={px.from.x}
          y1={px.from.y}
          x2={px.to.x}
          y2={px.to.y}
          stroke="transparent"
          strokeWidth={14}
          {...bodyHandlers({ annotation: a, interactions, onClick })}
        />
        <line
          x1={px.from.x}
          y1={px.from.y}
          x2={lineEndX}
          y2={lineEndY}
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray={resolveDash(a)}
          opacity={resolveOpacity(a, 0.95)}
        />
        {head && (
          <polygon
            points={head}
            fill={color}
            stroke={color}
            strokeWidth={1}
            strokeLinejoin="miter"
            opacity={resolveOpacity(a, 0.95)}
          />
        )}
        <AnnotationLabel
          annotation={a}
          x={(px.from.x + px.to.x) / 2}
          y={(px.from.y + px.to.y) / 2}
          color={color}
          anchor="middle"
          dy={-6}
          interactions={interactions}
        />
        {selected && (
          <>
            <ResizeHandle
              annotation={a}
              handle="from"
              x={px.from.x}
              y={px.from.y}
              color={color}
              interactions={interactions}
            />
            <ResizeHandle
              annotation={a}
              handle="to"
              x={px.to.x}
              y={px.to.y}
              color={color}
              interactions={interactions}
            />
          </>
        )}
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
 *  so the text stays legible over colored fills.
 *
 *  When the host provides an interactions hook AND this annotation is
 *  the one currently being edited, the label flips to an HTML <input>
 *  hosted by a <foreignObject>. Enter / blur commits, Esc cancels.
 *  Double-click on the label area opens the editor. */
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
  interactions,
}) {
  const text = annotation.label?.text
  const isEditing = interactions?.editingId === annotation.id
  const labelY = y + dy - 8
  // While editing, hide the static label entirely. The host renders
  // a DOM-overlay <AnnotationLabelEditor> at this same position
  // (using `labelPositionFor`) — SVG foreignObject editing inside
  // the chart's SVG turned out to be invisible under BarChart's
  // compositing stack, so we render the input outside the SVG.
  if (isEditing) return null
  if (!forceText && (!text || text.length === 0)) {
    // No saved label. Show a faint "+ 라벨" placeholder when the
    // annotation is selected and interactions are wired, so the user
    // has a discoverable spot to click and add one. Outside that, we
    // render nothing to keep the chart visually clean.
    if (selected && interactions?.onLabelDoubleClick) {
      const placeholderText = '+ 라벨'
      const PLACEHOLDER_PAD_X = 10
      const PLACEHOLDER_HEIGHT = 20
      const placeholderWidth = placeholderText.length * 6.5 + PLACEHOLDER_PAD_X * 2
      function handleAddLabel(e) {
        e.stopPropagation()
        interactions.onLabelDoubleClick(annotation, e)
      }
      return (
        <g
          style={{ pointerEvents: 'auto', cursor: 'text' }}
          onClick={handleAddLabel}
          onDoubleClick={handleAddLabel}
        >
          <rect
            x={
              anchor === 'middle'
                ? x - placeholderWidth / 2
                : anchor === 'end'
                  ? x - placeholderWidth
                  : x
            }
            y={labelY - PLACEHOLDER_HEIGHT / 2}
            width={placeholderWidth}
            height={PLACEHOLDER_HEIGHT}
            rx={4}
            fill="#fff"
            stroke={color}
            strokeWidth={1}
            strokeDasharray="3,2"
            opacity={0.7}
          />
          <text
            x={
              anchor === 'end'
                ? x - PLACEHOLDER_PAD_X
                : anchor === 'start'
                  ? x + PLACEHOLDER_PAD_X
                  : x
            }
            y={labelY}
            fill={color}
            fontSize={11}
            fontStyle="italic"
            textAnchor={anchor}
            dominantBaseline="central"
            opacity={0.8}
            style={{ userSelect: 'none' }}
          >
            {placeholderText}
          </text>
        </g>
      )
    }
    return null
  }
  const display = text || '(라벨 없음)'
  // Pill dimensions. 8px horizontal + ~4px vertical padding around the
  // text — the old chip rendered text tight against the rect border
  // which felt cramped against neighboring annotations.
  const LABEL_PAD_X = 8
  const LABEL_HEIGHT = 20
  const approxWidth = display.length * 6.5 + LABEL_PAD_X * 2
  // Double-click on the label area triggers edit mode when interactions
  // are available; otherwise label is purely display. The single-click
  // handler stays on the wrapping <g> so click-to-select keeps working
  // on hosts that don't provide interactions.
  function handleDoubleClick(e) {
    if (!interactions?.onLabelDoubleClick) return
    interactions.onLabelDoubleClick(annotation, e)
  }
  const labelStyle = onClick
    ? { pointerEvents: 'auto', cursor: 'pointer' }
    : interactions?.onLabelDoubleClick
      ? { pointerEvents: 'auto', cursor: 'text' }
      : undefined
  return (
    <g style={labelStyle} onClick={onClick} onDoubleClick={handleDoubleClick}>
      <rect
        x={anchor === 'middle' ? x - approxWidth / 2 : anchor === 'end' ? x - approxWidth : x}
        y={labelY - LABEL_HEIGHT / 2}
        width={approxWidth}
        height={LABEL_HEIGHT}
        rx={4}
        fill="#fff"
        stroke={color}
        strokeWidth={selected ? 1.5 : 1}
        opacity={0.95}
      />
      <text
        x={
          anchor === 'end'
            ? x - LABEL_PAD_X
            : anchor === 'start'
              ? x + LABEL_PAD_X
              : x
        }
        y={labelY}
        fill={color}
        fontSize={11}
        fontWeight={600}
        textAnchor={anchor}
        dominantBaseline="central"
        style={{ userSelect: 'none' }}
      >
        {display}
      </text>
    </g>
  )
}
