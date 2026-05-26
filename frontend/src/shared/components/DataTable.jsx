import * as React from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/shared/lib/utils'

/**
 * Lightweight data table with client-side search, sort, and pagination.
 *
 * columns: [{ key, header, render?, sortable?, accessor? }]
 * data: array of row objects
 */
export function DataTable({
  columns,
  data,
  // Initial page size; if `pageSizeStorageKey` is set and localStorage
  // already has a saved choice for that key, the saved value wins.
  pageSize = 10,
  // Available choices for the page-size dropdown. The string 'all'
  // means "no pagination — show every row on one page".
  pageSizeOptions = [10, 20, 50, 100, 'all'],
  // Per-list persistence key. When provided, the user's page-size
  // selection persists across reloads as
  //   localStorage[`datatable.pageSize.<key>`]
  // Different lists in the app can store their own preferred page size.
  pageSizeStorageKey,
  searchableKeys,
  searchPlaceholder = '검색...',
  onRowClick,
  emptyState,
  className,
  // Optional inline slot rendered between the search input and the count
  // pill so per-page filters can share the toolbar row instead of stacking
  // on top of it.
  toolbarExtras,
  // When true, the table uses `table-layout: fixed` so column widths are
  // driven entirely by the column definitions (`headerClassName: 'w-…'`)
  // rather than by the content of the current page. Without this, each
  // page's content length determines column widths, so flipping pages
  // makes the layout shift around — bad UX on long lists. Title-style
  // columns (the one without an explicit width) absorb the remainder.
  fixedLayout = false,
  // Force the underlying <table> to be at least this wide regardless
  // of container size. Combined with the parent's overflow-x-auto, this
  // lets pages enforce a per-column floor that *actually* expands the
  // table (table-layout: fixed + min-width on cells doesn't grow the
  // table by itself — the table just clips/scales columns to fit
  // container width). Pass a Tailwind class like "min-w-[1200px]".
  minTableWidthClass,
  // Initial sort applied on mount. The user can still click headers
  // to override. Without this, rows render in whatever order `data`
  // arrives — usually backend's `ORDER BY updated_at DESC` for our
  // list endpoints, which doesn't match user expectations on a board
  // where IDs are the visible primary key.
  defaultSort,
  // Opt-in row selection. When `selectable` is true a leading checkbox
  // column is rendered. Selection is controlled — pass a Set of ids
  // via `selectedIds` and react to changes via `onSelectionChange`.
  // `getRowId` defaults to `r => r.id` which matches every list in the
  // app today; pass a custom one if your rows key on something else.
  selectable = false,
  selectedIds,
  onSelectionChange,
  getRowId = (r) => r.id,
  // Per-row prop spread — escape hatch for callers that need to attach
  // drag handlers, custom data-* attributes, etc. without us inventing
  // a dedicated prop for every use case. Receives (row, index); returns
  // props merged onto the <TableRow>. Anything we already set
  // (key/onClick/className/data-selected) is preserved — these spread
  // BEFORE those so caller props can't accidentally clobber selection
  // styling or click handling.
  rowProps,
}) {
  const [query, setQuery] = React.useState('')
  const [sort, setSort] = React.useState(
    defaultSort ?? { key: null, dir: 'asc' },
  )
  const [page, setPage] = React.useState(1)
  const [pageSizeState, setPageSizeState] = React.useState(() => {
    // Lazy initializer — read the persisted value once. Validate against
    // pageSizeOptions so an old value that's no longer offered doesn't
    // permanently break the table.
    if (pageSizeStorageKey && typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(
          `datatable.pageSize.${pageSizeStorageKey}`,
        )
        if (raw != null) {
          const parsed = raw === 'all' ? 'all' : Number(raw)
          if (pageSizeOptions.includes(parsed)) return parsed
        }
      } catch {
        // localStorage can throw in private modes / disabled storage —
        // fall through to the default and don't bother the user.
      }
    }
    return pageSize
  })

  // Persist any subsequent change. The first-render write is harmless
  // (same value the lazy init produced) and keeps the code symmetric.
  React.useEffect(() => {
    if (!pageSizeStorageKey || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        `datatable.pageSize.${pageSizeStorageKey}`,
        String(pageSizeState),
      )
    } catch {
      /* ignore */
    }
  }, [pageSizeState, pageSizeStorageKey])

  // Internal numeric value used for slicing — 'all' means "one giant
  // page with everything." Infinity makes the pagination math collapse
  // naturally (totalPages = 1, slice(0, Infinity) = everything).
  const effectivePageSize = pageSizeState === 'all' ? Infinity : pageSizeState

  const filtered = React.useMemo(() => {
    if (!query.trim()) return data
    const q = query.toLowerCase()
    const keys = searchableKeys ?? columns.map((c) => c.key)
    return data.filter((row) =>
      keys.some((k) => {
        const v = row[k]
        return v != null && String(v).toLowerCase().includes(q)
      })
    )
  }, [data, query, searchableKeys, columns])

  const sorted = React.useMemo(() => {
    if (!sort.key) return filtered
    const col = columns.find((c) => c.key === sort.key)
    const accessor = col?.accessor ?? ((r) => r[sort.key])
    return [...filtered].sort((a, b) => {
      const va = accessor(a)
      const vb = accessor(b)
      if (va == null) return 1
      if (vb == null) return -1
      if (va < vb) return sort.dir === 'asc' ? -1 : 1
      if (va > vb) return sort.dir === 'asc' ? 1 : -1
      return 0
    })
  }, [filtered, sort, columns])

  const totalPages = Math.max(1, Math.ceil(sorted.length / effectivePageSize))
  const safePage = Math.min(page, totalPages)
  const pageRows = sorted.slice(
    (safePage - 1) * effectivePageSize,
    safePage * effectivePageSize,
  )

  function toggleSort(key) {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return { key: null, dir: 'asc' }
    })
  }

  // Selection helpers — the header checkbox toggles every row that
  // currently matches the filter (across pages, not just the current
  // page) so "select all" lines up with the count pill above. Toggling
  // off when partial selection clears just the visible-filter slice;
  // anything selected outside the filter (e.g. from a previous query)
  // is left alone so the user doesn't silently lose work.
  const selectionEnabled = selectable && typeof onSelectionChange === 'function'
  const visibleIds = React.useMemo(
    () => (selectionEnabled ? sorted.map((r) => getRowId(r)) : []),
    [selectionEnabled, sorted, getRowId],
  )
  const selectedInView = React.useMemo(() => {
    if (!selectionEnabled || !selectedIds) return 0
    let n = 0
    for (const id of visibleIds) if (selectedIds.has(id)) n++
    return n
  }, [selectionEnabled, selectedIds, visibleIds])
  const allChecked =
    selectionEnabled && visibleIds.length > 0 && selectedInView === visibleIds.length
  const someChecked = selectionEnabled && selectedInView > 0 && !allChecked

  function toggleAllVisible() {
    if (!selectionEnabled) return
    const next = new Set(selectedIds ?? [])
    if (allChecked) {
      for (const id of visibleIds) next.delete(id)
    } else {
      for (const id of visibleIds) next.add(id)
    }
    onSelectionChange(next)
    // Header toggle is a bulk op — there's no meaningful "last
    // single-toggled row" after it, so clear the anchor.
    lastToggledIdRef.current = null
  }

  function toggleOne(id) {
    if (!selectionEnabled) return
    const next = new Set(selectedIds ?? [])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }

  // Anchor for shift+click range selection — the id of the last row
  // toggled by a plain (non-shift) click. Stays put across consecutive
  // shift+clicks so the user can grow/shrink the range from a single
  // start, matching Finder / Notion behavior.
  const lastToggledIdRef = React.useRef(null)
  // Reset on any change that re-orders the visible set; a stale anchor
  // could let shift+click span rows the user didn't see as adjacent.
  React.useEffect(() => {
    lastToggledIdRef.current = null
  }, [sort.key, sort.dir, query])

  function handleRowCheckboxClick(event, rowId) {
    if (!selectionEnabled) return
    const anchor = lastToggledIdRef.current
    if (event.shiftKey && anchor != null && anchor !== rowId) {
      const startIdx = visibleIds.indexOf(anchor)
      const endIdx = visibleIds.indexOf(rowId)
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] =
          startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        // Mirror the clicked row's new state across the range — if the
        // click would have turned the row on, the range turns on; off,
        // the range turns off.
        const targetState = selectedIds?.has(rowId) !== true
        const next = new Set(selectedIds ?? [])
        for (let i = lo; i <= hi; i++) {
          const id = visibleIds[i]
          if (targetState) next.add(id)
          else next.delete(id)
        }
        onSelectionChange(next)
        // Keep the anchor — consecutive shift+clicks all extend from
        // the same start.
        return
      }
    }
    // Plain click (or shift+click without a resolvable anchor) —
    // toggle just this row and reseat the anchor.
    toggleOne(rowId)
    lastToggledIdRef.current = rowId
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
            placeholder={searchPlaceholder}
            className="pl-8"
          />
        </div>
        {toolbarExtras}
        <span className="ml-auto text-xs text-muted-foreground">{sorted.length}건</span>
      </div>

      {/* overflow-x-auto so when the sum of column widths exceeds the
          container (e.g. sidebar open + narrow window), the table
          scrolls horizontally on its own instead of pushing the whole
          page sideways. The table itself gets an explicit min-width
          via `minTableWidthClass` so columns honor their floors even
          under `table-layout: fixed`. */}
      <div className="rounded-md border overflow-x-auto">
        <Table
          className={cn(
            fixedLayout ? 'table-fixed' : undefined,
            minTableWidthClass,
          )}
        >
          <TableHeader>
            <TableRow>
              {selectionEnabled && (
                <TableHead className="w-[40px]">
                  <input
                    type="checkbox"
                    aria-label="모두 선택"
                    checked={allChecked}
                    ref={(el) => {
                      // Native indeterminate state lives only on the DOM
                      // node — there's no React prop for it. Drive it
                      // here so the header reflects partial selection.
                      if (el) el.indeterminate = someChecked
                    }}
                    onChange={toggleAllVisible}
                    className="h-4 w-4 cursor-pointer"
                  />
                </TableHead>
              )}
              {columns.map((col) => (
                <TableHead key={col.key} className={col.headerClassName}>
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {col.header}
                      {sort.key === col.key ? (
                        sort.dir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (selectionEnabled ? 1 : 0)}
                  className="py-12 text-center"
                >
                  {emptyState ?? (
                    <span className="text-sm text-muted-foreground">데이터가 없습니다.</span>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row, idx) => {
                const rowId = selectionEnabled ? getRowId(row) : undefined
                const isSelected =
                  selectionEnabled && selectedIds?.has(rowId) === true
                const extraRowProps = rowProps?.(row, idx) ?? null
                return (
                  <TableRow
                    {...(extraRowProps || {})}
                    key={row.id ?? idx}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      onRowClick && 'cursor-pointer',
                      isSelected && 'bg-primary/5',
                      extraRowProps?.className,
                    )}
                    data-selected={isSelected || undefined}
                  >
                    {selectionEnabled && (
                      <TableCell
                        className="w-[40px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label="행 선택"
                          checked={isSelected}
                          onClick={(e) => handleRowCheckboxClick(e, rowId)}
                          // Selection is fully driven by onClick (so we
                          // can branch on shiftKey for range mode). The
                          // noop onChange just silences React's
                          // controlled-input warning.
                          onChange={() => {}}
                          className="h-4 w-4 cursor-pointer"
                        />
                      </TableCell>
                    )}
                    {columns.map((col) => (
                      <TableCell key={col.key} className={col.cellClassName}>
                        {col.render ? col.render(row) : row[col.key]}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground flex-wrap">
        <label className="inline-flex items-center gap-1.5">
          <span>페이지 크기:</span>
          <select
            value={pageSizeState}
            onChange={(e) => {
              const raw = e.target.value
              const next = raw === 'all' ? 'all' : Number(raw)
              setPageSizeState(next)
              // Reset to first page on size change — page index from
              // the previous size usually doesn't map anywhere useful.
              setPage(1)
            }}
            className="h-7 rounded border border-input bg-background px-1.5 text-xs"
          >
            {pageSizeOptions.map((opt) => (
              <option key={String(opt)} value={String(opt)}>
                {opt === 'all' ? '전체' : opt}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <span>
            {safePage} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            이전
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            다음
          </Button>
        </div>
      </div>
    </div>
  )
}
