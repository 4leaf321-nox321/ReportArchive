import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
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
 * The reports API already scopes results to (workspace + descendants), so
 * all aggregation here is pure client-side counting over that list. A
 * date-range filter and a week/month bucket toggle drive the trend chart;
 * everything else (per-workspace, per-template counts) reflects the same
 * filtered set so the panels stay consistent.
 */
const PERIOD_OPTIONS = [
  { value: 'this-week', label: '이번 주', defaultUnit: 'week' },
  { value: 'this-month', label: '이번 달', defaultUnit: 'week' },
  { value: 'last-4-weeks', label: '최근 4주', defaultUnit: 'week' },
  { value: 'last-12-weeks', label: '최근 12주', defaultUnit: 'week' },
  { value: 'last-6-months', label: '최근 6개월', defaultUnit: 'month' },
  { value: 'last-12-months', label: '최근 12개월', defaultUnit: 'month' },
  { value: 'all', label: '전체 기간', defaultUnit: 'month' },
]

export default function DashboardPage() {
  const { workspace, slug, all: workspaces, getDescendantsInclusive } = useWorkspace()
  const [period, setPeriod] = useState('last-12-weeks')
  const [unit, setUnit] = useState('week')

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

  const range = useMemo(() => periodRange(period), [period])

  const inRange = useMemo(() => {
    const all = reports ?? []
    if (!range.from) return all
    return all.filter((r) => {
      const t = parseUtcIso(r.created_at)
      return t && t >= range.from && t <= range.to
    })
  }, [reports, range])

  // Restrict the per-workspace breakdown to direct descendants of the
  // currently viewed workspace (incl. itself). The API already scopes to
  // this tree but exposing the lookup explicitly lets us list zero-count
  // sub-departments too — empty cells are signal in a dashboard.
  const scopedSlugs = useMemo(() => {
    if (!slug) return new Set()
    return new Set(getDescendantsInclusive(slug))
  }, [slug, getDescendantsInclusive])

  const byWorkspace = useMemo(() => {
    const counts = new Map()
    for (const ws of scopedSlugs) counts.set(ws, 0)
    for (const r of inRange) {
      if (!scopedSlugs.has(r.workspace_slug)) continue
      counts.set(r.workspace_slug, (counts.get(r.workspace_slug) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [scopedSlugs, inRange])

  // Template column: count distinct templates used per report (so a 5-page
  // report that mixes weekly-dev + monthly-summary counts once for each,
  // matching the list view's behavior).
  const byTemplate = useMemo(() => {
    const counts = new Map()
    for (const r of inRange) {
      const ids = uniqueTemplateIds(r)
      for (const id of ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [inRange])

  const trend = useMemo(
    () => bucketizeReports(inRange, unit, range, reports ?? []),
    [inRange, unit, range, reports],
  )

  // KPI strip values.
  const totalReports = inRange.length
  const distinctAuthors = useMemo(() => {
    const ids = new Set()
    for (const r of inRange) if (r.owner_user_id != null) ids.add(r.owner_user_id)
    return ids.size
  }, [inRange])
  const distinctTemplates = byTemplate.length

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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
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
            <PeriodSelect value={period} onChange={(v) => {
              setPeriod(v)
              // Auto-pick the sensible bucket size for the chosen range so
              // a year-range view doesn't render 52 micro-bars by default.
              const opt = PERIOD_OPTIONS.find((o) => o.value === v)
              if (opt?.defaultUnit) setUnit(opt.defaultUnit)
            }} />
            <UnitToggle value={unit} onChange={setUnit} />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KPI label="총 보고서" value={totalReports} />
        <KPI label="작성자" value={distinctAuthors} />
        <KPI label="사용된 템플릿" value={distinctTemplates} />
      </div>

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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">하위 부서별</CardTitle>
            <CardDescription>현재 부서 트리 내 보고서 수</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {byWorkspace.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3">데이터 없음</p>
            ) : (
              byWorkspace.map(([slug, n]) => (
                <BarRow
                  key={slug}
                  label={workspaceName(slug)}
                  hint={slug}
                  value={n}
                  max={totalReports}
                />
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">템플릿별</CardTitle>
            <CardDescription>어떤 양식이 가장 많이 쓰였나 (보고서 1건이 여러 템플릿을 쓰면 각각 카운트)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {byTemplate.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3">데이터 없음</p>
            ) : (
              byTemplate.map(([id, n]) => (
                <BarRow key={id} label={templateName(id)} hint={id} value={n} max={totalReports} />
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ───────────────────────── UI subcomponents ──────────────────────────────
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

function BarRow({ label, hint, value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate" title={hint ? `${label} · ${hint}` : label}>
          {label}
        </span>
        <Badge variant="outline" className="shrink-0">{value}</Badge>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function TrendChart({ buckets }) {
  if (buckets.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">표시할 구간이 없습니다.</p>
  }
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const BAR_BUDGET_PX = 120
  return (
    // items-end so each bucket sits flush with the chart's bottom edge;
    // bars then visually grow upward as their bucket gets taller.
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
              className={cn(
                'w-full rounded-t',
                b.count > 0 ? 'bg-primary' : 'bg-muted',
              )}
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

/** Distinct template_ids referenced anywhere in the report (pages array
 *  takes precedence; falls back to the top-level binding for legacy rows). */
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

function periodRange(option) {
  const now = new Date()
  const to = endOfDay(now)
  let from = null
  switch (option) {
    case 'this-week': {
      const d = new Date(now)
      const day = d.getDay() || 7   // make Monday=1, Sunday=7
      d.setDate(d.getDate() - day + 1)
      from = startOfDay(d)
      break
    }
    case 'this-month':
      from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      break
    case 'last-4-weeks':
      from = startOfDay(daysAgo(now, 28))
      break
    case 'last-12-weeks':
      from = startOfDay(daysAgo(now, 84))
      break
    case 'last-6-months':
      from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate(), 0, 0, 0, 0)
      break
    case 'last-12-months':
      from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 0, 0, 0, 0)
      break
    case 'all':
    default:
      from = null
  }
  return { from, to }
}

function daysAgo(d, n) {
  const out = new Date(d)
  out.setDate(out.getDate() - n)
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

/** Enumerate every week/month bucket between `from` and `to` so empty
 *  periods show as zero bars (not silently dropped). When period=all and
 *  `from` is null, walks from the earliest report's created_at instead. */
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

/** Backend emits naive UTC ISO ("2026-05-18T07:28:26.264452"). JS's
 *  default `new Date()` reads that as local time, which throws all
 *  week/month bucketing off by the local UTC offset. Force-anchor to UTC. */
function parseUtcIso(iso) {
  if (!iso) return null
  const s = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function enumerateBuckets(from, to, unit) {
  const out = []
  if (unit === 'week') {
    const cur = new Date(from)
    const day = cur.getDay() || 7
    cur.setDate(cur.getDate() - day + 1)  // snap to Monday
    cur.setHours(0, 0, 0, 0)
    while (cur <= to) {
      const key = isoWeekKey(cur)
      out.push({ key, label: weekShortLabel(cur) })
      cur.setDate(cur.getDate() + 7)
    }
  } else {
    const cur = new Date(from.getFullYear(), from.getMonth(), 1)
    while (cur <= to) {
      out.push({ key: monthKey(cur), label: monthShortLabel(cur) })
      cur.setMonth(cur.getMonth() + 1)
    }
  }
  return out
}

/** ISO 8601 week key — "2026-W18". Weeks start Monday; the week is owned
 *  by the year that contains its Thursday. */
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

function weekShortLabel(monday) {
  // e.g. "W18" — short for the chart axis; full ISO week is in the tooltip.
  return `W${isoWeekKey(monday).split('-W')[1]}`
}
function monthShortLabel(firstOfMonth) {
  return `${String(firstOfMonth.getMonth() + 1)}월`
}

function formatDate(d) {
  if (!d) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
