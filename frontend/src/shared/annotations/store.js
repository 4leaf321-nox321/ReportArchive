import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createAnnotation,
  normalizeGeometry,
  validateAnnotation,
  withGeometry,
} from './types'

/**
 * State + history container for an annotation layer.
 *
 * Owned by the host widget — it passes `annotations` in and gets the
 * mutated array back through `onChange`. We keep a parallel local copy
 * so the user's interactions feel snappy even if the host throttles or
 * defers committing to its outer content state (charts in particular do
 * a heavy `useDeferredValue` dance during typing).
 *
 * Selection + history are purely local — they don't round-trip to the
 * backend. Each editing surface gets its own undo stack scoped to that
 * widget instance.
 *
 *   const store = useAnnotationStore({ annotations, onChange })
 *   store.annotations     // ← current array (echoed from props on every load)
 *   store.selectedIds     // ← Set<string>
 *   store.history.undo()  // ← roll back the most recent change
 *
 *   store.add({ type: 'vline', geometry: { x: 5 } })
 *   store.update(id, (a) => withGeometry(a, { x: 7 }))
 *   store.remove(id)
 *   store.setSelected(id, { additive })
 *   store.toggleHidden(id)
 *   store.toggleLocked(id)
 *
 * Every mutation pushes the *previous* annotations onto an undo stack
 * (with coalescing — rapid keystrokes during a drag collapse into one
 * undo step). The store calls `onChange(next)` after every mutation, so
 * the host can persist however it likes.
 */
export function useAnnotationStore({ annotations, onChange }) {
  // Echo prop into local state so the user's draft survives a parent
  // re-render that comes back with the same array reference.
  const [local, setLocal] = useState(annotations ?? [])
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  // When the prop changes by identity (host swapped to a different
  // saved value, e.g., after reload), reset our local copy. We
  // compare by reference, not contents — host is responsible for not
  // creating spurious new arrays.
  const lastSeenProp = useRef(annotations)
  useEffect(() => {
    if (annotations !== lastSeenProp.current) {
      lastSeenProp.current = annotations
      setLocal(annotations ?? [])
    }
  }, [annotations])

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // ID of the most-recently-created annotation. The interactions hook
  // watches this so it can auto-enter label-edit mode immediately after
  // creation — without it, every new vline / point sits there without
  // a label and the user has to discover the double-click affordance.
  // Consumers MUST clear it (via clearNewlyAddedId) once they've acted,
  // otherwise re-mounting the consuming component would re-trigger
  // the auto-edit.
  const [newlyAddedId, setNewlyAddedId] = useState(null)

  // History stacks. Each entry is the annotations array from BEFORE the
  // change, so undo restores it. We cap depth so a noisy editor doesn't
  // grow unbounded.
  const HISTORY_LIMIT = 50
  const COALESCE_MS = 400
  const historyRef = useRef({ undo: [], redo: [], lastPush: 0 })

  /** Apply `next` (a function or an array) and commit. Coalesces with
   *  the previous push when the user is mid-burst, so a click-drag
   *  ends up as a single undo step instead of one per pointer event. */
  const apply = useCallback(
    (next, options) => {
      setLocal((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next
        if (resolved === prev) return prev
        const stacks = historyRef.current
        const now = Date.now()
        const coalesce = options?.coalesce === true
        const recent = now - stacks.lastPush < COALESCE_MS
        if (!(coalesce && recent)) {
          stacks.undo.push(prev)
          if (stacks.undo.length > HISTORY_LIMIT) stacks.undo.shift()
          stacks.redo = []
        }
        stacks.lastPush = now
        // Defer the host notification so React's batching gathers
        // multiple synchronous calls (e.g. apply during a drag) into
        // one render path. queueMicrotask keeps the order deterministic
        // without falling behind a paint.
        queueMicrotask(() => {
          onChangeRef.current?.(resolved)
        })
        return resolved
      })
    },
    [],
  )

  // --- Mutations -----------------------------------------------------------

  const add = useCallback(
    (init) => {
      const a = createAnnotation(init)
      const err = validateAnnotation(a)
      if (err) {
        // Don't persist obviously broken annotations — this catches
        // programmer mistakes (the backend's JSON Schema would reject
        // them on save anyway, but late).
        if (typeof console !== 'undefined') console.warn('skip add:', err, a)
        return null
      }
      apply((prev) => [...prev, a])
      // Auto-select the new one so the toolbar / sidebar lights up.
      setSelectedIds(new Set([a.id]))
      // Signal "just added" so interactions can flip into label-edit
      // mode automatically. Consumer clears this via clearNewlyAddedId
      // once they've handled it.
      setNewlyAddedId(a.id)
      return a.id
    },
    [apply],
  )

  const clearNewlyAddedId = useCallback(() => setNewlyAddedId(null), [])

  const update = useCallback(
    (id, mutator, options) => {
      apply((prev) => {
        let changed = false
        const next = prev.map((a) => {
          if (a.id !== id) return a
          const updated = typeof mutator === 'function' ? mutator(a) : mutator
          if (!updated || updated === a) return a
          changed = true
          return updated
        })
        return changed ? next : prev
      }, options)
    },
    [apply],
  )

  /** Convenience: nudge geometry by a delta. Used by drag/resize. */
  const moveGeometry = useCallback(
    (id, deltaOrNext, options) => {
      update(
        id,
        (a) => {
          const nextGeom =
            typeof deltaOrNext === 'function'
              ? deltaOrNext(a.geometry)
              : { ...a.geometry, ...deltaOrNext }
          return withGeometry(a, nextGeom)
        },
        options,
      )
    },
    [update],
  )

  /** Run normalizeGeometry on a range/rect after a drag finishes so
   *  the inverted "drag from right to left" case lands with from<=to. */
  const commitNormalized = useCallback(
    (id) => {
      update(id, (a) => withGeometry(a, normalizeGeometry(a.type, a.geometry)))
    },
    [update],
  )

  const remove = useCallback(
    (id) => {
      apply((prev) => prev.filter((a) => a.id !== id))
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    },
    [apply],
  )

  const removeMany = useCallback(
    (ids) => {
      const ban = new Set(ids)
      apply((prev) => prev.filter((a) => !ban.has(a.id)))
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    },
    [apply],
  )

  const toggleHidden = useCallback(
    (id) => {
      update(id, (a) => ({ ...a, hidden: !a.hidden }))
    },
    [update],
  )

  const toggleLocked = useCallback(
    (id) => {
      update(id, (a) => ({ ...a, locked: !a.locked }))
    },
    [update],
  )

  // --- Selection -----------------------------------------------------------

  const setSelected = useCallback((id, options) => {
    setSelectedIds((prev) => {
      if (id == null) return new Set()
      if (options?.additive) {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }
      return new Set([id])
    })
  }, [])

  /** Set selection from an iterable of IDs in one go. Used by marquee
   *  selection — committing each ID through `setSelected({additive})`
   *  would re-render between every add. */
  const setSelectedMany = useCallback((ids, options) => {
    setSelectedIds((prev) => {
      const incoming = new Set(ids ?? [])
      if (options?.additive) {
        const next = new Set(prev)
        for (const id of incoming) next.add(id)
        return next
      }
      return incoming
    })
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const isSelected = useCallback((id) => selectedIds.has(id), [selectedIds])

  // --- History -------------------------------------------------------------

  const undo = useCallback(() => {
    const stacks = historyRef.current
    if (stacks.undo.length === 0) return
    const prev = stacks.undo.pop()
    setLocal((cur) => {
      stacks.redo.push(cur)
      if (stacks.redo.length > HISTORY_LIMIT) stacks.redo.shift()
      stacks.lastPush = Date.now()
      queueMicrotask(() => onChangeRef.current?.(prev))
      return prev
    })
  }, [])

  const redo = useCallback(() => {
    const stacks = historyRef.current
    if (stacks.redo.length === 0) return
    const next = stacks.redo.pop()
    setLocal((cur) => {
      stacks.undo.push(cur)
      if (stacks.undo.length > HISTORY_LIMIT) stacks.undo.shift()
      stacks.lastPush = Date.now()
      queueMicrotask(() => onChangeRef.current?.(next))
      return next
    })
  }, [])

  // --- Selectors -----------------------------------------------------------

  const selected = useMemo(
    () => local.filter((a) => selectedIds.has(a.id)),
    [local, selectedIds],
  )

  return {
    annotations: local,
    selectedIds,
    selected,
    newlyAddedId,
    clearNewlyAddedId,
    add,
    update,
    moveGeometry,
    commitNormalized,
    remove,
    removeMany,
    toggleHidden,
    toggleLocked,
    setSelected,
    setSelectedMany,
    clearSelection,
    isSelected,
    history: { undo, redo },
  }
}
