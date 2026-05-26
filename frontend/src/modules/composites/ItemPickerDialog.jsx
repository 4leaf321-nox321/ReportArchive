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
 *  can see what's already in the composite without leaving the dialog.
 *
 *  Scope of the 보고서 tab: `listReports()` uses the current workspace
 *  header. The dialog is opened from `/w/{composite.workspace_slug}/composites/{id}`,
 *  so backend's `list_reports_in_workspace` (org branch) JOINs `ReportMount`
 *  and returns only reports mounted to the composite's workspace tree
 *  (descendants_inclusive). Reports living in another team's tree are
 *  invisible — pulling them in is a Fork concern (Phase 8A), not picker.
 *  Phase 5B verified this filter; the visible improvement was switching
 *  the row meta away from the post-Phase-1 noise of `r.workspace_slug`
 *  (= personal-{userId}) toward mount chips. */
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
            이 부서 게시판(하위 부서 포함)에 게시된 보고서 또는 다른 종합보고를
            골라 한 번에 추가합니다. 다른 부서 보고서는 [참조 복제]를 거친
            뒤에 사용 가능합니다.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="reports">보고서</TabsTrigger>
            <TabsTrigger value="composites_recurring">정기 종합</TabsTrigger>
            <TabsTrigger value="composites_theme">주제 종합</TabsTrigger>
          </TabsList>
          <TabsContent value="reports" className="mt-3">
            <ReportPickerList
              open={open && tab === 'reports'}
              selected={selected}
              existingKeys={existingKeys}
              onToggle={toggle}
            />
          </TabsContent>
          <TabsContent value="composites_recurring" className="mt-3">
            {/* 정기: period_date 기반 날짜 필터 활성. */}
            <CompositePickerList
              open={open && tab === 'composites_recurring'}
              excludeId={excludeCompositeId}
              selected={selected}
              existingKeys={existingKeys}
              onToggle={toggle}
              kindFilter="recurring"
            />
          </TabsContent>
          <TabsContent value="composites_theme" className="mt-3">
            {/* 주제: period_date 가 NULL 이라 날짜 필터 자체를 숨김.
                예전엔 한 탭에 합쳐져서 날짜 필터만 켜면 주제가 통째로
                사라지는 버그가 있었다. */}
            <CompositePickerList
              open={open && tab === 'composites_theme'}
              excludeId={excludeCompositeId}
              selected={selected}
              existingKeys={existingKeys}
              onToggle={toggle}
              kindFilter="theme"
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
  const { data, loading, error } = useAsync(
    () => (open ? listReports() : Promise.resolve([])),
    [open],
  )
  const [query, setQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const filtered = (data ?? [])
    .filter((r) => inDateRange(r.report_date, dateFrom, dateTo))
    .filter((r) => {
      if (!query.trim()) return true
      const q = query.toLowerCase()
      // Post-Phase-1: `r.workspace_slug` is always personal so it's not
      // a useful search axis. Match on title / owner / mount workspace
      // names (the boards the report is actually published to).
      const mountNames = (r.mount_workspaces ?? [])
        .map((m) => m.name)
        .join(' ')
      return (
        r.title.toLowerCase().includes(q) ||
        (r.owner_name ?? '').toLowerCase().includes(q) ||
        mountNames.toLowerCase().includes(q)
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
      placeholder="제목·작성자·게시판 검색"
      renderMeta={(r) => {
        // Show the boards (mount workspaces) the report is published to.
        // Post-Phase-1 `r.workspace_slug` is the author's personal space
        // which carries no useful signal for a composite picker.
        const mounts = r.mount_workspaces ?? []
        return (
          <div className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
            {mounts.length > 0 ? (
              mounts.slice(0, 3).map((m) => (
                <span
                  key={m.slug}
                  className="inline-flex items-center rounded-full bg-primary/10 text-primary px-1.5 py-0 text-[10px] font-medium"
                  title={m.slug}
                >
                  {m.name}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground/60">미게시</span>
            )}
            {mounts.length > 3 && (
              <span className="text-[10px]">+{mounts.length - 3}</span>
            )}
            {r.report_date && <span>· 기준 {r.report_date}</span>}
            {r.owner_name && <span>· {r.owner_name}</span>}
          </div>
        )
      }}
    />
  )
}

function CompositePickerList({
  open,
  excludeId,
  selected,
  existingKeys,
  onToggle,
  kindFilter, // 'recurring' | 'theme' | undefined (= 모두)
}) {
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

  // Theme composites have no period_date — showing the date filter
  // for them invites confusion (any date → empty list). Hide it.
  const showDateFilter = kindFilter !== 'theme'

  // Drop the composite itself so the picker can't self-reference.
  const filtered = (data ?? [])
    .filter((c) => c.id !== excludeId)
    .filter((c) => (kindFilter ? c.kind === kindFilter : true))
    .filter((c) => (showDateFilter ? inDateRange(c.period_date, dateFrom, dateTo) : true))
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
      showDateFilter={showDateFilter}
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
  showDateFilter = true,
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
      {showDateFilter && (
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
      )}
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
