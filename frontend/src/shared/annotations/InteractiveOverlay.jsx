import { useEffect, useRef, useState } from 'react'
import { defaultGeometryFor, normalizeGeometry } from './types'
import { isClickTool, isDragTool, isTwoClickTool } from './AnnotationToolbar'

/**
 * Absolute-positioned DOM overlay that sits over the host widget's
 * drawable area and captures pointer events while a tool is active.
 *
 * Three input modes, picked per-tool:
 *   - CLICK   (vline / hline / point / text) — commit on the first
 *             pointerdown at the cursor's data coords.
 *   - TWO-CLICK (vrange / hrange) — first click marks the start,
 *             second click commits the range. Easier than dragging
 *             for precise endpoint selection, and easier on touch.
 *   - DRAG    (rect / arrow) — pointerdown→move→up for shapes that
 *             really need a 2-D gesture.
 *
 * Every mode renders a HOVER PREVIEW that snaps through fromPx → toPx
 * so the user sees the actual commit position (especially under
 * categorical x-axes) and a small coord chip with the data value(s).
 *
 *   <InteractiveOverlay
 *     bounds={adapter.bounds}    // { x, y, width, height } in container coords
 *     fromPx={(p) => adapter.fromPx(p)}
 *     toPx={(g) => adapter.toPx(g)}
 *     tool={tool}
 *     onCreate={(init) => store.add(init)}
 *     onCommit={() => setTool(null)}
 *   />
 */
export function InteractiveOverlay({
  bounds,
  fromPx,
  toPx,
  tool,
  onCreate,
  onCommit,
}) {
  // Drag state — only used for genuine drag tools (rect / arrow).
  const [drag, setDrag] = useState(null)
  // First-click anchor for two-click tools (vrange / hrange).
  const [firstClick, setFirstClick] = useState(null)
  // Hover position in container coords. Drives the live preview for
  // every mode.
  const [hover, setHover] = useState(null)
  const overlayRef = useRef(null)

  // Reset transient state whenever the tool changes — leftover
  // firstClick from a previous tool would otherwise commit the next
  // click of a totally different shape.
  useEffect(() => {
    setFirstClick(null)
    setDrag(null)
  }, [tool])

  // Esc cancels a pending first-click without exiting the tool.
  useEffect(() => {
    if (!firstClick) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setFirstClick(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [firstClick])

  if (!tool || !bounds) return null
  const { x: bx, y: by, width: bw, height: bh } = bounds
  if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) {
    return null
  }

  function pointerToContainer(e) {
    const el = overlayRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    return { x: localX + bx, y: localY + by }
  }

  function dataCoord(containerPt) {
    if (!fromPx) return null
    return fromPx({ x: containerPt.x, y: containerPt.y })
  }

  // ── click-type commit ─────────────────────────────────────────────
  function handleClickToolDown(e) {
    e.stopPropagation()
    const pt = pointerToContainer(e)
    if (!pt) return
    const data = dataCoord(pt)
    if (!data) return
    const seed = seedForClickTool(tool, data)
    if (!seed) return
    onCreate({ type: tool, geometry: seed })
    onCommit?.()
  }

  // ── two-click-type commit ─────────────────────────────────────────
  function handleTwoClickDown(e) {
    e.stopPropagation()
    const pt = pointerToContainer(e)
    if (!pt) return
    const data = dataCoord(pt)
    if (!data) return
    if (!firstClick) {
      // First click — remember the anchor + show a "waiting" preview.
      setFirstClick({ container: pt, data })
      return
    }
    // Second click — commit a range / rect / arrow from firstClick to here.
    const rawSeed = seedForRangeFromTwoClicks(tool, firstClick.data, data)
    if (!rawSeed) {
      setFirstClick(null)
      return
    }
    if (!seedHasArea(tool, rawSeed)) {
      // Same spot twice — treat as a reset rather than emitting an
      // empty range that would just disappear.
      setFirstClick(null)
      return
    }
    // Normalize so from <= to on every axis. Without this, clicking
    // right-to-left (or bottom-to-top) produces x_from > x_to which
    // validateAnnotation rejects, silently dropping the annotation.
    const seed = normalizeGeometry(tool, rawSeed)
    onCreate({ type: tool, geometry: seed })
    setFirstClick(null)
    onCommit?.()
  }

  // ── genuine drag (rect / arrow) ───────────────────────────────────
  function handleDragToolDown(e) {
    e.stopPropagation()
    const pt = pointerToContainer(e)
    if (!pt) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ start: pt, current: pt })
  }
  function handleDragToolMove(e) {
    if (!drag) return
    const pt = pointerToContainer(e)
    if (!pt) return
    setDrag({ start: drag.start, current: pt })
  }
  function handleDragToolUp(e) {
    if (!drag) return
    const startData = dataCoord(drag.start)
    const endData = dataCoord(drag.current)
    setDrag(null)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (!startData || !endData) return
    const rawSeed = seedForRangeFromTwoClicks(tool, startData, endData)
    if (!rawSeed) return
    if (!seedHasArea(tool, rawSeed)) return
    const seed = normalizeGeometry(tool, rawSeed)
    onCreate({ type: tool, geometry: seed })
    onCommit?.()
  }

  // ── mode classification ───────────────────────────────────────────
  const isTwoClick = isTwoClickTool(tool)
  const isDrag = !isTwoClick && isDragTool(tool)
  const isClick = !isTwoClick && !isDrag && isClickTool(tool)

  function handlePointerDown(e) {
    if (isTwoClick) handleTwoClickDown(e)
    else if (isDrag) handleDragToolDown(e)
    else if (isClick) handleClickToolDown(e)
  }
  function handlePointerMove(e) {
    if (isDrag) handleDragToolMove(e)
    const pt = pointerToContainer(e)
    if (pt) setHover(pt)
  }

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'absolute',
        left: bx,
        top: by,
        width: bw,
        height: bh,
        cursor: 'crosshair',
        zIndex: 10,
        touchAction: 'none',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHover(null)}
      onPointerUp={isDrag ? handleDragToolUp : undefined}
    >
      {/* Drag-mode preview (rect / arrow) */}
      {drag && (
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            overflow: 'visible',
          }}
          width="100%"
          height="100%"
        >
          <DragPreview
            tool={tool}
            startLocal={{ x: drag.start.x - bx, y: drag.start.y - by }}
            currentLocal={{ x: drag.current.x - bx, y: drag.current.y - by }}
            width={bw}
            height={bh}
          />
        </svg>
      )}
      {/* Hover preview overlay — shows the snap target + a small
          coord chip so the user knows exactly which value they're
          about to commit. Same SVG for click + two-click flows. */}
      {!drag && hover && toPx && fromPx && (
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            overflow: 'visible',
          }}
          width="100%"
          height="100%"
        >
          <ToolHoverPreview
            tool={tool}
            hover={hover}
            firstClick={firstClick}
            bounds={{ x: bx, y: by, width: bw, height: bh }}
            fromPx={fromPx}
            toPx={toPx}
            mode={isTwoClick ? 'two-click' : isClick ? 'click' : 'drag'}
          />
        </svg>
      )}
    </div>
  )
}

function seedForClickTool(tool, data) {
  switch (tool) {
    case 'vline':
      return defaultGeometryFor('vline', { x: data.x })
    case 'hline':
      return defaultGeometryFor('hline', { y: data.y })
    case 'point':
      return defaultGeometryFor('point', { x: data.x, y: data.y })
    case 'text':
      return defaultGeometryFor('text', { x: data.x, y: data.y })
    default:
      return null
  }
}

/** Builds the geometry for vrange / hrange / rect / arrow from two
 *  data-coordinate endpoints (either two-click or drag start/end). */
function seedForRangeFromTwoClicks(tool, start, end) {
  switch (tool) {
    case 'vrange':
      return defaultGeometryFor('vrange', { x_from: start.x, x_to: end.x })
    case 'hrange':
      return defaultGeometryFor('hrange', { y_from: start.y, y_to: end.y })
    case 'rect':
      return defaultGeometryFor('rect', {
        x_from: start.x,
        x_to: end.x,
        y_from: start.y,
        y_to: end.y,
      })
    case 'arrow':
      return defaultGeometryFor('arrow', {
        from: { x: start.x, y: start.y },
        to: { x: end.x, y: end.y },
      })
    default:
      return null
  }
}

function seedHasArea(tool, seed) {
  if (tool === 'vrange') return seed.x_from !== seed.x_to
  if (tool === 'hrange') return seed.y_from !== seed.y_to
  if (tool === 'rect')
    return seed.x_from !== seed.x_to && seed.y_from !== seed.y_to
  if (tool === 'arrow')
    return seed.from.x !== seed.to.x || seed.from.y !== seed.to.y
  return true
}

/** Format a data value (number / string) for the coord chip. */
function formatValue(v) {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number') {
    // Trim trailing zeros for clean display, keep up to 2 decimals.
    if (Number.isInteger(v)) return String(v)
    return Number(v.toFixed(2)).toString()
  }
  return String(v)
}

/** Small floating coord chip — appears next to the cursor / preview
 *  showing the data value(s) the next commit will land on. */
function CoordChip({ x, y, anchor = 'start', text }) {
  if (!text) return null
  const PAD_X = 6
  const HEIGHT = 18
  const width = text.length * 6.2 + PAD_X * 2
  const left =
    anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x
  return (
    <g>
      <rect
        x={left}
        y={y - HEIGHT / 2}
        width={width}
        height={HEIGHT}
        rx={3}
        fill="#1f2937"
        opacity={0.85}
      />
      <text
        x={x}
        y={y}
        textAnchor={anchor}
        dominantBaseline="central"
        fill="#fff"
        fontSize={10}
        fontWeight={600}
        style={{ userSelect: 'none' }}
      >
        {text}
      </text>
    </g>
  )
}

/** Unified hover preview for every mode + tool. Renders:
 *   - the snap-aware shape preview (line / point / waiting-line)
 *   - a coord chip with the data value(s)
 *  For two-click tools, when firstClick is set, additionally draws
 *  the range/rect/arrow that would result from clicking now. */
function ToolHoverPreview({ tool, hover, firstClick, bounds, fromPx, toPx, mode }) {
  const dataAtCursor = fromPx({ x: hover.x, y: hover.y })
  if (!dataAtCursor) return null
  const color = '#2563eb'

  // ── click-type tools: line / point / text marker + coord chip ────
  if (mode === 'click') {
    if (tool === 'vline') {
      const pxBack = toPx({ x: dataAtCursor.x })
      if (!Number.isFinite(pxBack?.x)) return null
      const localX = pxBack.x - bounds.x
      return (
        <g>
          <line
            x1={localX}
            y1={0}
            x2={localX}
            y2={bounds.height}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="4,3"
            opacity={0.7}
          />
          <CoordChip
            x={localX}
            y={12}
            anchor="middle"
            text={`x = ${formatValue(dataAtCursor.x)}`}
          />
        </g>
      )
    }
    if (tool === 'hline') {
      const pxBack = toPx({ y: dataAtCursor.y })
      if (!Number.isFinite(pxBack?.y)) return null
      const localY = pxBack.y - bounds.y
      return (
        <g>
          <line
            x1={0}
            y1={localY}
            x2={bounds.width}
            y2={localY}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="4,3"
            opacity={0.7}
          />
          <CoordChip
            x={bounds.width - 8}
            y={localY - 12}
            anchor="end"
            text={`y = ${formatValue(dataAtCursor.y)}`}
          />
        </g>
      )
    }
    if (tool === 'point') {
      const pxBack = toPx({ x: dataAtCursor.x, y: dataAtCursor.y })
      if (!Number.isFinite(pxBack?.x) || !Number.isFinite(pxBack?.y)) return null
      const localX = pxBack.x - bounds.x
      const localY = pxBack.y - bounds.y
      return (
        <g>
          <circle
            cx={localX}
            cy={localY}
            r={5}
            fill={color}
            opacity={0.4}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="3,2"
          />
          <CoordChip
            x={localX}
            y={localY - 14}
            anchor="middle"
            text={`(${formatValue(dataAtCursor.x)}, ${formatValue(dataAtCursor.y)})`}
          />
        </g>
      )
    }
    if (tool === 'text') {
      const localX = hover.x - bounds.x
      const localY = hover.y - bounds.y
      return (
        <g opacity={0.8}>
          <line
            x1={localX - 4}
            y1={localY}
            x2={localX + 4}
            y2={localY}
            stroke={color}
            strokeWidth={1}
          />
          <line
            x1={localX}
            y1={localY - 4}
            x2={localX}
            y2={localY + 4}
            stroke={color}
            strokeWidth={1}
          />
          <CoordChip
            x={localX + 8}
            y={localY - 10}
            anchor="start"
            text={`(${formatValue(dataAtCursor.x)}, ${formatValue(dataAtCursor.y)})`}
          />
        </g>
      )
    }
    return null
  }

  // ── two-click tools: waiting marker + (when first click placed)
  // the in-flight range preview ─────────────────────────────────────
  if (mode === 'two-click') {
    // No firstClick yet → just a single-axis preview showing where
    // the FIRST click will commit.
    if (!firstClick) {
      if (tool === 'vrange') {
        const pxBack = toPx({ x: dataAtCursor.x })
        if (!Number.isFinite(pxBack?.x)) return null
        const localX = pxBack.x - bounds.x
        return (
          <g>
            <line
              x1={localX}
              y1={0}
              x2={localX}
              y2={bounds.height}
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray="4,3"
              opacity={0.7}
            />
            <CoordChip
              x={localX}
              y={12}
              anchor="middle"
              text={`시작: x = ${formatValue(dataAtCursor.x)}`}
            />
          </g>
        )
      }
      if (tool === 'hrange') {
        const pxBack = toPx({ y: dataAtCursor.y })
        if (!Number.isFinite(pxBack?.y)) return null
        const localY = pxBack.y - bounds.y
        return (
          <g>
            <line
              x1={0}
              y1={localY}
              x2={bounds.width}
              y2={localY}
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray="4,3"
              opacity={0.7}
            />
            <CoordChip
              x={bounds.width - 8}
              y={localY - 12}
              anchor="end"
              text={`시작: y = ${formatValue(dataAtCursor.y)}`}
            />
          </g>
        )
      }
      // rect / arrow waiting state — same crosshair + coord chip.
      // Distinguish by chip wording so the user knows what the click
      // will commit (a corner vs. the arrow tail).
      if (tool === 'rect' || tool === 'arrow') {
        const localX = hover.x - bounds.x
        const localY = hover.y - bounds.y
        const startLabel = tool === 'rect' ? '시작 모서리' : '시작'
        return (
          <g opacity={0.8}>
            <line
              x1={localX - 5}
              y1={localY}
              x2={localX + 5}
              y2={localY}
              stroke={color}
              strokeWidth={1.5}
            />
            <line
              x1={localX}
              y1={localY - 5}
              x2={localX}
              y2={localY + 5}
              stroke={color}
              strokeWidth={1.5}
            />
            <CoordChip
              x={localX + 8}
              y={localY - 10}
              anchor="start"
              text={`${startLabel}: (${formatValue(dataAtCursor.x)}, ${formatValue(dataAtCursor.y)})`}
            />
          </g>
        )
      }
      return null
    }
    // firstClick set → preview the resulting range from start → cursor.
    // The anchor edge (where the user already clicked) is drawn SOLID,
    // the cursor edge is drawn DASHED — so the user sees which endpoint
    // is fixed vs. live.
    if (tool === 'vrange') {
      const px1 = toPx({ x: firstClick.data.x })
      const px2 = toPx({ x: dataAtCursor.x })
      if (!Number.isFinite(px1?.x) || !Number.isFinite(px2?.x)) return null
      const x1 = px1.x - bounds.x
      const x2 = px2.x - bounds.x
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      return (
        <g>
          <rect
            x={left}
            y={0}
            width={Math.max(1, right - left)}
            height={bounds.height}
            fill={color}
            opacity={0.15}
          />
          {/* Live cursor edge (dashed). */}
          <line
            x1={x2}
            y1={0}
            x2={x2}
            y2={bounds.height}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="4,3"
          />
          {/* Anchor edge from first click (solid). */}
          <line
            x1={x1}
            y1={0}
            x2={x1}
            y2={bounds.height}
            stroke={color}
            strokeWidth={2}
          />
          <CoordChip
            x={(left + right) / 2}
            y={12}
            anchor="middle"
            text={`x: ${formatValue(firstClick.data.x)} → ${formatValue(dataAtCursor.x)}`}
          />
        </g>
      )
    }
    if (tool === 'hrange') {
      const px1 = toPx({ y: firstClick.data.y })
      const px2 = toPx({ y: dataAtCursor.y })
      if (!Number.isFinite(px1?.y) || !Number.isFinite(px2?.y)) return null
      const y1 = px1.y - bounds.y
      const y2 = px2.y - bounds.y
      const top = Math.min(y1, y2)
      const bot = Math.max(y1, y2)
      return (
        <g>
          <rect
            x={0}
            y={top}
            width={bounds.width}
            height={Math.max(1, bot - top)}
            fill={color}
            opacity={0.15}
          />
          {/* Live cursor edge (dashed). */}
          <line
            x1={0}
            y1={y2}
            x2={bounds.width}
            y2={y2}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="4,3"
          />
          {/* Anchor edge from first click (solid). */}
          <line
            x1={0}
            y1={y1}
            x2={bounds.width}
            y2={y1}
            stroke={color}
            strokeWidth={2}
          />
          <CoordChip
            x={bounds.width - 8}
            y={(top + bot) / 2}
            anchor="end"
            text={`y: ${formatValue(firstClick.data.y)} → ${formatValue(dataAtCursor.y)}`}
          />
        </g>
      )
    }
    if (tool === 'rect') {
      const px1 = toPx({ x: firstClick.data.x, y: firstClick.data.y })
      const px2 = toPx({ x: dataAtCursor.x, y: dataAtCursor.y })
      if (
        !Number.isFinite(px1?.x) ||
        !Number.isFinite(px1?.y) ||
        !Number.isFinite(px2?.x) ||
        !Number.isFinite(px2?.y)
      ) {
        return null
      }
      const x1 = px1.x - bounds.x
      const y1 = px1.y - bounds.y
      const x2 = px2.x - bounds.x
      const y2 = px2.y - bounds.y
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      const top = Math.min(y1, y2)
      const bot = Math.max(y1, y2)
      return (
        <g>
          <rect
            x={left}
            y={top}
            width={Math.max(1, right - left)}
            height={Math.max(1, bot - top)}
            fill={color}
            opacity={0.15}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="4,3"
          />
          {/* Solid dot at the anchor corner so the user sees which
              corner is fixed. */}
          <circle cx={x1} cy={y1} r={3} fill={color} />
          <CoordChip
            x={(left + right) / 2}
            y={top - 10}
            anchor="middle"
            text={`(${formatValue(firstClick.data.x)}, ${formatValue(firstClick.data.y)}) → (${formatValue(dataAtCursor.x)}, ${formatValue(dataAtCursor.y)})`}
          />
        </g>
      )
    }
    if (tool === 'arrow') {
      const px1 = toPx({ x: firstClick.data.x, y: firstClick.data.y })
      const px2 = toPx({ x: dataAtCursor.x, y: dataAtCursor.y })
      if (
        !Number.isFinite(px1?.x) ||
        !Number.isFinite(px1?.y) ||
        !Number.isFinite(px2?.x) ||
        !Number.isFinite(px2?.y)
      ) {
        return null
      }
      const x1 = px1.x - bounds.x
      const y1 = px1.y - bounds.y
      const x2 = px2.x - bounds.x
      const y2 = px2.y - bounds.y
      return (
        <g>
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="4,3"
          />
          {/* Anchor dot (tail of arrow). */}
          <circle cx={x1} cy={y1} r={3} fill={color} />
          {/* Live head marker. */}
          <circle
            cx={x2}
            cy={y2}
            r={3}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
          />
          <CoordChip
            x={x2 + 8}
            y={y2 - 10}
            anchor="start"
            text={`→ (${formatValue(dataAtCursor.x)}, ${formatValue(dataAtCursor.y)})`}
          />
        </g>
      )
    }
    return null
  }

  // ── drag mode: rect / arrow show their own preview via DragPreview
  //   while dragging. Until drag starts, show a small cursor marker.
  if (mode === 'drag') {
    const localX = hover.x - bounds.x
    const localY = hover.y - bounds.y
    return (
      <g opacity={0.6}>
        <line
          x1={localX - 4}
          y1={localY}
          x2={localX + 4}
          y2={localY}
          stroke={color}
          strokeWidth={1}
        />
        <line
          x1={localX}
          y1={localY - 4}
          x2={localX}
          y2={localY + 4}
          stroke={color}
          strokeWidth={1}
        />
        <CoordChip
          x={localX + 8}
          y={localY - 10}
          anchor="start"
          text={`(${formatValue(dataAtCursor.x)}, ${formatValue(dataAtCursor.y)})`}
        />
      </g>
    )
  }
  return null
}

function DragPreview({ tool, startLocal, currentLocal, width, height }) {
  const color = '#2563eb'
  if (tool === 'rect') {
    const left = Math.min(startLocal.x, currentLocal.x)
    const right = Math.max(startLocal.x, currentLocal.x)
    const top = Math.min(startLocal.y, currentLocal.y)
    const bot = Math.max(startLocal.y, currentLocal.y)
    return (
      <rect
        x={left}
        y={top}
        width={Math.max(1, right - left)}
        height={Math.max(1, bot - top)}
        fill={color}
        opacity={0.15}
        stroke={color}
        strokeDasharray="4,3"
      />
    )
  }
  if (tool === 'arrow') {
    return (
      <line
        x1={startLocal.x}
        y1={startLocal.y}
        x2={currentLocal.x}
        y2={currentLocal.y}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="4,3"
      />
    )
  }
  // vrange / hrange no longer drag here — they use two-click. But
  // keeping the cases would be defensive if a host re-enabled drag.
  if (tool === 'vrange') {
    const left = Math.min(startLocal.x, currentLocal.x)
    const right = Math.max(startLocal.x, currentLocal.x)
    return (
      <rect
        x={left}
        y={0}
        width={Math.max(1, right - left)}
        height={height}
        fill={color}
        opacity={0.15}
        stroke={color}
        strokeDasharray="4,3"
      />
    )
  }
  if (tool === 'hrange') {
    const top = Math.min(startLocal.y, currentLocal.y)
    const bot = Math.max(startLocal.y, currentLocal.y)
    return (
      <rect
        x={0}
        y={top}
        width={width}
        height={Math.max(1, bot - top)}
        fill={color}
        opacity={0.15}
        stroke={color}
        strokeDasharray="4,3"
      />
    )
  }
  return null
}
