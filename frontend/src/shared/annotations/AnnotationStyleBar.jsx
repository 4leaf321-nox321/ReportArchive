import { Check, Eye, EyeOff, Trash2 } from 'lucide-react'
import { labelPositionFor } from './labelPosition'

/**
 * Inline style editor that floats next to the selected annotation(s).
 * Supports both single and multi-select:
 *   - Single: positions next to the annotation's label anchor; the
 *             swatch / border / opacity ring shows the CURRENT value.
 *   - Multi:  positions at the top-center of the chart's plot area;
 *             no current-value indicator since values may differ.
 *             Operations apply to every selected annotation.
 *
 *   <AnnotationStyleBar
 *     store={annotationStore}
 *     adapter={adapter}
 *   />
 *
 * Hosted as a sibling of `<AnnotationLabelEditor>` inside the host
 * widget's `position: relative` container.
 */
export function AnnotationStyleBar({ store, adapter, editingId, onDone }) {
  if (!store || !adapter) return null
  const selectedIds = store.selectedIds
  if (!selectedIds || selectedIds.size === 0) return null
  const ids = Array.from(selectedIds)
  // Hide the bar while the label editor is open for the (single)
  // selected annotation — they'd double-stack on the same anchor.
  if (ids.length === 1 && editingId === ids[0]) return null

  // Resolve the actual annotation objects so we can read current
  // style values + filter out locked ones (locked = no style edits).
  const annotations = ids
    .map((id) => store.annotations.find((a) => a.id === id))
    .filter(Boolean)
    .filter((a) => !a.locked)
  if (annotations.length === 0) return null

  const isMulti = annotations.length > 1
  // Single-select: show the active swatch ring at the current value.
  // Multi-select: leave indicators blank since values may differ
  //   across the selection (showing only one would be misleading).
  const sampleStyle = isMulti ? {} : (annotations[0].style ?? {})
  const currentColor = isMulti ? null : sampleStyle.color ?? null
  const currentBorder = isMulti ? null : sampleStyle.border ?? 'solid'
  const currentOpacity =
    !isMulti && typeof sampleStyle.opacity === 'number'
      ? sampleStyle.opacity
      : null
  // Visibility toggle reflects the AGGREGATE — only show "hidden"
  // when EVERY selected annotation is hidden. Mixed shows the eye
  // (treated as "make all visible" / "next click hides them all").
  const allHidden = annotations.every((a) => a.hidden)

  // Positioning — single uses the annotation's label anchor (close +
  // attached). Multi uses a fixed top-center of the plot area so the
  // bar doesn't jump around as different anchors are added.
  const bounds = adapter.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
  let pos
  let transformX
  if (isMulti) {
    pos = { x: bounds.x + bounds.width / 2, y: bounds.y, anchor: 'middle' }
    transformX = 'translateX(-50%)'
  } else {
    pos = labelPositionFor(annotations[0], adapter)
    if (!pos) return null
    transformX =
      pos.anchor === 'middle'
        ? 'translateX(-50%)'
        : pos.anchor === 'end'
          ? 'translateX(-100%)'
          : 'translateX(0)'
  }

  function updateStyle(patch) {
    for (const a of annotations) {
      store.update(a.id, (cur) => {
        const nextStyle = { ...(cur.style ?? {}), ...patch }
        for (const k of Object.keys(nextStyle)) {
          if (nextStyle[k] == null || nextStyle[k] === '') delete nextStyle[k]
        }
        const next = { ...cur }
        if (Object.keys(nextStyle).length === 0) delete next.style
        else next.style = nextStyle
        return next
      })
    }
  }
  function toggleHidden() {
    // Aggregate behavior: if any are visible, hide all; otherwise
    // unhide all. Keeps the bar's eye icon meaningful as a toggle.
    const nextHidden = !allHidden
    for (const a of annotations) {
      store.update(a.id, (cur) => {
        const next = { ...cur }
        if (nextHidden) next.hidden = true
        else delete next.hidden
        return next
      })
    }
  }
  function deleteAnnotations() {
    if (store.removeMany) {
      store.removeMany(annotations.map((a) => a.id))
    } else {
      for (const a of annotations) store.remove(a.id)
    }
  }
  // "완료" — closes the bar by clearing selection. Also signals the
  // host so it can drop the active creation tool (the user's "I'm
  // done with this one" affordance: without it, clicking the chart
  // anywhere else would just create another annotation because the
  // tool stays active for consecutive creation).
  function done() {
    store.clearSelection?.()
    onDone?.()
  }
  return (
    <div
      // `annotation-style-bar` class — recognized by interactions'
      // outside-click handlers so a tap inside this bar doesn't
      // commit / cancel the (non-existent) label edit.
      className="annotation-style-bar"
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y - 48,
        transform: transformX,
        zIndex: 14,
        pointerEvents: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        padding: '4px 6px',
        fontSize: 11,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {isMulti && (
        <>
          <span
            style={{
              padding: '0 4px',
              fontWeight: 600,
              color: '#374151',
              whiteSpace: 'nowrap',
            }}
          >
            {annotations.length}개 선택
          </span>
          <div style={{ width: 1, height: 18, background: '#e5e7eb' }} />
        </>
      )}
      {/* ── Color: 5-stop semantic palette. Click applies immediately
          — no separate "apply" button. The check mark on the active
          swatch makes the applied state obvious. ─────────────────── */}
      {SEMANTIC_COLORS.map((c) => {
        const active = currentColor === c.value
        return (
          <button
            key={c.value}
            type="button"
            title={`${c.label} — 클릭해서 적용`}
            onClick={() => updateStyle({ color: c.value })}
            style={{
              width: 22,
              height: 22,
              padding: 0,
              background: c.value,
              // Wrap the swatch in a ring on active so the size doesn't
              // jump when the user clicks. box-shadow keeps the swatch
              // dimensions stable while still providing clear feedback.
              border: '1px solid rgba(0,0,0,0.15)',
              boxShadow: active
                ? '0 0 0 2px #1f2937, inset 0 0 0 1px #fff'
                : 'none',
              borderRadius: 4,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
            }}
          >
            {active && <Check size={12} strokeWidth={3} />}
          </button>
        )
      })}
      <div style={{ width: 1, height: 18, background: '#e5e7eb' }} />
      {/* ── Border style: solid / dashed / dotted ───────────────── */}
      {BORDER_OPTIONS.map((b) => {
        const active = currentBorder === b.value
        return (
          <button
            key={b.value}
            type="button"
            title={b.label}
            onClick={() => updateStyle({ border: b.value })}
            style={{
              width: 22,
              height: 18,
              padding: 0,
              background: active ? '#eef2ff' : '#fff',
              border: active ? '1px solid #4f46e5' : '1px solid #d1d5db',
              borderRadius: 3,
              cursor: 'pointer',
              color: '#374151',
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            {b.glyph}
          </button>
        )
      })}
      <div style={{ width: 1, height: 18, background: '#e5e7eb' }} />
      {/* ── Opacity: 4-stop preset (slider would be too fiddly at
          this size) ───────────────────────────────────────────── */}
      {OPACITY_STEPS.map((step) => {
        const active = currentOpacity === step
        return (
          <button
            key={step}
            type="button"
            title={`투명도 ${Math.round(step * 100)}%`}
            onClick={() => updateStyle({ opacity: step })}
            style={{
              width: 22,
              height: 18,
              padding: 0,
              background: active ? '#eef2ff' : '#fff',
              border: active ? '1px solid #4f46e5' : '1px solid #d1d5db',
              borderRadius: 3,
              cursor: 'pointer',
              color: '#374151',
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            {Math.round(step * 100)}
          </button>
        )
      })}
      <div style={{ width: 1, height: 18, background: '#e5e7eb' }} />
      {/* ── Visibility (C5) ─────────────────────────────────────── */}
      <button
        type="button"
        title={allHidden ? '표시' : '숨기기'}
        onClick={toggleHidden}
        style={{
          width: 22,
          height: 18,
          padding: 0,
          background: '#fff',
          border: '1px solid #d1d5db',
          borderRadius: 3,
          cursor: 'pointer',
          color: allHidden ? '#9ca3af' : '#374151',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {allHidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      {/* ── Delete ──────────────────────────────────────────────── */}
      <button
        type="button"
        title={isMulti ? `삭제 (${annotations.length}개)` : '삭제 (Delete)'}
        onClick={deleteAnnotations}
        style={{
          width: 22,
          height: 18,
          padding: 0,
          background: '#fff',
          border: '1px solid #d1d5db',
          borderRadius: 3,
          cursor: 'pointer',
          color: '#dc2626',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Trash2 size={12} />
      </button>
      <div style={{ width: 1, height: 18, background: '#e5e7eb' }} />
      {/* ── 완료 — closes the bar AND drops the active creation tool,
          so the next chart click doesn't immediately make another
          annotation. Primary action, so styled darker. ─────────── */}
      <button
        type="button"
        title="완료 (Esc)"
        onClick={done}
        style={{
          width: 22,
          height: 18,
          padding: 0,
          background: '#1f2937',
          border: '1px solid #1f2937',
          borderRadius: 3,
          cursor: 'pointer',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Check size={12} strokeWidth={3} />
      </button>
    </div>
  )
}

// 5-stop semantic palette per C2. Names are Korean so the title
// tooltips match the UI language. Hex values picked to feel like a
// muted, print-friendly chart palette (matches the report-export
// aesthetic, not a brand palette).
const SEMANTIC_COLORS = [
  { value: '#dc2626', label: '위험' },
  { value: '#f59e0b', label: '주의' },
  { value: '#16a34a', label: '정상' },
  { value: '#2563eb', label: '정보' },
  { value: '#6b7280', label: '중립' },
]

const BORDER_OPTIONS = [
  { value: 'solid', label: '실선', glyph: '━' },
  { value: 'dashed', label: '점선', glyph: '┅' },
  { value: 'dotted', label: '점', glyph: '⋯' },
]

// Opacity presets — coarse on purpose. Users who need finer control
// can hand-edit the JSON, but the chip UI stays compact.
const OPACITY_STEPS = [0.25, 0.5, 0.75, 1]
