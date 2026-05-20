import { useState } from 'react'
import { defaultGeometryFor } from './types'
import { isClickTool, isDragTool } from './AnnotationToolbar'

/**
 * Transparent <rect> that sits over the host widget's drawable area and
 * captures pointer events while a tool is active. Lives inside the
 * host's SVG (e.g. Recharts' Customized <g>) so it shares the coordinate
 * system — no separate overlay-positioning math.
 *
 * Click tools (vline/hline/point/text):
 *   - mousedown commits immediately at the cursor's data coord.
 *
 * Drag tools (vrange/hrange/rect/arrow):
 *   - mousedown starts a drag, mousemove shows a preview <g>, mouseup
 *     commits with the final geometry.
 *
 * Output goes to the supplied store via `onCreate(annotationInit)` so
 * the store can wrap with its history coalescing. The caller is also
 * responsible for resetting the tool to null after a successful commit
 * (passed in as `onCommit`).
 */
export function InteractiveCaptureRect({
  adapter,
  tool,
  onCreate,
  onCommit,
}) {
  // While a drag tool is in flight we keep the start pixel + current
  // pixel so the preview can mirror what the user will get on release.
  const [drag, setDrag] = useState(null)

  if (!adapter || !tool) return null
  const { x: bx, y: by, width: bw, height: bh } = adapter.bounds ?? {}
  if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) {
    return null
  }

  // Translate a pointer event's clientX/Y into the SVG's user-coordinate
  // space. SVG's getScreenCTM gives the on-screen transform; inverting
  // it maps the screen point back into svg coords (which matches what
  // adapter.toPx / fromPx use).
  function pointerToSvg(e) {
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const local = pt.matrixTransform(ctm.inverse())
    return { x: local.x, y: local.y }
  }

  function dataCoord(svgPoint) {
    if (!adapter.fromPx) return null
    return adapter.fromPx({ x: svgPoint.x, y: svgPoint.y })
  }

  // Click-tool path — single pointerdown commits.
  function handleClickToolDown(e) {
    const svgPt = pointerToSvg(e)
    if (!svgPt) return
    const data = dataCoord(svgPt)
    if (!data) return
    const seed = buildSeedForClickTool(tool, data)
    if (!seed) return
    onCreate({ type: tool, geometry: seed })
    onCommit?.()
  }

  // Drag-tool path — pointerdown begins, pointermove updates preview,
  // pointerup commits. Pointer capture on the rect makes the move/up
  // events keep firing even if the cursor leaves the chart area.
  function handleDragToolDown(e) {
    const svgPt = pointerToSvg(e)
    if (!svgPt) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ start: svgPt, current: svgPt })
  }
  function handleDragToolMove(e) {
    if (!drag) return
    const svgPt = pointerToSvg(e)
    if (!svgPt) return
    setDrag({ start: drag.start, current: svgPt })
  }
  function handleDragToolUp(e) {
    if (!drag) return
    const startData = dataCoord(drag.start)
    const endData = dataCoord(drag.current)
    setDrag(null)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (!startData || !endData) return
    const seed = buildSeedForDragTool(tool, startData, endData)
    if (!seed) return
    // Guard against zero-area shapes — if the user just clicked
    // without dragging on a drag tool, ignore the gesture entirely so
    // we don't litter the chart with invisible annotations.
    if (!seedHasArea(tool, seed)) return
    onCreate({ type: tool, geometry: seed })
    onCommit?.()
  }

  const isDrag = isDragTool(tool)
  const isClick = isClickTool(tool)

  return (
    <g className="annotation-capture-layer">
      <rect
        x={bx}
        y={by}
        width={bw}
        height={bh}
        fill="transparent"
        style={{
          pointerEvents: 'auto',
          cursor: isDrag ? 'crosshair' : 'crosshair',
        }}
        onPointerDown={
          isClick ? handleClickToolDown : isDrag ? handleDragToolDown : undefined
        }
        onPointerMove={isDrag ? handleDragToolMove : undefined}
        onPointerUp={isDrag ? handleDragToolUp : undefined}
      />
      {drag && (
        <DragPreview
          tool={tool}
          start={drag.start}
          current={drag.current}
          bounds={{ x: bx, y: by, width: bw, height: bh }}
        />
      )}
    </g>
  )
}

/** Translate the cursor's data coord into the seed geometry for a
 *  click-type tool. vline only cares about x, hline about y, point
 *  about both, text similarly. */
function buildSeedForClickTool(tool, data) {
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

/** Translate start/end data coords into the seed geometry for a
 *  drag-type tool. Range tools normalize from↔to so the user can drag
 *  in either direction; rect / arrow keep the directional from→to. */
function buildSeedForDragTool(tool, start, end) {
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

/** Reject zero-extent gestures so a misclick on a drag tool doesn't
 *  create an invisible annotation the user has to hunt down + remove. */
function seedHasArea(tool, seed) {
  if (tool === 'vrange') return seed.x_from !== seed.x_to
  if (tool === 'hrange') return seed.y_from !== seed.y_to
  if (tool === 'rect')
    return seed.x_from !== seed.x_to && seed.y_from !== seed.y_to
  if (tool === 'arrow')
    return seed.from.x !== seed.to.x || seed.from.y !== seed.to.y
  return true
}

/** Light-touch preview while the user drags a range / rect / arrow.
 *  Uses raw pixel coords (not data) so it can update on every move
 *  without round-tripping through fromPx/toPx — the gesture is
 *  finalized on mouseup and re-rendered through the store. */
function DragPreview({ tool, start, current, bounds }) {
  const color = '#2563eb'
  if (tool === 'vrange') {
    const left = Math.min(start.x, current.x)
    const right = Math.max(start.x, current.x)
    return (
      <rect
        x={left}
        y={bounds.y}
        width={Math.max(1, right - left)}
        height={bounds.height}
        fill={color}
        opacity={0.15}
        stroke={color}
        strokeDasharray="4,3"
      />
    )
  }
  if (tool === 'hrange') {
    const top = Math.min(start.y, current.y)
    const bot = Math.max(start.y, current.y)
    return (
      <rect
        x={bounds.x}
        y={top}
        width={bounds.width}
        height={Math.max(1, bot - top)}
        fill={color}
        opacity={0.15}
        stroke={color}
        strokeDasharray="4,3"
      />
    )
  }
  if (tool === 'rect') {
    const left = Math.min(start.x, current.x)
    const right = Math.max(start.x, current.x)
    const top = Math.min(start.y, current.y)
    const bot = Math.max(start.y, current.y)
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
        x1={start.x}
        y1={start.y}
        x2={current.x}
        y2={current.y}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="4,3"
      />
    )
  }
  return null
}
