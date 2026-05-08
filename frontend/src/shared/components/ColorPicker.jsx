import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

/**
 * Color picker — preset swatches + native HTML5 color input for fine control.
 *
 * Stored format is `#rrggbb` (lowercase). The native input emits lowercase
 * already on most browsers; we normalize defensively in onChange.
 *
 *   <ColorPicker value={color} onChange={setColor} />
 */
const PRESETS = [
  // Tailwind-derived palette — covers most workspace coloring needs.
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#f59e0b', // amber-500
  '#eab308', // yellow-500
  '#84cc16', // lime-500
  '#22c55e', // green-500
  '#10b981', // emerald-500
  '#14b8a6', // teal-500
  '#06b6d4', // cyan-500
  '#0ea5e9', // sky-500
  '#3b82f6', // blue-500
  '#6366f1', // indigo-500
  '#8b5cf6', // violet-500
  '#a855f7', // purple-500
  '#d946ef', // fuchsia-500
  '#ec4899', // pink-500
  '#64748b', // slate-500
  '#71717a', // zinc-500
  '#737373', // neutral-500
  '#525252', // neutral-600
]

export function ColorPicker({ value, onChange, id, className }) {
  const normalized = (value || '#64748b').toLowerCase()

  function set(next) {
    onChange((next || '').toLowerCase())
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="grid grid-cols-10 gap-1.5">
        {PRESETS.map((c) => {
          const selected = c === normalized
          return (
            <button
              key={c}
              type="button"
              onClick={() => set(c)}
              className={cn(
                'h-7 w-7 rounded-md border transition-transform',
                selected
                  ? 'ring-2 ring-offset-2 ring-primary scale-110'
                  : 'border-border hover:scale-105'
              )}
              style={{ backgroundColor: c }}
              aria-label={`색상 ${c}`}
              title={c}
            >
              {selected && (
                <Check className="h-3.5 w-3.5 text-white drop-shadow mx-auto" />
              )}
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={normalized}
          onChange={(e) => set(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded border border-input bg-transparent p-0.5"
          aria-label="사용자 정의 색상"
        />
        <span className="font-mono text-xs text-muted-foreground">{normalized}</span>
      </div>
    </div>
  )
}
