import { useState } from 'react'

/**
 * Rubber-band multi-select rectangle. Mounted inside the same SVG
 * that hosts the annotation shapes, drawn FIRST so it sits behind
 * them — annotations remain hittable in their painted areas, but
 * drags that start on empty space fall through to this layer.
 *
 *   <svg ...>
 *     {selectionEnabled && (
 *       <SelectionMarquee
 *         store={annotationStore}
 *         adapter={chartAdapter}
 *       />
 *     )}
 *     <AnnotationContents ... />   // drawn AFTER, on top
 *   </svg>
 *
 * Only mount when no creation tool is active — otherwise the marquee
 * and the creation overlay would fight for the same pointer events.
 *
 * Shift-drag adds to the existing selection; plain drag replaces it.
 * A tiny "drag" (<3px) is treated as a click on empty space → clears
 * selection (unless shift is held).
 */
export function SelectionMarquee({ store, adapter }) {
  const [drag, setDrag] = useState(null)
  if (!store || !adapter) return null
  const bounds = adapter.bounds
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null

  function handleDown(e) {
    if (e.button !== 0) return
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return
    const pt = pointerToSvg(e, svg)
    if (!pt) return
    setDrag({ start: pt, current: pt, additive: e.shiftKey })
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.stopPropagation()
  }
  function handleMove(e) {
    if (!drag) return
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return
    const pt = pointerToSvg(e, svg)
    if (!pt) return
    setDrag({ ...drag, current: pt })
  }
  function handleUp(e) {
    if (!drag) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const rect = {
      left: Math.min(drag.start.x, drag.current.x),
      right: Math.max(drag.start.x, drag.current.x),
      top: Math.min(drag.start.y, drag.current.y),
      bottom: Math.max(drag.start.y, drag.current.y),
    }
    const dragSize = Math.max(rect.right - rect.left, rect.bottom - rect.top)
    // < 3px = click, not drag. Treat as a click on empty space →
    // clear selection (or no-op when shift is held so the user
    // doesn't lose their accumulated selection by accident).
    if (dragSize < 3) {
      if (!drag.additive) store.clearSelection?.()
      setDrag(null)
      return
    }
    // Find every annotation whose pixel bbox intersects the marquee.
    // Locked / hidden annotations are still selectable — the user
    // might want to unlock or unhide them via the style bar.
    const hits = (store.annotations ?? [])
      .filter((a) => annotationIntersectsRect(a, adapter, rect))
      .map((a) => a.id)
    if (store.setSelectedMany) {
      store.setSelectedMany(hits, { additive: drag.additive })
    }
    setDrag(null)
  }

  // The hit rect is transparent but `pointerEvents: 'all'` makes it
  // catch events anywhere within the plot area — except where an
  // annotation shape is drawn on top of it (annotations are siblings
  // rendered AFTER, so SVG hit-testing favors them).
  return (
    <>
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill="transparent"
        style={{ pointerEvents: 'all', cursor: 'default' }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
      />
      {drag && (
        <rect
          x={Math.min(drag.start.x, drag.current.x)}
          y={Math.min(drag.start.y, drag.current.y)}
          width={Math.abs(drag.current.x - drag.start.x)}
          height={Math.abs(drag.current.y - drag.start.y)}
          fill="#2563eb"
          fillOpacity={0.08}
          stroke="#2563eb"
          strokeWidth={1}
          strokeDasharray="4,3"
          style={{ pointerEvents: 'none' }}
        />
      )}
    </>
  )
}

/** Map a pointer event's clientX/Y into the local SVG coordinate
 *  system. Shared helper duplicated from useAnnotationInteractions
 *  to keep this file self-contained — both end up identical. */
function pointerToSvg(e, svg) {
  if (!svg || typeof svg.createSVGPoint !== 'function') return null
  const pt = svg.createSVGPoint()
  pt.x = e.clientX
  pt.y = e.clientY
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const local = pt.matrixTransform(ctm.inverse())
  return { x: local.x, y: local.y }
}

/** Pixel-space bounding box of an annotation. Per-type because each
 *  shape carries different fields. Returns null when geometry doesn't
 *  resolve (off-domain values, axes mid-load). */
function annotationBBox(a, adapter) {
  const px = adapter.toPx(a.geometry)
  const bounds = adapter.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  if (!px) return null
  switch (a.type) {
    case 'vline':
      if (!Number.isFinite(px.x)) return null
      // Treat the line as a 1-px wide column spanning the plot.
      return {
        left: px.x - 1,
        right: px.x + 1,
        top: bounds.y,
        bottom: bounds.y + bounds.height,
      }
    case 'hline':
      if (!Number.isFinite(px.y)) return null
      return {
        left: bounds.x,
        right: bounds.x + bounds.width,
        top: px.y - 1,
        bottom: px.y + 1,
      }
    case 'vrange':
      if (!Number.isFinite(px.x_from) || !Number.isFinite(px.x_to)) return null
      return {
        left: Math.min(px.x_from, px.x_to),
        right: Math.max(px.x_from, px.x_to),
        top: bounds.y,
        bottom: bounds.y + bounds.height,
      }
    case 'hrange':
      if (!Number.isFinite(px.y_from) || !Number.isFinite(px.y_to)) return null
      return {
        left: bounds.x,
        right: bounds.x + bounds.width,
        top: Math.min(px.y_from, px.y_to),
        bottom: Math.max(px.y_from, px.y_to),
      }
    case 'point': {
      if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return null
      const r = 5
      return { left: px.x - r, right: px.x + r, top: px.y - r, bottom: px.y + r }
    }
    case 'rect':
      if (
        !Number.isFinite(px.x_from) ||
        !Number.isFinite(px.x_to) ||
        !Number.isFinite(px.y_from) ||
        !Number.isFinite(px.y_to)
      ) {
        return null
      }
      return {
        left: Math.min(px.x_from, px.x_to),
        right: Math.max(px.x_from, px.x_to),
        top: Math.min(px.y_from, px.y_to),
        bottom: Math.max(px.y_from, px.y_to),
      }
    case 'arrow': {
      if (
        !Number.isFinite(px.from?.x) ||
        !Number.isFinite(px.from?.y) ||
        !Number.isFinite(px.to?.x) ||
        !Number.isFinite(px.to?.y)
      ) {
        return null
      }
      return {
        left: Math.min(px.from.x, px.to.x),
        right: Math.max(px.from.x, px.to.x),
        top: Math.min(px.from.y, px.to.y),
        bottom: Math.max(px.from.y, px.to.y),
      }
    }
    case 'text': {
      // Text has no inherent size; approximate a label bbox around
      // the anchor point so marquee selection feels reasonable.
      if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return null
      return {
        left: px.x - 4,
        right: px.x + 60,
        top: px.y - 12,
        bottom: px.y + 6,
      }
    }
    default:
      return null
  }
}

/** Standard axis-aligned rectangle intersection. Annotations that
 *  span the chart (vline, hline, vrange, hrange) have one axis
 *  zero-thickness; the intersection still works because the
 *  inequalities below handle equality. */
function annotationIntersectsRect(a, adapter, rect) {
  const bbox = annotationBBox(a, adapter)
  if (!bbox) return false
  return !(
    bbox.right < rect.left ||
    bbox.left > rect.right ||
    bbox.bottom < rect.top ||
    bbox.top > rect.bottom
  )
}
