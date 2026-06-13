import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { listFolders } from '@/shared/api/folders'
import { getWorkspaceCommentStats } from '@/shared/api/comments'
import { PHASES } from '@/modules/reports/constants'
import { cn } from '@/shared/lib/utils'

// 며칠 이상 업데이트 없는 'drafting' 보고서를 정체로 본다(건강도).
const STALE_DRAFT_DAYS = 14

// Stable color slots for the three ReportPhase values on the dashboard's
// 단계별 panel — match the PhaseChip badge tones visually (협업개선_설계.md
// §8.3). Phase 0 migration replaced ReportStatus (draft/in_progress/
// completed) with ReportPhase (drafting/reviewing/finalized); this map
// follows that rename.
const PHASE_COLORS = {
  drafting:  '#94a3b8', // slate-400  — 작성 중
  reviewing: '#3b82f6', // blue-500   — 리뷰 중
  finalized: '#10b981', // emerald-500 — 발행됨
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
  const navigate = useNavigate()
  const period = usePeriodFilter('week')
  const unit = period.meta.unit

  const { data: reports, loading, error, reload } = useAsync(
    () => (slug ? listReports() : Promise.resolve([])),
    [slug],
  )
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug],
  )
  // 미분류(폴더 없는 mount) 수 — 건강도용. org/personal 모두 listFolders 가
  // uncategorized_count 를 돌려준다.
  const { data: folderData } = useAsync(
    () => (slug ? listFolders({ workspaceSlug: slug }) : Promise.resolve({ uncategorized_count: 0 })),
    [slug],
  )
  const uncategorizedCount = folderData?.uncategorized_count ?? 0
  // 미해결 코멘트 — 건강도용. 가상(_global) 컨텍스트는 호출 안 함(백엔드도 0).
  const { data: openThreads } = useAsync(
    () => (slug && !workspace?.virtual ? getWorkspaceCommentStats() : Promise.resolve(0)),
    [slug, workspace?.virtual],
  )
  const openCommentCount = openThreads ?? 0

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

  // 직전 기간(같은 길이의 바로 앞 구간) — KPI 전기 대비 Δ 용. 전체기간(from
  // 없음)이면 비교 대상이 없어 null.
  const prev = useMemo(() => {
    if (!range.from || !range.to) return null
    const span = range.to.getTime() - range.from.getTime()
    const prevFrom = new Date(range.from.getTime() - span)
    const prevTo = new Date(range.from.getTime())
    let total = 0
    const authors = new Set()
    const tpls = new Set()
    for (const r of reports ?? []) {
      const t = parseReportDate(r)
      if (!t || t < prevFrom || t >= prevTo) continue
      total += 1
      if (r.owner_user_id != null) authors.add(r.owner_user_id)
      for (const id of uniqueTemplateIds(r)) tpls.add(id)
    }
    return { total, authors: authors.size, templates: tpls.size }
  }, [range, reports])

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

  // Map a workspace slug → which scoped row it belongs to (self or any
  // ancestor inside scopedSlugs). Pure parent-walk helper; reused for
  // every mount slug on every visible report.
  const rollupSlug = useMemo(() => {
    const wsMap = new Map((workspaces ?? []).map((w) => [w.slug, w]))
    const scopedSet = new Set(scopedSlugs)
    const cache = new Map()
    return (wsSlug) => {
      if (cache.has(wsSlug)) return cache.get(wsSlug)
      let cur = wsSlug
      const seen = new Set()
      while (cur && !seen.has(cur)) {
        if (scopedSet.has(cur)) {
          cache.set(wsSlug, cur)
          return cur
        }
        seen.add(cur)
        cur = wsMap.get(cur)?.parent_slug ?? null
      }
      cache.set(wsSlug, null)
      return null
    }
  }, [workspaces, scopedSlugs])

  // Workspace × template cross-tab — counts[wsSlug][templateId] = N.
  // A multi-page report contributes once per distinct template it uses,
  // and once per distinct scoped bucket it's mounted to (so a report
  // mounted to both dx-team1 and dx-team2 shows in both team columns).
  //
  // Post-Phase-1 a report's own `workspace_slug` is always its author's
  // personal space, so attribution must walk `mount_workspaces`. Reports
  // with no mounts in scope are dropped — they shouldn't appear in any
  // chart column even if the date filter caught them.
  const crosstab = useMemo(() => {
    const counts = new Map()
    const templateUsage = new Map()  // for legend ordering by usage
    for (const wsSlug of scopedSlugs) counts.set(wsSlug, new Map())
    for (const r of inRange) {
      const buckets = new Set()
      for (const m of r.mount_workspaces ?? []) {
        const b = rollupSlug(m.slug)
        if (b) buckets.add(b)
      }
      if (buckets.size === 0) continue
      const tplIds = uniqueTemplateIds(r)
      for (const bucket of buckets) {
        const inner = counts.get(bucket)
        for (const id of tplIds) {
          inner.set(id, (inner.get(id) ?? 0) + 1)
          templateUsage.set(id, (templateUsage.get(id) ?? 0) + 1)
        }
      }
    }
    const orderedTemplates = [...templateUsage.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
    const colorOf = new Map(orderedTemplates.map((id, i) => [id, PALETTE[i % PALETTE.length]]))
    return { counts, orderedTemplates, colorOf }
  }, [inRange, scopedSlugs, rollupSlug])

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

  // 건강도 — 정체 draft(현재 상태 기준이라 기간 필터와 무관, 전체 보고서에서).
  const staleDraftCount = useMemo(() => {
    const cutoff = Date.now() - STALE_DRAFT_DAYS * 86400000
    let n = 0
    for (const r of reports ?? []) {
      if (r.phase !== 'drafting') continue
      const t = parseUtcIso(r.updated_at)
      if (t && t.getTime() < cutoff) n += 1
    }
    return n
  }, [reports])

  // 엔티티(모델) 커버리지 — 선택 기간(inRange) 기준. value 가 표시 라벨.
  const entityCoverage = useMemo(() => {
    const freq = new Map() // id → { label, count }
    let noEntity = 0
    for (const r of inRange) {
      const ents = Array.isArray(r.entities) ? r.entities : []
      if (ents.length === 0) {
        noEntity += 1
        continue
      }
      for (const e of ents) {
        const cur = freq.get(e.id) ?? { label: e.value ?? String(e.id), count: 0 }
        cur.count += 1
        freq.set(e.id, cur)
      }
    }
    const top = [...freq.values()].sort((a, b) => b.count - a.count).slice(0, 8)
    return { top, noEntity, distinct: freq.size }
  }, [inRange])

  // 작성자 Top — 선택 기간(inRange) 기준, 작성자별 보고서 수 상위. 소유자
  // id 로 묶고(없으면 이름으로) owner_name 을 라벨로 쓴다.
  const authorTop = useMemo(() => {
    const freq = new Map() // key → { label, count }
    let unknown = 0
    for (const r of inRange) {
      const id = r.owner_user_id
      const name = r.owner_name
      if (id == null && !name) {
        unknown += 1
        continue
      }
      const key = id != null ? `u:${id}` : `n:${name}`
      const cur = freq.get(key) ?? { label: name ?? '(알 수 없음)', count: 0 }
      cur.count += 1
      freq.set(key, cur)
    }
    const top = [...freq.values()].sort((a, b) => b.count - a.count).slice(0, 8)
    return { top, distinct: freq.size, unknown }
  }, [inRange])

  // Phase breakdown — keep a fixed enum order so the bar layout doesn't
  // reshuffle just because counts change.
  const phaseCounts = useMemo(() => {
    const counts = new Map(PHASES.map((p) => [p.value, 0]))
    for (const r of inRange) {
      if (counts.has(r.phase)) counts.set(r.phase, counts.get(r.phase) + 1)
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
        <KPI
          label="총 보고서"
          value={totalReports}
          delta={prev ? totalReports - prev.total : null}
          onClick={() => navigate(`/w/${slug}/reports`)}
        />
        <KPI
          label="작성자"
          value={distinctAuthors}
          delta={prev ? distinctAuthors - prev.authors : null}
        />
        <KPI
          label="사용된 템플릿"
          value={distinctTemplates}
          delta={prev ? distinctTemplates - prev.templates : null}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">단계별</CardTitle>
          <CardDescription>협업 단계 분포 (작성 중 / 리뷰 중 / 발행됨)</CardDescription>
        </CardHeader>
        <CardContent>
          <PhaseBreakdown
            counts={phaseCounts}
            total={totalReports}
            onSelect={(phase) => navigate(`/w/${slug}/reports`, { state: { phase } })}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">부서 건강도</CardTitle>
            <CardDescription>현재 상태 기준 — 손볼 거리</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3">
              <HealthTile
                label={`정체 초안 (${STALE_DRAFT_DAYS}일+)`}
                value={staleDraftCount}
                tone={staleDraftCount > 0 ? 'warn' : 'ok'}
                onClick={() =>
                  navigate(`/w/${slug}/reports`, {
                    // phase + staleDraftDays 를 함께 넘겨 목록이 '작성 중 +
                    // N일+ 미수정' 으로 정확히 같은 집합을 보이게 한다(타일
                    // 숫자와 일치).
                    state: { phase: 'drafting', staleDraftDays: STALE_DRAFT_DAYS },
                  })
                }
              />
              <HealthTile
                label="미분류"
                value={uncategorizedCount}
                tone={uncategorizedCount > 0 ? 'warn' : 'ok'}
                onClick={() =>
                  navigate(`/w/${slug}/reports`, {
                    state: { listFolderId: 'uncategorized' },
                  })
                }
              />
              {/* 목록에 '코멘트 있음' 필터가 없어 정보 표시용(클릭 없음).
                  개인 코멘트 인박스는 계정 스코프라 부서 건강도와 다르다. */}
              <HealthTile
                label="미해결 코멘트"
                value={openCommentCount}
                tone={openCommentCount > 0 ? 'warn' : 'ok'}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">엔티티(모델) 커버리지</CardTitle>
            <CardDescription>
              기간 내 보고서가 다룬 모델 · 상위 {entityCoverage.top.length}개
            </CardDescription>
          </CardHeader>
          <CardContent>
            {entityCoverage.distinct === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                이 기간에 연결된 엔티티가 없습니다.
              </p>
            ) : (
              <EntityCoverage coverage={entityCoverage} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">작성자 Top</CardTitle>
          <CardDescription>
            기간 내 작성자별 보고서 수 · 상위 {authorTop.top.length}명
            {authorTop.distinct > authorTop.top.length
              ? ` (전체 ${authorTop.distinct}명)`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {authorTop.distinct === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              이 기간에 작성된 보고서가 없습니다.
            </p>
          ) : (
            <BarList
              items={authorTop.top}
              footer={
                authorTop.unknown > 0
                  ? `작성자 미상 ${authorTop.unknown}건`
                  : null
              }
            />
          )}
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
                onSelectWorkspace={(ws) => navigate(`/w/${ws}/reports`)}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ───────────────────────── KPI ──────────────────────────────────────────
function KPI({ label, value, delta, onClick }) {
  const clickable = typeof onClick === 'function'
  return (
    <Card
      className={clickable ? 'cursor-pointer transition-colors hover:bg-muted/40' : undefined}
      onClick={onClick}
    >
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 flex items-baseline gap-2">
          <div className="text-3xl font-semibold">{value}</div>
          {delta != null && delta !== 0 && (
            <span
              className={cn(
                'text-xs font-medium',
                delta > 0 ? 'text-emerald-600' : 'text-rose-600',
              )}
            >
              {delta > 0 ? '▲' : '▼'}
              {Math.abs(delta)}
            </span>
          )}
          {delta === 0 && <span className="text-xs text-muted-foreground">±0</span>}
        </div>
        {delta != null && (
          <div className="text-[10px] text-muted-foreground mt-0.5">직전 기간 대비</div>
        )}
      </CardContent>
    </Card>
  )
}

// ───────────────────────── Health tile ─────────────────────────────────
function HealthTile({ label, value, tone, onClick }) {
  const clickable = typeof onClick === 'function' && value > 0
  return (
    <div
      className={cn(
        'rounded-md border p-3',
        clickable && 'cursor-pointer transition-colors hover:bg-muted/40',
      )}
      onClick={clickable ? onClick : undefined}
      title={clickable ? `${label} 보고서 보기` : undefined}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold',
          tone === 'warn' && value > 0 ? 'text-amber-600' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  )
}

// ───────────────────────── Entity coverage ─────────────────────────────
function EntityCoverage({ coverage }) {
  return (
    <BarList
      items={coverage.top}
      footer={
        coverage.noEntity > 0 ? `엔티티 미연결 ${coverage.noEntity}건` : null
      }
    />
  )
}

// 가로 막대 목록 — {label, count}[] 을 상대 길이 막대로. 작성자 Top·엔티티
// 커버리지 등 "라벨별 건수 상위" 패널 공통.
function BarList({ items, footer }) {
  const max = Math.max(1, ...items.map((e) => e.count))
  return (
    <div className="space-y-1.5">
      {items.map((e) => (
        <div key={e.label} className="grid grid-cols-[9rem_1fr_2rem] gap-2 items-center">
          <span className="text-xs truncate" title={e.label}>
            {e.label}
          </span>
          <div className="h-2 rounded bg-muted/40 overflow-hidden">
            <div
              className="h-full bg-primary/70"
              style={{ width: `${(e.count / max) * 100}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-right text-muted-foreground">
            {e.count}
          </span>
        </div>
      ))}
      {footer && (
        <div className="pt-1 text-[11px] text-muted-foreground">{footer}</div>
      )}
    </div>
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

// ───────────────────────── Phase breakdown ─────────────────────────────
function PhaseBreakdown({ counts, total, onSelect }) {
  if (total === 0) {
    return <p className="text-sm text-muted-foreground py-3">기간 내 보고서 없음</p>
  }
  return (
    <div className="space-y-3">
      {/* Single proportional bar so the eye can compare relative weight
          immediately; tabular rows below for exact counts + percentages. */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/60">
        {PHASES.map((p) => {
          const n = counts.get(p.value) ?? 0
          if (n === 0) return null
          return (
            <div
              key={p.value}
              style={{ width: `${(n / total) * 100}%`, backgroundColor: PHASE_COLORS[p.value] }}
              title={`${p.label} · ${n}건 (${Math.round((n / total) * 100)}%)`}
            />
          )
        })}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {PHASES.map((p) => {
          const n = counts.get(p.value) ?? 0
          const pct = total > 0 ? Math.round((n / total) * 100) : 0
          const clickable = typeof onSelect === 'function' && n > 0
          return (
            <div
              key={p.value}
              className={cn(
                'flex items-center gap-2 rounded px-1 -mx-1',
                clickable && 'cursor-pointer hover:bg-muted/50',
              )}
              onClick={clickable ? () => onSelect(p.value) : undefined}
              title={clickable ? `${p.label} 보고서 보기` : undefined}
            >
              <span
                className="h-2.5 w-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: PHASE_COLORS[p.value] }}
              />
              <span className="text-xs text-muted-foreground">{p.label}</span>
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

function StackedBarChart({ workspaceSlugs, workspaceName, crosstab, templateName, onSelectWorkspace }) {
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
        <div
          key={ws}
          className={cn(
            'grid grid-cols-[10rem_1fr_2.5rem] gap-3 items-center rounded px-1 -mx-1',
            onSelectWorkspace && total > 0 && 'cursor-pointer hover:bg-muted/50',
          )}
          onClick={
            onSelectWorkspace && total > 0 ? () => onSelectWorkspace(ws) : undefined
          }
          title={onSelectWorkspace && total > 0 ? `${workspaceName(ws)} 보고서 보기` : undefined}
        >
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
