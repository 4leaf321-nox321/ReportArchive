import { useEffect, useRef } from 'react'
import { labelPositionFor } from './labelPosition'

/**
 * DOM-overlay label editor — replaces the SVG <foreignObject> path
 * because the latter is brittle across chart-host stacking contexts
 * (BarChart bars composite over foreignObject content in some
 * browsers, making the input invisible). Hosts mount this in the
 * same `position: relative` container as their chart / image SVG;
 * the editor positions itself absolutely using `bounds` + the per-
 * type label coordinates.
 *
 *   <div className="relative">
 *     <Chart ... />
 *     <AnnotationLabelEditor
 *       interactions={interactions}
 *       annotations={store.annotations}
 *       adapter={adapter}
 *     />
 *   </div>
 *
 * Renders nothing when no annotation is being edited.
 */
export function AnnotationLabelEditor({ interactions, annotations, adapter }) {
  const inputRef = useRef(null)
  const editingId = interactions?.editingId

  // Auto-focus the input on every mount (i.e. every time editingId
  // flips to a new value). We focus in an effect rather than via the
  // `autoFocus` prop so re-runs work even if React reuses the same
  // input across edits.
  useEffect(() => {
    if (!editingId) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select?.()
  }, [editingId])

  if (!editingId || !interactions || !adapter) return null
  const annotation = (annotations ?? []).find((a) => a.id === editingId)
  if (!annotation) return null
  const pos = labelPositionFor(annotation, adapter)
  if (!pos) return null
  const color = annotation.style?.color ?? '#6b7280'
  // The text input is centered/anchored using the same anchor the
  // static label uses. CSS translateX shifts the box accordingly.
  const transformX =
    pos.anchor === 'middle'
      ? 'translateX(-50%)'
      : pos.anchor === 'end'
        ? 'translateX(-100%)'
        : 'translateX(0)'
  return (
    <div
      // `annotation-label-editor` class is recognized by
      // useAnnotationInteractions's outside-click commit handler.
      className="annotation-label-editor"
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y - 18,
        transform: transformX,
        zIndex: 15,
        pointerEvents: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={interactions.editingText ?? ''}
        onChange={(e) => interactions.setEditingText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            interactions.commitEditingLabel()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            interactions.cancelEditingLabel()
          }
          // Stop other widget-level keybindings (Delete to remove the
          // selected annotation, etc.) from firing while editing.
          e.stopPropagation()
        }}
        onBlur={(e) => {
          // Blur fires when the user tabs to the "skip" button too —
          // don't commit in that case or the skip click would race
          // against an empty-string commit (same end-state here, but
          // confusing if commit grows side effects later).
          const nextFocus = e.relatedTarget
          if (
            nextFocus instanceof Element &&
            nextFocus.closest('.annotation-label-editor')
          ) {
            return
          }
          interactions.commitEditingLabel()
        }}
        placeholder="라벨 (선택)"
        style={{
          minWidth: 120,
          width: `${Math.max(120, ((interactions.editingText ?? '').length + 2) * 8)}px`,
          height: 22,
          fontSize: 11,
          fontWeight: 600,
          color,
          border: `1px solid ${color}`,
          borderRadius: 3,
          background: '#fff',
          padding: '0 4px',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {/* Explicit "no label" exit — same effect as Esc, but
          discoverable as a button. Equivalent to leaving the field
          empty and pressing Enter; we use cancelEditingLabel so the
          intent is unambiguous (don't write/clear, just exit). */}
      <button
        type="button"
        title="라벨 없이 닫기 (Esc)"
        onClick={() => interactions.cancelEditingLabel()}
        style={{
          width: 22,
          height: 22,
          padding: 0,
          fontSize: 11,
          lineHeight: 1,
          color: '#6b7280',
          background: '#fff',
          border: '1px solid #d1d5db',
          borderRadius: 3,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ✕
      </button>
    </div>
  )
}
