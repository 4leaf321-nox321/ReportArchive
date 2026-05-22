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
  // Initial sort applied on mount. The user can still click headers
  // to override. Without this, rows render in whatever order `data`
  // arrives — usually backend's `ORDER BY updated_at DESC` for our
  // list endpoints, which doesn't match user expectations on a board
  // where IDs are the visible primary key.
  defaultSort,
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

      <div className="rounded-md border">
        <Table className={fixedLayout ? 'table-fixed' : undefined}>
          <TableHeader>
            <TableRow>
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
                <TableCell colSpan={columns.length} className="py-12 text-center">
                  {emptyState ?? (
                    <span className="text-sm text-muted-foreground">데이터가 없습니다.</span>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row, idx) => (
                <TableRow
                  key={row.id ?? idx}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={onRowClick ? 'cursor-pointer' : undefined}
                >
                  {columns.map((col) => (
                    <TableCell key={col.key} className={col.cellClassName}>
                      {col.render ? col.render(row) : row[col.key]}
                    </TableCell>
                  ))}
                </TableRow>
              ))
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
