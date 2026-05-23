import { useState } from 'react'
import { Input } from '@/shared/components/ui/input'
import { cn } from '@/shared/lib/utils'
import { getRenderer } from './widgets'

// Picker categories. Types listed here render under the matching
// header; anything not classified falls through into a 「기타」 bucket so
// newly added widgets remain reachable before someone updates the map.
// Order matters — categories show in the listed sequence.
export const WIDGET_PICKER_CATEGORIES = [
  { name: '텍스트', types: ['heading', 'rich_text', 'equation'] },
  { name: '목록 / 표', types: ['bulleted_list', 'key_value', 'table'] },
  {
    name: '차트',
    types: [
      'chart',
      'scatter',
      'scatter3d',
      'heatmap',
      'contour',
      'radar',
      'pie',
      'box',
      'density',
      'waffle',
    ],
  },
  {
    name: '다이어그램',
    types: [
      'flowchart',
      'milestone',
      'progress_bar',
      'raci_matrix',
      'tree',
      'treemap',
      'packing',
    ],
  },
  {
    name: '미디어 / 첨부',
    types: ['image', 'attachment', 'video', 'html_embed', 'cad_3d'],
  },
]

/** Unified widget picker — search input + category-grouped list.
 *
 *  Used by every widget-add surface in the app (report floating pill,
 *  report block-hover arrows, template editor's left palette) so search
 *  and categorization stay consistent. Each caller wraps this in whatever
 *  container fits (Popover, sidebar section).
 *
 *  Two layouts:
 *    - `columns` (default): each category is a vertical column, columns
 *      sit side by side. Use in wide popovers so all widgets fit in one
 *      glance without scrolling.
 *    - `list`: categories stack vertically, items list inside each.
 *      Use in narrow always-on containers (e.g. sidebar palette).
 */
export function WidgetPicker({
  widgets,
  onSelect,
  layout = 'columns',
  showDescription = false,
  autoFocusSearch = true,
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  // Filter on label / description / type so a widget is reachable by
  // Korean label, English type, or a description keyword.
  const filtered = q
    ? widgets.filter(
        (w) =>
          (w.label ?? '').toLowerCase().includes(q) ||
          (w.description ?? '').toLowerCase().includes(q) ||
          (w.type ?? '').toLowerCase().includes(q),
      )
    : widgets
  const claimedTypes = new Set(
    WIDGET_PICKER_CATEGORIES.flatMap((c) => c.types),
  )
  const filteredByType = new Map(filtered.map((w) => [w.type, w]))
  const groups = WIDGET_PICKER_CATEGORIES.map((cat) => ({
    name: cat.name,
    items: cat.types.map((t) => filteredByType.get(t)).filter(Boolean),
  })).filter((g) => g.items.length > 0)
  const uncategorized = filtered.filter((w) => !claimedTypes.has(w.type))
  if (uncategorized.length > 0) {
    groups.push({ name: '기타', items: uncategorized })
  }

  return (
    <div className="space-y-2">
      <div className="sticky -top-2 bg-popover z-10 pb-2 pt-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="위젯 검색…"
          autoFocus={autoFocusSearch}
          className="h-8 text-xs"
          // Esc clears the query first; only closes the popover on the
          // second press (the default Esc handler takes over once empty).
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
      </div>
      {groups.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground">
          “{query}”에 일치하는 위젯이 없습니다.
        </div>
      ) : layout === 'columns' ? (
        // Categories side by side; items stack within each column. auto-fit
        // lets the grid collapse cleanly when search narrows the result to
        // a few categories. Min-width matches the widest label so columns
        // don't squish; cap with max-width so 1-2 matches don't stretch into
        // huge columns.
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(140px,180px))]">
          {groups.map((group) => (
            <div key={group.name} className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-1 pb-1 border-b mb-1">
                {group.name}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((w) => (
                  <WidgetItem
                    key={w.type}
                    widget={w}
                    showDescription={showDescription}
                    onSelect={onSelect}
                    compact
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // List layout: categories stack vertically; items list 1-per-row
        // inside each. Suits narrow always-on containers (sidebar palette).
        <div className="space-y-2">
          {groups.map((group) => (
            <div key={group.name}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2 pb-1">
                {group.name}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((w) => (
                  <WidgetItem
                    key={w.type}
                    widget={w}
                    showDescription={showDescription}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WidgetItem({ widget, showDescription, onSelect, compact = false }) {
  const meta = getRenderer(widget.type)
  const Icon = meta?.Icon
  return (
    <button
      type="button"
      onClick={() => onSelect(widget)}
      className={cn(
        'flex rounded-md text-left hover:bg-muted transition-colors',
        showDescription
          ? 'items-start gap-2 px-2 py-2'
          : compact
            ? 'items-center gap-1.5 px-1.5 py-1'
            : 'items-center gap-2 px-2 py-1.5',
      )}
    >
      {Icon && (
        <Icon
          className={cn(
            'shrink-0 text-muted-foreground',
            compact ? 'h-3.5 w-3.5' : 'h-4 w-4',
            showDescription && 'mt-0.5',
          )}
        />
      )}
      <div className="min-w-0">
        <div
          className={cn(
            'font-medium truncate',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          {widget.label}
        </div>
        {showDescription && (
          <div className="text-[10px] text-muted-foreground line-clamp-2">
            {widget.description}
          </div>
        )}
      </div>
    </button>
  )
}
