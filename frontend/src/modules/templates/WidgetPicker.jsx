import { useState } from 'react'
import { Input } from '@/shared/components/ui/input'
import { cn } from '@/shared/lib/utils'
import { getRenderer } from './widgets'

// Picker categories. Types listed here render under the matching
// header; anything not classified falls through into a 「기타」 bucket so
// newly added widgets remain reachable before someone updates the map.
// Order matters — categories show in the listed sequence.
//
// Keep this in sync with new widget additions: a widget that lands in
// 「기타」 means someone forgot to assign a category here. The bucket is
// a safety net, not a target.
//
// Sizing intent: the columns layout renders as a fixed 4-column grid
// with `grid-flow-row-dense`. The picker height is row1 + row2 = the
// max of each row's tallest category. To keep the popover compact:
//   - cap most categories at ≤ 5 entries (they fit comfortably in one
//     row slot)
//   - any category that genuinely needs more (currently only 좌표 차트
//     with 8) gets `spanRows: 2` so it fills a full column instead of
//     stretching one row to its own length. The first such category in
//     declaration order claims column 1 thanks to dense packing.
//   - within each category, order entries from most common / familiar
//     at top to more specialized at the bottom.
export const WIDGET_PICKER_CATEGORIES = [
  {
    // Coordinate-axis charts — XY space, regardless of dimensionality.
    // Ordered by ubiquity: chart/scatter are the day-one defaults;
    // scatter3d is intentionally last because the 3D viewer dominates
    // the cell and is rarely the right first pick. 8 entries — placed
    // first with spanRows:2 so it claims col 1 across both rows.
    name: '좌표 차트',
    spanRows: 2,
    types: [
      'chart',
      'scatter',
      'radar',
      'box',
      'density',
      'heatmap',
      'contour',
      'scatter3d',
    ],
  },
  { name: '텍스트', types: ['heading', 'rich_text', 'card', 'equation'] },
  { name: '목록 / 표', types: ['bulleted_list', 'key_value', 'table', 'comparison'] },
  {
    // Proportional / part-of-whole. pie/waffle are flat; treemap/packing
    // are the hierarchical extensions of the same idea.
    name: '비율',
    types: ['pie', 'waffle', 'treemap', 'packing'],
  },
  {
    // Flow, hierarchy, and general graph relations. Ordered from
    // lightest to heaviest: flowchart (free-form), tree/mind_map
    // (hierarchy), sankey/network (general graph).
    name: '흐름 / 관계',
    types: ['flowchart', 'tree', 'mind_map', 'sankey', 'network'],
  },
  {
    // Strategic frameworks and progress trackers — neither charts nor
    // free-form diagrams; they're "fill in the grid / mark the
    // milestone" widgets. Grouped so writers reach them via the same
    // mental model.
    name: '매트릭스 / 진행',
    types: ['progress_bar', 'milestone', 'quadrant', 'raci_matrix'],
  },
  {
    name: '미디어 / 첨부',
    types: ['image', 'attachment', 'doc_viewer', 'video', 'html_embed', 'cad_3d'],
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
    spanRows: cat.spanRows,
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
        // Fixed 4-column grid with dense packing. Categories flagged
        // `spanRows: 2` claim a full column (currently 좌표 차트 — 8
        // items would otherwise stretch one row to its own length and
        // waste space on the other side). Dense flow then packs the
        // remaining smaller categories into the leftover cells in
        // declaration order. Picker height ends up at row1 + row2 ≈ the
        // max of each row's tallest small category, far shorter than
        // letting any single 8-item category drive the whole height.
        <div className="grid gap-3 grid-cols-[repeat(4,minmax(140px,1fr))] grid-flow-row-dense">
          {groups.map((group) => (
            <div
              key={group.name}
              className={cn('min-w-0', group.spanRows === 2 && 'row-span-2')}
            >
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
