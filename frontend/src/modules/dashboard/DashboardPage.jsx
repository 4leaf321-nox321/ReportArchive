import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from '@/modules/reports/api'
import { listTemplates } from '@/shared/api/templates'
import { cn } from '@/shared/lib/utils'

/**
 * Dashboard for the currently-selected workspace and its descendants.
 *
 * Two period modes:
 *   - Point  (kind='week'|'month') — inspect one specific ISO week or
 *     calendar month, navigable with ←/→ arrows. anchor is a Date inside
 *     the selected unit.
 *   - Range  (kind='last-N-…'|'all') — sliding window ending at now.
 *
 * The trend chart only shows when the active range spans multiple buckets;
 * the workspace×template stacked-bar panel is the main comparison view
 * for any single-period (week/month) inspection.
 */
const PERIOD_OPTIONS = [
  { value: 'week',          label: '특정 주',     mode: 'point' },
  { value: 'month',         label: '특정 월',     mode: 'point' },
  { value: 'last-4-weeks',  label: '최근 4주',    mode: 'range', defaultUnit: 'week' },
  { value: 'last-12-weeks', label: '최근 12주',   mode: 'range', defaultUnit: 'week' },
  { value: 'last-6-months', label: '최근 6개월',  mode: 'range', defaultUnit: 'month' },
  { value: 'last-12-months',label: '최근 12개월', mode: 'range', defaultUnit: 'month' },
  { value: 'all',           label: '전체 기간',   mode: 'range', defaultUnit: 'month' },
]

// Fixed palette for the stacked bar — cycled by template index so colors
// stay stable across renders. Tailwind-friendly hexes that work on both
// light and dark backgrounds.
const PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#14b8a6', '#ec4899', '#64748b',
  '#0ea5e9', '#84cc16', '#f97316', '#a855f7',
]

export default function DashboardPage() {
  const { workspace, slug, all: workspaces, getDescendantsInclusive } = useWorkspace()
  const [periodKind, setPeriodKind] = useState('month')
  const [anchor, setAnchor] = useState(() => new Date())  // for week/month modes
  const [unit, setUnit] = useState('week')                 // for the trend chart bucket size

  const periodMeta = PERIOD_OPTIONS.find((o) => o.value === periodKind) ?? PERIOD_OPTIONS[1]

  const { data: reports, loading, error, reload } = useAsync(
    () => (slug ? listReports() : Promise.resolve([])),
    [slug],
  )
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug],
  )

  const templateName = useMemo(() => makeTemplateNameLookup(templates), [templates])
  const workspaceName = useMemo(() => makeWorkspaceNameLookup(workspaces), [workspaces])

  const range = useMemo(
    () => periodRange(periodKind, anchor),
    [periodKind, anchor],
  )

  const inRange = useMemo(() => {
    const all = reports ?? []
    if (!range.from) return all
    return all.filter((r) => {
      const t = parseUtcIso(r.created_at)
      return t && t >= range.from && t <= range.to
    })
  }, [reports, range])

  const scopedSlugs = useMemo(() => {
    if (!slug) return []
    return getDescendantsInclusive(slug).filter((s) => {
      const w = workspaces?.find((x) => x.slug === s)
      return w && !w.virtual
    })
  }, [slug, workspaces, getDescendantsInclusive])

  // Workspace × template cross-tab — counts[wsSlug][templateId] = N.
  // A multi-page report contributes once per distinct template it uses.
  const crosstab = useMemo(() => {
    const counts = new Map()
    const templateUsage = new Map()  // for legend ordering by usage
    for (const wsSlug of scopedSlugs) counts.set(wsSlug, new Map())
    for (const r of inRange) {
      if (!counts.has(r.workspace_slug)) continue
      const tplIds = uniqueTemplateIds(r)
      const inner = counts.get(r.workspace_slug)
      for (const id of tplIds) {
        inner.set(id, (inner.get(id) ?? 0) + 1)
        templateUsage.set(id, (templateUsage.get(id) ?? 0) + 1)
      }
    }
    const orderedTemplates = [...templateUsage.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
    const colorOf = new Map(orderedTemplates.map((id, i) => [id, PALETTE[i % PALETTE.length]]))
    return { counts, orderedTemplates, colorOf }
  }, [inRange, scopedSlugs])

  const trend = useMemo(
    () => bucketizeReports(inRange, unit, range, reports ?? []),
    [inRange, unit, range, reports],
  )

  // KPI strip values
  const totalReports = inRange.length
  const distinctAuthors = useMemo(() => {
    const ids = new Set()
    for (const r of inRange) if (r.owner_user_id != null) ids.add(r.owner_user_id)
    return ids.size
  }, [inRange])
  const distinctTemplates = crosstab.orderedTemplates.length

  // ── loading / error ───────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-56" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-6">
        <ErrorState description={error.message} onRetry={reload} />
      </div>
    )
  }

  function changePeriod(next) {
    setPeriodKind(next)
    const meta = PERIOD_OPTIONS.find((o) => o.value === next)
    if (meta?.mode === 'point') {
      // Reset to "current week/month" when entering point mode and pick
      // the only useful sub-resolution for a single month (weekly bars).
      setAnchor(new Date())
      setUnit('week')
    } else if (meta?.defaultUnit) {
      setUnit(meta.defaultUnit)
    }
  }
  function stepAnchor(direction) {
    if (periodMeta.mode !== 'point') return
    const next = new Date(anchor)
    if (periodKind === 'week') next.setDate(next.getDate() + direction * 7)
    else next.setMonth(next.getMonth() + direction)
    setAnchor(next)
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="대시보드"
        description={
          workspace
            ? `${workspace.name}${workspace.virtual ? ' (횡단)' : ''} 및 하위 부서`
            : ''
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <PeriodSelect value={periodKind} onChange={changePeriod} />
            {periodMeta.mode === 'point' && (
              <PointNavigator
                label={pointLabel(periodKind, anchor)}
                onPrev={() => stepAnchor(-1)}
                onNext={() => stepAnchor(+1)}
              />
            )}
            {periodKind !== 'week' && <UnitToggle value={unit} onChange={setUnit} />}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KPI label="총 보고서" value={totalReports} />
        <KPI label="작성자" value={distinctAuthors} />
        <KPI label="사용된 템플릿" value={distinctTemplates} />
      </div>

      {trend.length > 1 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              추세 · {unit === 'week' ? '주별' : '월별'}
            </CardTitle>
            <CardDescription>
              {range.from
                ? `${formatDate(range.from)} – ${formatDate(range.to)} 동안 생성된 보고서`
                : '전체 기간 동안 생성된 보고서'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart buckets={trend} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">부서 × 템플릿</CardTitle>
          <CardDescription>
            각 부서의 보고서를 사용된 템플릿별로 누적 비교
          </CardDescription>
        </CardHeader>
        <CardContent>
          {totalReports === 0 ? (
            <p className="text-sm text-muted-foreground py-3">기간 내 보고서 없음</p>
          ) : (
            <>
              <Legend
                templates={crosstab.orderedTemplates}
                colorOf={crosstab.colorOf}
                templateName={templateName}
              />
              <StackedBarChart
                workspaceSlugs={scopedSlugs}
                workspaceName={workspaceName}
                crosstab={crosstab}
                templateName={templateName}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ───────────────────────── header controls ──────────────────────────────
function PeriodSelect({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
      aria-label="기간"
    >
      {PERIOD_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function PointNavigator({ label, onPrev, onNext }) {
  return (
    <div className="inline-flex items-center gap-1 h-9 rounded-md border bg-background px-1">
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onPrev} aria-label="이전">
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-sm font-medium min-w-[7rem] text-center tabular-nums">
        {label}
      </span>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNext} aria-label="다음">
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

function UnitToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded-md border bg-background overflow-hidden h-9">
      {['week', 'month'].map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          className={cn(
            'px-3 text-sm transition-colors',
            value === u ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {u === 'week' ? '주별' : '월별'}
        </button>
      ))}
    </div>
  )
}

// ───────────────────────── KPI ──────────────────────────────────────────
function KPI({ label, value }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-3xl font-semibold mt-1">{value}</div>
      </CardContent>
    </Card>
  )
}

// ───────────────────────── Trend (vertical bars) ────────────────────────
function TrendChart({ buckets }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const BAR_BUDGET_PX = 120
  return (
    <div className="flex items-end gap-1.5 h-40">
      {buckets.map((b) => {
        const heightPx = b.count === 0 ? 2 : Math.max(4, (b.count / max) * BAR_BUDGET_PX)
        return (
          <div
            key={b.key}
            className="flex flex-col items-center flex-1 min-w-0"
            title={`${b.key} · ${b.count}건`}
          >
            {b.count > 0 && (
              <div className="text-[10px] text-foreground/70 leading-none mb-0.5">{b.count}</div>
            )}
            <div
              className={cn('w-full rounded-t', b.count > 0 ? 'bg-primary' : 'bg-muted')}
              style={{ height: `${heightPx}px` }}
            />
            <div className="mt-1 text-[10px] text-muted-foreground truncate w-full text-center">
              {b.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────────── Stacked bar (workspace × template) ───────────
function Legend({ templates, colorOf, templateName }) {
  if (templates.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-xs">
      {templates.map((id) => (
        <span key={id} className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm shrink-0"
            style={{ backgroundColor: colorOf.get(id) }}
          />
          <span className="text-foreground/80">{templateName(id)}</span>
        </span>
      ))}
    </div>
  )
}

function StackedBarChart({ workspaceSlugs, workspaceName, crosstab, templateName }) {
  // Per-workspace totals (used for sorting + scaling). Sort by total desc
  // so the most-active sub-orgs surface at the top; trailing zeros stay
  // visible so missing departments aren't silently dropped.
  const rows = workspaceSlugs.map((ws) => {
    const inner = crosstab.counts.get(ws) ?? new Map()
    const total = [...inner.values()].reduce((a, b) => a + b, 0)
    return { ws, inner, total }
  })
  rows.sort((a, b) => b.total - a.total || a.ws.localeCompare(b.ws))

  const globalMax = Math.max(1, ...rows.map((r) => r.total))

  return (
    <div className="space-y-2">
      {rows.map(({ ws, inner, total }) => (
        <div key={ws} className="grid grid-cols-[10rem_1fr_2.5rem] gap-3 items-center">
          <span
            className="text-xs truncate"
            title={`${workspaceName(ws)} · ${ws}`}
          >
            {workspaceName(ws)}
          </span>
          <div className="h-6 rounded bg-muted/40 overflow-hidden flex">
            {/* Each segment is a template's slice within this workspace.
                Widths are % of globalMax so workspace bars stay comparable
                across the chart instead of each re-normalizing to itself. */}
            {crosstab.orderedTemplates.map((tplId) => {
              const n = inner.get(tplId) ?? 0
              if (n === 0) return null
              const widthPct = (n / globalMax) * 100
              return (
                <div
                  key={tplId}
                  style={{ width: `${widthPct}%`, backgroundColor: crosstab.colorOf.get(tplId) }}
                  title={`${templateName(tplId)} · ${n}건`}
                />
              )
            })}
          </div>
          <span className="text-xs tabular-nums text-right text-muted-foreground">{total}</span>
        </div>
      ))}
    </div>
  )
}

// ───────────────────────── helpers ──────────────────────────────────────
function makeTemplateNameLookup(templates) {
  const map = new Map((templates ?? []).map((t) => [t.template_id, t.name]))
  return (id) => {
    if (!id) return ''
    const name = map.get(id)
    if (name) return name
    if (id.length > 16) return `${id.slice(0, 8)}…`
    return id
  }
}

function makeWorkspaceNameLookup(workspaces) {
  const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
  return (slug) => map.get(slug) ?? slug
}

function uniqueTemplateIds(report) {
  const out = new Set()
  const pages = Array.isArray(report.pages) ? report.pages : []
  if (pages.length === 0) {
    if (report.template_id) out.add(report.template_id)
    return out
  }
  for (const p of pages) {
    if (p?.template_id) out.add(p.template_id)
  }
  return out
}

/** Compute [from, to] for the active period. For point modes the range
 *  is the boundaries of the selected week / month; for range modes it's
 *  N units ending at "now". */
function periodRange(kind, anchor) {
  const now = new Date()
  const to = endOfDay(now)
  switch (kind) {
    case 'week': {
      const monday = startOfIsoWeek(anchor)
      const sunday = endOfDay(addDays(monday, 6))
      return { from: monday, to: sunday }
    }
    case 'month': {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 0, 0, 0, 0)
      const last = endOfDay(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
      return { from: first, to: last }
    }
    case 'last-4-weeks':   return { from: startOfDay(daysAgo(now, 28)), to }
    case 'last-12-weeks':  return { from: startOfDay(daysAgo(now, 84)), to }
    case 'last-6-months':  return { from: startOfDay(monthsAgo(now, 6)), to }
    case 'last-12-months': return { from: startOfDay(monthsAgo(now, 12)), to }
    case 'all':
    default:               return { from: null, to }
  }
}

function pointLabel(kind, anchor) {
  if (kind === 'week') {
    const monday = startOfIsoWeek(anchor)
    return `${isoWeekKey(monday)} (${formatShortDate(monday)} – ${formatShortDate(addDays(monday, 6))})`
  }
  if (kind === 'month') {
    return `${anchor.getFullYear()}년 ${anchor.getMonth() + 1}월`
  }
  return ''
}

function bucketizeReports(filtered, unit, range, allReports) {
  const from = range.from ?? earliestCreatedAt(allReports)
  if (!from) return []
  const to = range.to ?? new Date()

  const counts = new Map()
  const buckets = enumerateBuckets(from, to, unit)
  for (const b of buckets) counts.set(b.key, { ...b, count: 0 })
  for (const r of filtered) {
    const d = parseUtcIso(r.created_at)
    if (!d) continue
    const key = unit === 'week' ? isoWeekKey(d) : monthKey(d)
    const cell = counts.get(key)
    if (cell) cell.count += 1
  }
  return [...counts.values()]
}

function earliestCreatedAt(reports) {
  let min = null
  for (const r of reports) {
    const d = parseUtcIso(r.created_at)
    if (!d) continue
    if (!min || d < min) min = d
  }
  return min
}

function enumerateBuckets(from, to, unit) {
  const out = []
  if (unit === 'week') {
    const cur = startOfIsoWeek(from)
    while (cur <= to) {
      out.push({ key: isoWeekKey(cur), label: `W${isoWeekKey(cur).split('-W')[1]}` })
      cur.setDate(cur.getDate() + 7)
    }
  } else {
    const cur = new Date(from.getFullYear(), from.getMonth(), 1)
    while (cur <= to) {
      out.push({ key: monthKey(cur), label: `${cur.getMonth() + 1}월` })
      cur.setMonth(cur.getMonth() + 1)
    }
  }
  return out
}

// ── date primitives ─────────────────────────────────────────────────────
function startOfIsoWeek(d) {
  const out = new Date(d)
  const day = out.getDay() || 7    // make Sunday=7
  out.setDate(out.getDate() - day + 1)
  out.setHours(0, 0, 0, 0)
  return out
}
function addDays(d, n) {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}
function daysAgo(d, n)  { return addDays(d, -n) }
function monthsAgo(d, n) {
  const out = new Date(d)
  out.setMonth(out.getMonth() - n)
  return out
}
function startOfDay(d) {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}
function endOfDay(d) {
  const out = new Date(d)
  out.setHours(23, 59, 59, 999)
  return out
}

/** ISO 8601 week key — "2026-W18". */
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function formatDate(d) {
  if (!d) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function formatShortDate(d) {
  if (!d) return ''
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** Backend emits naive UTC ISO. Force-anchor to UTC so week/month bucketing
 *  doesn't drift by the local TZ offset. */
function parseUtcIso(iso) {
  if (!iso) return null
  const s = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}
