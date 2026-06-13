import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { PeriodFilterControls, usePeriodFilter } from '@/shared/components/PeriodFilterControls'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { getDashboard } from '@/shared/api/dashboard'
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
 * Dashboard for the currently-selected workspace.
 *
 * Two period modes:
 *   - Point  (kind='week'|'month') — inspect one specific ISO week or
 *     calendar month, navigable with ←/→ arrows. anchor is a Date inside
 *     the selected unit.
 *   - Range  (kind='last-N-…'|'all') — sliding window ending at now.
 *
 * The trend chart only shows when the active range spans multiple buckets.
 */
export default function DashboardPage() {
  const { workspace, slug } = useWorkspace()
  const navigate = useNavigate()
  const period = usePeriodFilter('week')
  const unit = period.meta.unit
  const range = period.range
  // 기간 → 서버 쿼리(YYYY-MM-DD). 전체기간이면 from/to 미전송.
  const from = range.from ? formatDate(range.from) : undefined
  const to = range.to ? formatDate(range.to) : undefined

  // Phase 3A — 모든 집계를 서버에서. 클라는 단일 호출로 받아 표시만 한다.
  const { data, loading, error, reload } = useAsync(
    () => (slug ? getDashboard({ from, to, unit }) : Promise.resolve(null)),
    [slug, from, to, unit],
  )

  const kpis = data?.kpis ?? { total: 0, authors: 0, templates: 0, prev: null }
  const prev = kpis.prev ?? null
  const totalReports = kpis.total ?? 0
  const distinctAuthors = kpis.authors ?? 0
  const distinctTemplates = kpis.templates ?? 0

  const trend = data?.trend ?? []
  const health = data?.health ?? {
    stale_drafts: 0,
    uncategorized: 0,
    open_comments: 0,
  }
  const staleDraftCount = health.stale_drafts ?? 0
  const uncategorizedCount = health.uncategorized ?? 0
  const openCommentCount = health.open_comments ?? 0

  // 엔티티 커버리지 — 서버는 snake_case(no_entity). 컴포넌트 prop 으로 매핑.
  const ec = data?.entity_coverage ?? { top: [], no_entity: 0, distinct: 0 }
  const entityCoverage = {
    top: ec.top ?? [],
    noEntity: ec.no_entity ?? 0,
    distinct: ec.distinct ?? 0,
  }
  const authorTop = data?.author_top ?? { top: [], distinct: 0, unknown: 0 }

  // Phase breakdown — 고정 enum 순서로 Map 화(레이아웃 안정).
  const phaseCounts = useMemo(() => {
    const pb = data?.phase_breakdown ?? {}
    return new Map(PHASES.map((p) => [p.value, pb[p.value] ?? 0]))
  }, [data])

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
              추세 ·{' '}
              {period.kind === 'year'
                ? '연중 월별'
                : period.kind === 'month'
                  ? '월중 주별'
                  : period.kind === 'by-year'
                    ? '연도별'
                    : unit === 'week'
                      ? '주별'
                      : '월별'}
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

// ───────────────────────── helpers ──────────────────────────────────────
function formatDate(d) {
  if (!d) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
