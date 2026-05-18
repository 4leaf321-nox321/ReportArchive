import { useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { PeriodFilterControls, usePeriodFilter } from '@/shared/components/PeriodFilterControls'
import {
  isoWeekKey,
  monthKey,
  parseUtcIso,
  startOfIsoWeek,
} from '@/shared/lib/period'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from '@/modules/reports/api'
import { listTemplates } from '@/shared/api/templates'
import { STATUSES } from '@/modules/reports/constants'
import { cn } from '@/shared/lib/utils'

// Stable color slots for the three report statuses on the dashboard's
// status panel — match the StatusField badge tones visually.
const STATUS_COLORS = {
  draft:       '#94a3b8', // slate-400 — 작성 중
  in_progress: '#3b82f6', // blue-500  — 진행 업무
  completed:   '#10b981', // emerald-500 — 완료 업무
}

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
  const period = usePeriodFilter('month')
  const unit = period.meta.unit

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

  const range = period.range

  const inRange = useMemo(() => {
    const all = reports ?? []
    if (!range.from) return all
    return all.filter((r) => {
      const t = parseReportDate(r)
      return t && t >= range.from && t <= range.to
    })
  }, [reports, range])

  // The workspace × template panel only shows the current workspace plus
  // its direct children — going one more level deep tends to drown the
  // chart in single-team rows. Reports filed under grandchildren get
  // rolled up to whichever direct child owns them so no data is lost.
  const scopedSlugs = useMemo(() => {
    if (!slug) return []
    const wsMap = new Map((workspaces ?? []).map((w) => [w.slug, w]))
    const self = wsMap.get(slug)
    if (!self || self.virtual) return []
    const out = [slug]
    for (const w of workspaces ?? []) {
      if (w.parent_slug === slug && !w.virtual) out.push(w.slug)
    }
    return out
  }, [slug, workspaces])

  // Map every visible report's workspace to a scoped row (self or direct
  // child). Walks up parent_slug until it lands inside scopedSlugs, so a
  // 3-deep report still gets attributed to the right level-1 bucket.
  const rollupForReport = useMemo(() => {
    const wsMap = new Map((workspaces ?? []).map((w) => [w.slug, w]))
    const scopedSet = new Set(scopedSlugs)
    const cache = new Map()
    return (reportWsSlug) => {
      if (cache.has(reportWsSlug)) return cache.get(reportWsSlug)
      let cur = reportWsSlug
      const seen = new Set()
      while (cur && !seen.has(cur)) {
        if (scopedSet.has(cur)) {
          cache.set(reportWsSlug, cur)
          return cur
        }
        seen.add(cur)
        cur = wsMap.get(cur)?.parent_slug ?? null
      }
      cache.set(reportWsSlug, null)
      return null
    }
  }, [workspaces, scopedSlugs])

  // Workspace × template cross-tab — counts[wsSlug][templateId] = N.
  // A multi-page report contributes once per distinct template it uses.
  const crosstab = useMemo(() => {
    const counts = new Map()
    const templateUsage = new Map()  // for legend ordering by usage
    for (const wsSlug of scopedSlugs) counts.set(wsSlug, new Map())
    for (const r of inRange) {
      const bucket = rollupForReport(r.workspace_slug)
      if (!bucket) continue
      const tplIds = uniqueTemplateIds(r)
      const inner = counts.get(bucket)
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

  // Status breakdown — keep a fixed enum order so the bar layout doesn't
  // reshuffle just because counts change.
  const statusCounts = useMemo(() => {
    const counts = new Map(STATUSES.map((s) => [s.value, 0]))
    for (const r of inRange) {
      if (counts.has(r.status)) counts.set(r.status, counts.get(r.status) + 1)
    }
    return counts
  }, [inRange])

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

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="대시보드"
        description={
          workspace
            ? `${workspace.name}${workspace.virtual ? ' (횡단)' : ''} 및 하위 부서`
            : ''
        }
        actions={<PeriodFilterControls period={period} />}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KPI label="총 보고서" value={totalReports} />
        <KPI label="작성자" value={distinctAuthors} />
        <KPI label="사용된 템플릿" value={distinctTemplates} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">상태별</CardTitle>
          <CardDescription>업무 진행 상태 분포</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBreakdown counts={statusCounts} total={totalReports} />
        </CardContent>
      </Card>

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
            현재 부서 + 한 단계 아래 부서. 더 깊은 하위 부서의 보고서는 그 직속 자식 부서로 합산
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

// ───────────────────────── Status breakdown ────────────────────────────
function StatusBreakdown({ counts, total }) {
  if (total === 0) {
    return <p className="text-sm text-muted-foreground py-3">기간 내 보고서 없음</p>
  }
  return (
    <div className="space-y-3">
      {/* Single proportional bar so the eye can compare relative weight
          immediately; tabular rows below for exact counts + percentages. */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/60">
        {STATUSES.map((s) => {
          const n = counts.get(s.value) ?? 0
          if (n === 0) return null
          return (
            <div
              key={s.value}
              style={{ width: `${(n / total) * 100}%`, backgroundColor: STATUS_COLORS[s.value] }}
              title={`${s.label} · ${n}건 (${Math.round((n / total) * 100)}%)`}
            />
          )
        })}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {STATUSES.map((s) => {
          const n = counts.get(s.value) ?? 0
          const pct = total > 0 ? Math.round((n / total) * 100) : 0
          return (
            <div key={s.value} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: STATUS_COLORS[s.value] }}
              />
              <span className="text-xs text-muted-foreground">{s.label}</span>
              <span className="ml-auto text-xs tabular-nums">
                {n}
                <span className="text-muted-foreground/70"> · {pct}%</span>
              </span>
            </div>
          )
        })}
      </div>
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
  // workspaceSlugs[0] is always the currently-selected workspace (self).
  // Keep it pinned at the top so it stays an obvious reference row; the
  // rest are direct children sorted by total desc so the busiest sub-org
  // surfaces first, with empty rows kept visible to make absences obvious.
  const selfSlug = workspaceSlugs[0]
  const rows = workspaceSlugs.map((ws) => {
    const inner = crosstab.counts.get(ws) ?? new Map()
    const total = [...inner.values()].reduce((a, b) => a + b, 0)
    return { ws, inner, total }
  })
  rows.sort((a, b) => {
    if (a.ws === selfSlug) return -1
    if (b.ws === selfSlug) return 1
    return b.total - a.total || a.ws.localeCompare(b.ws)
  })

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

function bucketizeReports(filtered, unit, range, allReports) {
  const from = range.from ?? earliestCreatedAt(allReports)
  if (!from) return []
  const to = range.to ?? new Date()

  const counts = new Map()
  const buckets = enumerateBuckets(from, to, unit)
  for (const b of buckets) counts.set(b.key, { ...b, count: 0 })
  for (const r of filtered) {
    const d = parseReportDate(r)
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
    const d = parseReportDate(r)
    if (!d) continue
    if (!min || d < min) min = d
  }
  return min
}

/** Pull the aggregation date for a report. Prefers report_date (the
 *  editable aggregation reference) and falls back to created_at for any
 *  legacy row that somehow lacks it. report_date is a plain date string
 *  ("YYYY-MM-DD"); created_at is a naive UTC datetime. */
function parseReportDate(r) {
  if (r?.report_date) {
    const d = new Date(`${r.report_date}T00:00:00Z`)
    if (!Number.isNaN(d.getTime())) return d
  }
  return parseUtcIso(r?.created_at)
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

function formatDate(d) {
  if (!d) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
