import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from '@/modules/reports/api'
import { listComposites } from '@/shared/api/composites'
import { KIND_LABEL, KIND_VARIANT } from './constants'

/** Inclusive YYYY-MM-DD range check. `value` may be null (theme composites
 *  have no period_date) — when a date range is active, those are dropped
 *  since they have no date to compare. */
function inDateRange(value, from, to) {
  if (!from && !to) return true
  if (!value) return false
  if (from && value < from) return false
  if (to && value > to) return false
  return true
}

/** Item picker for the composite detail page. Two tabs (보고서 / 종합) —
 *  each lists candidates from the API and lets the user multi-select via
 *  checkboxes. Already-selected items are pre-checked and dimmed so users
 *  can see what's already in the composite without leaving the dialog. */
export function ItemPickerDialog({
  open,
  onOpenChange,
  excludeCompositeId,
  existingItems,
  onPick,
}) {
  const [tab, setTab] = useState('reports')
  // Selected refs keyed by either "r:<reportId>" or "c:<compositeId>".
  const [selected, setSelected] = useState(new Set())

  // Reset selection whenever the dialog re-opens.
  useEffect(() => {
    if (open) setSelected(new Set())
  }, [open])

  const existingKeys = useMemo(() => {
    const s = new Set()
    for (const it of existingItems ?? []) {
      if (it.ref_report_id) s.add(`r:${it.ref_report_id}`)
      else if (it.ref_composite_id) s.add(`c:${it.ref_composite_id}`)
    }
    return s
  }, [existingItems])

  function toggle(key) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function confirm() {
    const items = []
    for (const key of selected) {
      if (key.startsWith('r:')) {
        items.push({ ref_report_id: Number(key.slice(2)), note: '' })
      } else if (key.startsWith('c:')) {
        items.push({ ref_composite_id: Number(key.slice(2)), note: '' })
      }
    }
    onPick?.(items)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>안건 추가</DialogTitle>
          <DialogDescription>
            보고서 또는 다른 종합보고를 골라 한 번에 추가합니다.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="reports">보고서</TabsTrigger>
            <TabsTrigger value="composites">종합보고</TabsTrigger>
          </TabsList>
          <TabsContent value="reports" className="mt-3">
            <ReportPickerList
              open={open && tab === 'reports'}
              selected={selected}
              existingKeys={existingKeys}
              onToggle={toggle}
            />
          </TabsContent>
          <TabsContent value="composites" className="mt-3">
            <CompositePickerList
              open={open && tab === 'composites'}
              excludeId={excludeCompositeId}
              selected={selected}
              existingKeys={existingKeys}
              onToggle={toggle}
            />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={confirm} disabled={selected.size === 0}>
            {selected.size > 0 ? `${selected.size}건 추가` : '추가'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReportPickerList({ open, selected, existingKeys, onToggle }) {
  const { all: workspaces } = useWorkspace()
  const { data, loading, error } = useAsync(
    () => (open ? listReports() : Promise.resolve([])),
    [open],
  )
  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])
  const [query, setQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const filtered = (data ?? [])
    .filter((r) => inDateRange(r.report_date, dateFrom, dateTo))
    .filter((r) => {
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (
        r.title.toLowerCase().includes(q) ||
        (r.owner_name ?? '').toLowerCase().includes(q) ||
        workspaceName(r.workspace_slug).toLowerCase().includes(q)
      )
    })
  if (loading) return <Skeleton className="h-48" />
  if (error) return <div className="text-sm text-destructive">{error.message}</div>
  return (
    <PickerBody
      items={filtered}
      query={query}
      setQuery={setQuery}
      dateFrom={dateFrom}
      setDateFrom={setDateFrom}
      dateTo={dateTo}
      setDateTo={setDateTo}
      dateLabel="보고 기준일"
      keyOf={(r) => `r:${r.id}`}
      isExisting={(r) => existingKeys.has(`r:${r.id}`)}
      isSelected={(r) => selected.has(`r:${r.id}`)}
      onToggle={onToggle}
      placeholder="제목·작성자·부서 검색"
      renderMeta={(r) => (
        <div className="text-[11px] text-muted-foreground truncate">
          {workspaceName(r.workspace_slug)}
          {r.report_date && <> · 기준 {r.report_date}</>}
          {r.owner_name && <> · {r.owner_name}</>}
        </div>
      )}
    />
  )
}

function CompositePickerList({ open, excludeId, selected, existingKeys, onToggle }) {
  const { all: workspaces } = useWorkspace()
  const { data, loading, error } = useAsync(
    () => (open ? listComposites() : Promise.resolve([])),
    [open],
  )
  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])
  const [query, setQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Drop the composite itself so the picker can't self-reference.
  // Date filter targets period_date — theme composites (no period_date)
  // fall out of the result when a date range is active, by design.
  const filtered = (data ?? [])
    .filter((c) => c.id !== excludeId)
    .filter((c) => inDateRange(c.period_date, dateFrom, dateTo))
    .filter((c) => {
      if (!query.trim()) return true
      const q = query.toLowerCase()
      return (
        c.title.toLowerCase().includes(q) ||
        (c.owner_name ?? '').toLowerCase().includes(q) ||
        workspaceName(c.workspace_slug).toLowerCase().includes(q)
      )
    })
  if (loading) return <Skeleton className="h-48" />
  if (error) return <div className="text-sm text-destructive">{error.message}</div>
  return (
    <PickerBody
      items={filtered}
      query={query}
      setQuery={setQuery}
      dateFrom={dateFrom}
      setDateFrom={setDateFrom}
      dateTo={dateTo}
      setDateTo={setDateTo}
      dateLabel="기준일"
      keyOf={(c) => `c:${c.id}`}
      isExisting={(c) => existingKeys.has(`c:${c.id}`)}
      isSelected={(c) => selected.has(`c:${c.id}`)}
      onToggle={onToggle}
      placeholder="제목·작성자·부서 검색"
      renderMeta={(c) => (
        <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1.5">
          <Badge variant={KIND_VARIANT[c.kind]} className="text-[9px] h-3.5 px-1">
            {KIND_LABEL[c.kind] ?? c.kind}
          </Badge>
          <span>{workspaceName(c.workspace_slug)}</span>
          {c.period_date && <span>· 기준 {c.period_date}</span>}
          {c.owner_name && <span>· {c.owner_name}</span>}
        </div>
      )}
    />
  )
}

function PickerBody({
  items,
  query,
  setQuery,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  dateLabel,
  keyOf,
  isExisting,
  isSelected,
  onToggle,
  placeholder,
  renderMeta,
}) {
  const dateFilterActive = Boolean(dateFrom || dateTo)
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="pl-8"
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-muted-foreground shrink-0">{dateLabel ?? '날짜'}:</span>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-8 w-[150px] text-xs font-mono"
          aria-label="시작일"
        />
        <span className="text-muted-foreground">~</span>
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-8 w-[150px] text-xs font-mono"
          aria-label="종료일"
        />
        {dateFilterActive && (
          <button
            type="button"
            onClick={() => { setDateFrom(''); setDateTo('') }}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            지우기
          </button>
        )}
      </div>
      <div className="border rounded-md max-h-[360px] overflow-y-auto divide-y">
        {items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            결과가 없습니다.
          </div>
        ) : (
          items.map((it) => {
            const k = keyOf(it)
            const existing = isExisting(it)
            const checked = existing || isSelected(it)
            return (
              <label
                key={k}
                className={
                  'flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/40 ' +
                  (existing ? 'opacity-50' : '')
                }
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0"
                  checked={checked}
                  disabled={existing}
                  onChange={() => onToggle(k)}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{it.title}</div>
                  {renderMeta(it)}
                </div>
                {existing && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    이미 포함됨
                  </span>
                )}
              </label>
            )
          })
        )}
      </div>
    </div>
  )
}
