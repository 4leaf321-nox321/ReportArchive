import { useCallback, useEffect, useRef, useState } from 'react'

// 라벨 텍스트 적용 — 변화가 없으면 *원본 a 를 그대로* 반환해 store.update 가
// no-op(새 배열 미생성)이 되게 한다. 라벨 없는 점에 빈 라벨을 "commit" 하면
// 매번 `{...a}`(새 객체)를 반환해 store 가 새 배열을 만들고 onChange→리렌더가
// 돌아 무한 루프가 났었다(라벨 안 붙이고 점 여러 개 클릭 시 freeze).
function applyLabelText(a, rawText) {
  const trimmed = (rawText ?? '').trim()
  if (trimmed === '') {
    if (!a.label) return a // 이미 라벨 없음 → 변화 없음
    const next = { ...a }
    delete next.label
    return next
  }
  if (a.label?.text === trimmed) return a // 동일 텍스트 → 변화 없음
  return { ...a, label: { text: trimmed, position: a.label?.position ?? 'auto' } }
}

/**
 * Interaction layer for annotation editing — drag-to-move + double-click
 * label edit. Pairs with an `AnnotationStore` (provides the data + undo
 * history) and a host adapter (translates pixels ↔ data coordinates).
 *
 * Selection works through pointerdown/pointerup so we can distinguish
 * "click → select" from "drag → move":
 *   - pointerdown on body  → record start state, capture pointer
 *   - movement past 6px    → flip into drag mode; store.moveGeometry
 *                            with `coalesce: true` so the entire drag
 *                            collapses into ONE undo step
 *   - pointerup before 6px → treat as click, store.setSelected
 *   - pointerup after drag → store.commitNormalized (clamps range
 *                            from↔to so the inverted-drag case lands
 *                            with from<=to)
 *
 * Double-click on a label opens an inline `<input>` (rendered by the
 * host as a DOM overlay) for re-editing the label text. Enter / blur
 * commits, Esc cancels.
 *
 * Robustness rules baked in to avoid freezes:
 *   - editingId / editingText are mirrored into refs so callbacks read
 *     the latest values without stale-closure traps.
 *   - Auto-edit on creation tracks the last-processed `newlyAddedId`
 *     via a ref so the effect can't re-fire for the same id.
 *   - When a new annotation is auto-edited while another edit is
 *     active, the previous edit is committed FIRST (using ref values,
 *     so no race against React state batching).
 *   - commitEditingLabel is idempotent (no-op when no edit is open).
 */
const DRAG_THRESHOLD_PX = 6

export function useAnnotationInteractions({ store, adapter, readOnly }) {
  const dragRef = useRef(null)
  const adapterRef = useRef(adapter)
  const storeRef = useRef(store)
  useEffect(() => {
    adapterRef.current = adapter
  })
  useEffect(() => {
    storeRef.current = store
  })

  const [editingId, setEditingId] = useState(null)
  const [editingText, setEditingText] = useState('')
  // Refs that mirror the edit state. Callbacks (commit, outside-click
  // handler) read from these instead of capturing stale state via
  // useCallback closures — that path used to invalidate the document
  // mousedown listener on every keystroke.
  const editingIdRef = useRef(editingId)
  const editingTextRef = useRef(editingText)
  useEffect(() => {
    editingIdRef.current = editingId
  })
  useEffect(() => {
    editingTextRef.current = editingText
  })

  // Commits the currently-active edit. Reads from refs so it can be
  // called from anywhere (effects, document listeners, blur handlers)
  // without worrying about stale closures. Idempotent: no-op when no
  // edit is open.
  const commitEditingLabel = useCallback(() => {
    const id = editingIdRef.current
    if (!id) return
    const text = editingTextRef.current
    setEditingId(null)
    setEditingText('')
    const s = storeRef.current
    if (!s) return
    s.update(id, (a) => applyLabelText(a, text))
  }, [])

  // Commits an active edit WITHOUT touching React state — used when we
  // need to commit "synchronously now" inside another setState path
  // (the auto-edit handoff between annotations).
  const commitEditingLabelSilent = useCallback(() => {
    const id = editingIdRef.current
    if (!id) return false
    const text = editingTextRef.current
    const s = storeRef.current
    if (!s) return false
    s.update(id, (a) => applyLabelText(a, text))
    return true
  }, [])

  const cancelEditingLabel = useCallback(() => {
    setEditingId(null)
    setEditingText('')
  }, [])

  // Auto-enter label edit mode after creation. Guarded against:
  //   - re-firing for the same id (lastProcessedId ref)
  //   - clobbering an in-flight edit without committing first
  const lastProcessedAddedIdRef = useRef(null)
  useEffect(() => {
    const id = store?.newlyAddedId
    if (!id) return
    if (lastProcessedAddedIdRef.current === id) return
    lastProcessedAddedIdRef.current = id
    // If another label is being edited, commit it first so the user
    // doesn't lose their typed text when they rapidly create another
    // annotation. Silent commit avoids extra setState in this effect.
    if (editingIdRef.current && editingIdRef.current !== id) {
      commitEditingLabelSilent()
    }
    const annot = store.annotations.find((a) => a.id === id)
    if (annot) {
      setEditingId(id)
      setEditingText(annot.label?.text ?? '')
    }
    store.clearNewlyAddedId?.()
  }, [store, store?.newlyAddedId, commitEditingLabelSilent])

  // ──────────────────────────────────────────────────────────────────
  // Body drag handlers — drag-to-move + click-to-select
  // ──────────────────────────────────────────────────────────────────
  const onBodyPointerDown = useCallback(
    (annotation, e) => {
      if (readOnly || annotation.locked) return
      e.stopPropagation()
      const svg = e.currentTarget?.ownerSVGElement
      if (!svg) return
      const pt = pointerToSvg(e, svg)
      if (!pt) return
      dragRef.current = {
        mode: 'body',
        id: annotation.id,
        startGeom: annotation.geometry,
        startPx: pt,
        svg,
        moved: false,
        additive: e.shiftKey,
        annotationType: annotation.type,
      }
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    [readOnly],
  )

  // Endpoint-resize for range-type annotations. `handle` names which
  // single field gets updated (e.g. 'x_from' for vrange's left edge,
  // 'from' for an arrow tail). Body translate isn't a resize — that
  // path stays on onBodyPointerDown.
  const onHandlePointerDown = useCallback(
    (annotation, handle, e) => {
      if (readOnly || annotation.locked) return
      e.stopPropagation()
      const svg = e.currentTarget?.ownerSVGElement
      if (!svg) return
      const pt = pointerToSvg(e, svg)
      if (!pt) return
      dragRef.current = {
        mode: 'handle',
        handle,
        id: annotation.id,
        startGeom: annotation.geometry,
        startPx: pt,
        svg,
        moved: false,
        annotationType: annotation.type,
      }
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    [readOnly],
  )

  useEffect(() => {
    function move(e) {
      const d = dragRef.current
      if (!d) return
      const pt = pointerToSvg(e, d.svg)
      if (!pt) return
      const dx = pt.x - d.startPx.x
      const dy = pt.y - d.startPx.y
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return
      d.moved = true
      const adapt = adapterRef.current
      const s = storeRef.current
      if (!adapt || !s) return
      // Shift suspends snap-to-nearest so the user can place at the
      // exact pixel — same convention used in most graphics editors.
      const useSnap = !e.shiftKey
      let newGeom = null
      if (d.mode === 'handle') {
        newGeom = resizeGeometry(d.annotationType, d.startGeom, d.handle, pt, adapt)
      } else {
        newGeom = translateGeometry(d.annotationType, d.startGeom, dx, dy, adapt)
      }
      if (!newGeom) return
      if (useSnap) newGeom = snapGeometry(d.annotationType, newGeom, adapt)
      s.moveGeometry(d.id, newGeom, { coalesce: true })
    }
    function up() {
      const d = dragRef.current
      if (!d) return
      const s = storeRef.current
      if (s) {
        if (d.moved) {
          s.commitNormalized(d.id)
        } else if (d.mode === 'body') {
          s.setSelected(d.id, { additive: d.additive })
        }
      }
      dragRef.current = null
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
  }, [])

  const onLabelDoubleClick = useCallback(
    (annotation, e) => {
      if (readOnly || annotation.locked) return
      e?.stopPropagation?.()
      // If a different annotation is currently being edited, commit it
      // before flipping to this one.
      if (editingIdRef.current && editingIdRef.current !== annotation.id) {
        commitEditingLabelSilent()
      }
      setEditingId(annotation.id)
      setEditingText(annotation.label?.text ?? '')
    },
    [readOnly, commitEditingLabelSilent],
  )

  // Cancel any in-flight label edit when the user clicks elsewhere.
  // The listener only attaches while editing is active; the
  // `.annotation-label-editor` class on the editor's wrapper marks
  // clicks that should NOT count as outside.
  useEffect(() => {
    if (!editingId) return undefined
    function onDocClick(e) {
      const t = e.target
      if (t instanceof Element && t.closest('.annotation-label-editor')) return
      commitEditingLabel()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [editingId, commitEditingLabel])

  return {
    onBodyPointerDown,
    onHandlePointerDown,
    onLabelDoubleClick,
    editingId,
    editingText,
    setEditingText,
    commitEditingLabel,
    cancelEditingLabel,
  }
}

/** Map a pointer event's clientX/Y into the local SVG coordinate
 *  system (the same space adapter.toPx / fromPx operate in). */
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

/** Update a SINGLE endpoint of a range-type annotation. `handle` names
 *  which field gets the new value — every other field is kept from
 *  `startGeom`. The new value comes from the pointer's pixel position
 *  converted back to data coords via the adapter. */
function resizeGeometry(type, startGeom, handle, pt, adapter) {
  function dataX() {
    const out = adapter.fromPx({ x: pt.x })
    return out?.x
  }
  function dataY() {
    const out = adapter.fromPx({ y: pt.y })
    return out?.y
  }
  switch (type) {
    case 'vrange':
      if (handle === 'x_from') return { ...startGeom, x_from: dataX() }
      if (handle === 'x_to') return { ...startGeom, x_to: dataX() }
      return null
    case 'hrange':
      if (handle === 'y_from') return { ...startGeom, y_from: dataY() }
      if (handle === 'y_to') return { ...startGeom, y_to: dataY() }
      return null
    case 'rect': {
      // Corner handles update BOTH axes (rect lives in 2-D so a corner
      // drag should move both x and y together). The handle name
      // encodes the two data-coord fields it owns.
      const x = dataX()
      const y = dataY()
      if (handle === 'x_from_y_from') return { ...startGeom, x_from: x, y_from: y }
      if (handle === 'x_from_y_to') return { ...startGeom, x_from: x, y_to: y }
      if (handle === 'x_to_y_from') return { ...startGeom, x_to: x, y_from: y }
      if (handle === 'x_to_y_to') return { ...startGeom, x_to: x, y_to: y }
      return null
    }
    case 'arrow':
      if (handle === 'from') return { ...startGeom, from: { x: dataX(), y: dataY() } }
      if (handle === 'to') return { ...startGeom, to: { x: dataX(), y: dataY() } }
      return null
    default:
      return null
  }
}

/** Snap every coordinate field of a geometry to the adapter's snap
 *  function. Categorical x stays as the band label (snap is a no-op).
 *  Continuous numeric fields round to a "nice" step. Called after
 *  translate/resize unless the user holds Shift. */
function snapGeometry(type, geometry, adapter) {
  if (typeof adapter.snap !== 'function') return geometry
  function sx(v) {
    return v == null ? v : adapter.snap(v, 'x')
  }
  function sy(v) {
    return v == null ? v : adapter.snap(v, 'y')
  }
  switch (type) {
    case 'vline':
      return { x: sx(geometry.x) }
    case 'hline':
      return { y: sy(geometry.y) }
    case 'point':
    case 'text':
      return { x: sx(geometry.x), y: sy(geometry.y) }
    case 'vrange':
      return { x_from: sx(geometry.x_from), x_to: sx(geometry.x_to) }
    case 'hrange':
      return { y_from: sy(geometry.y_from), y_to: sy(geometry.y_to) }
    case 'rect':
      return {
        x_from: sx(geometry.x_from),
        x_to: sx(geometry.x_to),
        y_from: sy(geometry.y_from),
        y_to: sy(geometry.y_to),
      }
    case 'arrow':
      return {
        from: { x: sx(geometry.from?.x), y: sy(geometry.from?.y) },
        to: { x: sx(geometry.to?.x), y: sy(geometry.to?.y) },
      }
    default:
      return geometry
  }
}

/** Shift every coordinate field of an annotation's geometry by a pixel
 *  delta, then convert back to data coords via the adapter. */
function translateGeometry(type, startGeom, dx_px, dy_px, adapter) {
  const startPx = adapter.toPx(startGeom)
  if (!startPx) return null

  function dataX(px) {
    const out = adapter.fromPx({ x: px })
    return out?.x
  }
  function dataY(px) {
    const out = adapter.fromPx({ y: px })
    return out?.y
  }

  switch (type) {
    case 'vline':
      return { x: dataX(startPx.x + dx_px) }
    case 'hline':
      return { y: dataY(startPx.y + dy_px) }
    case 'point':
    case 'text':
      return {
        x: dataX(startPx.x + dx_px),
        y: dataY(startPx.y + dy_px),
      }
    case 'vrange':
      return {
        x_from: dataX(startPx.x_from + dx_px),
        x_to: dataX(startPx.x_to + dx_px),
      }
    case 'hrange':
      return {
        y_from: dataY(startPx.y_from + dy_px),
        y_to: dataY(startPx.y_to + dy_px),
      }
    case 'rect':
      return {
        x_from: dataX(startPx.x_from + dx_px),
        x_to: dataX(startPx.x_to + dx_px),
        y_from: dataY(startPx.y_from + dy_px),
        y_to: dataY(startPx.y_to + dy_px),
      }
    case 'arrow':
      return {
        from: {
          x: dataX(startPx.from.x + dx_px),
          y: dataY(startPx.from.y + dy_px),
        },
        to: {
          x: dataX(startPx.to.x + dx_px),
          y: dataY(startPx.to.y + dy_px),
        },
      }
    default:
      return null
  }
}
