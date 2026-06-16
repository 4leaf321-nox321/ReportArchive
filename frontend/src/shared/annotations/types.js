/**
 * Annotation data model — shared by every widget that hosts annotations.
 *
 * The model is deliberately coordinate-space agnostic. The same shape
 * works for chart (data coordinates), image (image_pct), milestone
 * (date axis), and any future visual widget — each widget provides an
 * adapter that knows how to translate between this annotation's
 * geometry and screen pixels.
 *
 * Storage shape (round-trips through the backend as widget content):
 *
 *   {
 *     id: string,                 // stable UUID
 *     type: ANNOTATION_TYPE,      // see TYPES below
 *     coord_space: COORD_SPACE,   // default 'data'
 *     geometry: { ... },          // shape depends on type
 *     label?: { text, position },
 *     style?: { color, opacity, border, z },
 *     locked?: boolean,
 *     hidden?: boolean,
 *     series_key?: string,        // (charts) attach to a specific series
 *   }
 *
 * IMPORTANT: keep this in sync with backend/app/widgets/validation.py's
 * ANNOTATION_SCHEMA — the JSON Schema is the source of truth for
 * persistence. This module is just the convenience helpers the React
 * side uses to build / mutate / validate annotations.
 */

export const ANNOTATION_TYPES = Object.freeze([
  'vline',
  'vrange',
  'hline',
  'hrange',
  'point',
  'rect',
  'arrow',
  'text',
])

export const COORD_SPACES = Object.freeze([
  'data',
  'data_relative',
  'image_pct',
])

export const LABEL_POSITIONS = Object.freeze([
  'auto',
  'top',
  'bottom',
  'inside',
  'left',
  'right',
])

export const BORDER_STYLES = Object.freeze(['solid', 'dashed', 'dotted'])
export const Z_ORDERS = Object.freeze(['front', 'back'])

/** Geometry field names per type. The order matters for resize handles —
 *  the first pair is the "start" handle, the second the "end" handle. */
const GEOMETRY_SHAPE = Object.freeze({
  vline: ['x'],
  vrange: ['x_from', 'x_to'],
  hline: ['y'],
  hrange: ['y_from', 'y_to'],
  point: ['x', 'y'],
  rect: ['x_from', 'x_to', 'y_from', 'y_to'],
  arrow: ['from', 'to'], // each is { x, y }
  text: ['x', 'y'],
})

/** RFC-4122-ish v4 UUID. Crypto-backed when available, falls back to
 *  Math.random for environments that lack it (older Safari, jsdom).
 *  Annotation ids only need to be stable + unique within a widget, so
 *  the fallback's collision risk is fine in practice. */
export function generateAnnotationId() {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const hex = '0123456789abcdef'
  const out = new Array(36)
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out[i] = '-'
    else if (i === 14) out[i] = '4'
    else if (i === 19) out[i] = hex[(Math.random() * 4) | (8 & 0xf)]
    else out[i] = hex[(Math.random() * 16) | 0]
  }
  return out.join('')
}

/** Build a default geometry for a freshly-created annotation. Callers
 *  pass the seed coordinates from the user's first click/drag; this
 *  helper just ensures every required field exists so downstream
 *  validators don't trip. */
export function defaultGeometryFor(type, seed = {}) {
  switch (type) {
    case 'vline':
      return { x: seed.x ?? 0 }
    case 'hline':
      return { y: seed.y ?? 0 }
    case 'vrange':
      return { x_from: seed.x_from ?? 0, x_to: seed.x_to ?? 0 }
    case 'hrange':
      return { y_from: seed.y_from ?? 0, y_to: seed.y_to ?? 0 }
    case 'point':
      return { x: seed.x ?? 0, y: seed.y ?? 0 }
    case 'rect':
      return {
        x_from: seed.x_from ?? 0,
        x_to: seed.x_to ?? 0,
        y_from: seed.y_from ?? 0,
        y_to: seed.y_to ?? 0,
      }
    case 'arrow':
      return {
        from: { x: seed.from?.x ?? 0, y: seed.from?.y ?? 0 },
        to: { x: seed.to?.x ?? 0, y: seed.to?.y ?? 0 },
      }
    case 'text':
      return { x: seed.x ?? 0, y: seed.y ?? 0 }
    default:
      throw new Error(`Unknown annotation type: ${type}`)
  }
}

/** Build a fresh annotation. Callers typically only supply `type` and a
 *  seed geometry from the user's interaction; the rest defaults to a
 *  reasonable starting state that the editor's style controls can flip. */
export function createAnnotation({
  type,
  geometry,
  coord_space = 'data',
  label = null,
  style = null,
  series_key = null,
}) {
  if (!ANNOTATION_TYPES.includes(type)) {
    throw new Error(`Unsupported annotation type: ${type}`)
  }
  const out = {
    id: generateAnnotationId(),
    type,
    coord_space,
    geometry: defaultGeometryFor(type, geometry ?? {}),
  }
  if (label && typeof label.text === 'string' && label.text.length > 0) {
    out.label = { text: label.text, position: label.position ?? 'auto' }
    // 라벨 위치 미세조정(드래그) — annotation 기준 픽셀 오프셋. 0,0 이면 생략.
    const dx = Math.round(Number(label.offset?.dx) || 0)
    const dy = Math.round(Number(label.offset?.dy) || 0)
    if (dx !== 0 || dy !== 0) out.label.offset = { dx, dy }
  }
  if (style) {
    const pruned = pruneStyle(style)
    if (Object.keys(pruned).length > 0) out.style = pruned
  }
  if (typeof series_key === 'string' && series_key.length > 0) {
    out.series_key = series_key
  }
  return out
}

function pruneStyle(style) {
  const out = {}
  if (typeof style.color === 'string' && style.color.length > 0) {
    out.color = style.color
  }
  if (typeof style.opacity === 'number' && style.opacity >= 0 && style.opacity <= 1) {
    out.opacity = style.opacity
  }
  if (BORDER_STYLES.includes(style.border)) out.border = style.border
  if (Z_ORDERS.includes(style.z)) out.z = style.z
  // 설명선(leader) — 라벨을 떨어뜨렸을 때 anchor 와 잇는 연결선. true 일 때만 보존.
  if (style.leader === true) out.leader = true
  return out
}

/** Shape-check an annotation object. Used by tests + the store before it
 *  commits a change, so a programming bug never persists a broken
 *  annotation that the backend's JSON Schema would also reject.
 *
 *  Returns null on success, or a human-readable string describing the
 *  first problem found. Soft validation by design — the backend has the
 *  authoritative schema. */
export function validateAnnotation(a) {
  if (!a || typeof a !== 'object') return 'annotation must be an object'
  if (typeof a.id !== 'string' || a.id.length === 0) return 'missing id'
  if (!ANNOTATION_TYPES.includes(a.type)) return `unknown type: ${a.type}`
  if (a.coord_space != null && !COORD_SPACES.includes(a.coord_space)) {
    return `unknown coord_space: ${a.coord_space}`
  }
  if (!a.geometry || typeof a.geometry !== 'object') {
    return 'missing geometry'
  }
  const fields = GEOMETRY_SHAPE[a.type]
  for (const field of fields) {
    if (!(field in a.geometry)) {
      return `geometry missing field: ${field}`
    }
  }
  // Range types: from must be <= to (we normalize on commit, but check
  // here so a hand-edited save can't sneak through inverted ranges).
  if (a.type === 'vrange' && a.geometry.x_from > a.geometry.x_to) {
    return 'vrange: x_from must be <= x_to'
  }
  if (a.type === 'hrange' && a.geometry.y_from > a.geometry.y_to) {
    return 'hrange: y_from must be <= y_to'
  }
  if (a.type === 'rect') {
    if (a.geometry.x_from > a.geometry.x_to) return 'rect: x_from > x_to'
    if (a.geometry.y_from > a.geometry.y_to) return 'rect: y_from > y_to'
  }
  if (a.label != null) {
    if (typeof a.label !== 'object') return 'label must be an object'
    if (typeof a.label.text !== 'string') return 'label.text must be a string'
  }
  return null
}

/** Return a copy of `annotation` with `geometry` updated. Used by the
 *  store on every move/resize — keeps the rest of the object intact
 *  (style, label, lock, etc.) and re-runs the soft validator. */
export function withGeometry(annotation, nextGeometry) {
  return { ...annotation, geometry: { ...annotation.geometry, ...nextGeometry } }
}

/** Normalize a range/rect so from <= to on every axis. Callers can be
 *  loose during a drag (the user might pull from right to left) and
 *  then snap to this on commit. */
export function normalizeGeometry(type, geometry) {
  if (type === 'vrange') {
    const [lo, hi] =
      geometry.x_from <= geometry.x_to
        ? [geometry.x_from, geometry.x_to]
        : [geometry.x_to, geometry.x_from]
    return { x_from: lo, x_to: hi }
  }
  if (type === 'hrange') {
    const [lo, hi] =
      geometry.y_from <= geometry.y_to
        ? [geometry.y_from, geometry.y_to]
        : [geometry.y_to, geometry.y_from]
    return { y_from: lo, y_to: hi }
  }
  if (type === 'rect') {
    const [xlo, xhi] =
      geometry.x_from <= geometry.x_to
        ? [geometry.x_from, geometry.x_to]
        : [geometry.x_to, geometry.x_from]
    const [ylo, yhi] =
      geometry.y_from <= geometry.y_to
        ? [geometry.y_from, geometry.y_to]
        : [geometry.y_to, geometry.y_from]
    return { x_from: xlo, x_to: xhi, y_from: ylo, y_to: yhi }
  }
  return geometry
}

/** Names of geometry fields a given annotation uses — handy for the
 *  resize-handle code (which iterates fields) and for tests. */
export function geometryFields(type) {
  return GEOMETRY_SHAPE[type] ?? []
}
