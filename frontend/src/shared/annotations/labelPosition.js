/**
 * Per-type label position helper — mirrors the placement logic each
 * drawer uses inside AnnotationLayer so hosts that render the label
 * editor as an EXTERNAL DOM overlay (rather than via SVG foreignObject)
 * can land the editor at the same pixel coordinates.
 *
 * Returns `{ x, y, anchor }` in adapter pixel coordinates (the same
 * space adapter.toPx outputs). `anchor` is one of 'start' | 'middle' |
 * 'end' — converts to text-anchor for SVG and to a CSS translateX
 * percentage for HTML positioning.
 *
 * Returns `null` when the annotation's geometry doesn't resolve to
 * valid pixels yet (axes still loading, value off-domain, etc.).
 */
export function labelPositionFor(annotation, adapter) {
  if (!annotation || !adapter) return null
  const px = adapter.toPx(annotation.geometry)
  const bounds = adapter.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  if (!px) return null
  // 라벨 위치 미세조정(드래그) — 기본 위치에 픽셀 오프셋을 더한다. 라벨 렌더
  // (AnnotationLabel)와 동일하게 적용돼 편집기 오버레이·스타일바가 같은 곳에 뜬다.
  const off = annotation.label?.offset
  const withOffset = (base) =>
    base && off
      ? { ...base, x: base.x + (off.dx || 0), y: base.y + (off.dy || 0) }
      : base
  return withOffset(_basePositionFor(annotation, px, bounds))
}

function _basePositionFor(annotation, px, bounds) {
  switch (annotation.type) {
    case 'vline':
      if (!Number.isFinite(px.x)) return null
      return { x: px.x, y: bounds.y, anchor: 'middle' }
    case 'hline':
      if (!Number.isFinite(px.y)) return null
      return { x: bounds.x + bounds.width, y: px.y - 4, anchor: 'end' }
    case 'vrange': {
      if (!Number.isFinite(px.x_from) || !Number.isFinite(px.x_to)) return null
      const cx = (px.x_from + px.x_to) / 2
      return { x: cx, y: bounds.y, anchor: 'middle' }
    }
    case 'hrange': {
      if (!Number.isFinite(px.y_from) || !Number.isFinite(px.y_to)) return null
      const cy = (px.y_from + px.y_to) / 2
      return { x: bounds.x + bounds.width, y: cy + 4, anchor: 'end' }
    }
    case 'point':
      if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return null
      return { x: px.x, y: px.y - 10, anchor: 'middle' }
    case 'rect': {
      if (
        !Number.isFinite(px.x_from) ||
        !Number.isFinite(px.x_to) ||
        !Number.isFinite(px.y_from) ||
        !Number.isFinite(px.y_to)
      ) {
        return null
      }
      return {
        x: Math.min(px.x_from, px.x_to),
        y: Math.min(px.y_from, px.y_to) - 4,
        anchor: 'start',
      }
    }
    case 'arrow':
      if (
        !Number.isFinite(px.from?.x) ||
        !Number.isFinite(px.from?.y) ||
        !Number.isFinite(px.to?.x) ||
        !Number.isFinite(px.to?.y)
      ) {
        return null
      }
      return {
        x: (px.from.x + px.to.x) / 2,
        y: (px.from.y + px.to.y) / 2 - 6,
        anchor: 'middle',
      }
    case 'text':
      if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return null
      return { x: px.x, y: px.y, anchor: 'start' }
    default:
      return null
  }
}
