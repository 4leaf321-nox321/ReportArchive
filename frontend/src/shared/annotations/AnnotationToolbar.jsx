import {
  ArrowUpRight,
  Circle,
  Columns2,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Rows2,
  Square,
  Type,
  X,
} from 'lucide-react'
import { cn } from '@/shared/lib/utils'

/**
 * Mode-toggle strip for the annotation editor. Sits above (or inside)
 * the host widget's chrome — clicking a tool puts the editor into
 * "next click/drag creates a <type>" mode; clicking the same tool again
 * (or the cancel button) drops back to idle.
 *
 * The strip is intentionally compact + icon-only with tooltip labels so
 * it sits cleanly next to chart-specific controls (chart_type toggle,
 * axis title editor, etc.) without dominating the toolbar row.
 *
 *   <AnnotationToolbar
 *     tool={tool}
 *     onChange={setTool}
 *     supportedTypes={['vline','vrange','hline','hrange','point']}
 *   />
 *
 * `supportedTypes` defaults to all 8 — host widgets can opt out of
 * types that don't make sense (e.g. a 1-D timeline only supports
 * vrange + point + text).
 */
export function AnnotationToolbar({
  tool,
  onChange,
  supportedTypes,
  disabled = false,
  className = '',
}) {
  const allowed = new Set(supportedTypes ?? TOOL_ORDER)
  const visibleTools = TOOL_ORDER.filter((t) => allowed.has(t.value))
  function pick(next) {
    if (disabled) return
    // Clicking the active tool again toggles it off — feels more
    // natural than forcing the user to find a separate cancel target.
    onChange(tool === next ? null : next)
  }
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border bg-background px-1 py-0.5 shadow-sm',
        disabled && 'opacity-50 pointer-events-none',
        className,
      )}
    >
      {visibleTools.map((t) => {
        const Icon = t.icon
        const active = tool === t.value
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => pick(t.value)}
            title={t.label}
            aria-pressed={active}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground',
              'hover:bg-muted hover:text-foreground transition-colors',
              active && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        )
      })}
      {/* Visible cancel — same effect as clicking the active tool, but
          discoverable as a dedicated control. Only shown when a tool is
          actually active so the toolbar stays compact in the idle case. */}
      {tool && !disabled && (
        <>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => onChange(null)}
            title="취소 (Esc)"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  )
}

// Display order matches the natural reading: vertical / horizontal /
// point / shape / freeform. Each entry maps annotation type → label +
// icon (lucide). The order is also reused as the default
// `supportedTypes` fallback for hosts that don't constrain.
const TOOL_ORDER = [
  { value: 'vline', label: '세로선', icon: MoveVertical },
  { value: 'vrange', label: '세로 범위', icon: Columns2 },
  { value: 'hline', label: '가로선', icon: MoveHorizontal },
  { value: 'hrange', label: '가로 범위', icon: Rows2 },
  { value: 'point', label: '점', icon: Circle },
  { value: 'rect', label: '사각형', icon: Square },
  { value: 'arrow', label: '화살표', icon: ArrowUpRight },
  { value: 'text', label: '텍스트', icon: Type },
]

/** Returns true when the tool requires a drag (mousedown→mousemove→mouseup)
 *  to produce the second endpoint. Nothing uses drag anymore — every
 *  two-endpoint shape uses two-click so precision works on touch and
 *  the user can take their time between endpoints. Kept exported for
 *  any third-party host that needs to feature-detect. */
export function isDragTool() {
  return false
}

/** Returns true when the tool commits on a single click — the first
 *  pointer-down both creates the annotation and (usually) opens an
 *  inline label editor. */
export function isClickTool(tool) {
  return tool === 'vline' || tool === 'hline' || tool === 'point' || tool === 'text'
}

/** Returns true when the tool needs two SEPARATE clicks (no drag) to
 *  define the shape — first click sets one endpoint, second click
 *  commits. Used by vrange / hrange / rect / arrow. */
export function isTwoClickTool(tool) {
  return (
    tool === 'vrange' || tool === 'hrange' || tool === 'rect' || tool === 'arrow'
  )
}

// Silence unused-import warning when the file is bundled without the
// remaining icon (some bundlers were treeshaking less aggressively
// before — keeping the reference is cheap and safer).
void Minus
