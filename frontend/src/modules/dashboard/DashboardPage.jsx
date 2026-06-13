import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { PeriodFilterControls, usePeriodFilter } from '@/shared/components/PeriodFilterControls'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { usePersistedState } from '@/shared/hooks/usePersistedState'
import { getDashboard, getCrosstab } from '@/shared/api/dashboard'
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
  const period = usePeriodFilter('week', null, 'ra:dash:period:v1')
  const unit = period.meta.unit
  const range = period.range
  // 기간 → 서버 쿼리(YYYY-MM-DD). 전체기간이면 from/to 미전송.
  const from = range.from ? formatDate(range.from) : undefined
  const to = range.to ? formatDate(range.to) : undefined

  // 하위부서 포함 토글 — org 게시판에서만. 켜면 자손 부서 게시판까지 롤업
  // (목록의 '하위부서 포함'과 동일 동작). 부서 전환 시 자동 false 로(키 slug).
  const isOrg = workspace?.kind === 'org'
  const [includeDescendants, setIncludeDescendants] = usePersistedState(
    'ra:dash:incldesc:v1',
    false,
  )
  const inclDesc = isOrg && includeDescendants

  // Phase 3A — 모든 집계를 서버에서. 클라는 단일 호출로 받아 표시만 한다.
  const { data, loading, error, reload } = useAsync(
    () =>
      slug
        ? getDashboard({ from, to, unit, includeDescendants: inclDesc })
        : Promise.resolve(null),
    [slug, from, to, unit, inclDesc],
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

  // 메타데이터 분포 — 차원(모델·불량·종류·템플릿…) 선택 드롭다운 1개 카드.
  // 선택 차원이 현재 응답에 없으면(기간 바뀜 등) 첫 차원으로 폴백.
  const distributions = data?.distributions ?? []
  // 대시보드 선택값은 localStorage 에 저장(재진입 시 복원). 저장된 차원이 현재
  // 워크스페이스 응답에 없으면 activeDist/Eff 계산에서 첫 차원으로 폴백.
  const [dimKey, setDimKey] = usePersistedState('ra:dash:dim:v1', '')
  const activeDist =
    distributions.find((d) => d.key === dimKey) ?? distributions[0] ?? null

  // 교차 분석 — 두 차원(행×열). 기본은 분포의 첫 두 차원.
  const [rowDim, setRowDim] = usePersistedState('ra:dash:row:v1', '')
  const [colDim, setColDim] = usePersistedState('ra:dash:col:v1', '')
  const rowDimEff =
    distributions.find((d) => d.key === rowDim)?.key ?? distributions[0]?.key ?? ''
  const colDimEff =
    distributions.find((d) => d.key === colDim)?.key ?? distributions[1]?.key ?? ''
  const { data: crosstab } = useAsync(
    () =>
      slug && rowDimEff && colDimEff && rowDimEff !== colDimEff
        ? getCrosstab({
            row: rowDimEff,
            col: colDimEff,
            from,
            to,
            includeDescendants: inclDesc,
          })
        : Promise.resolve(null),
    [slug, rowDimEff, colDimEff, from, to, inclDesc],
  )

  const authorTop = data?.author_top ?? { top: [], distinct: 0, unknown: 0 }

  // 드릴다운 시 현재 대시보드 스코프(기간·하위부서)를 목록에 함께 넘겨 개수를
  // 일치시킨다. 전체기간(from/to 없음)·하위부서 제외면 아무것도 안 붙는다.
  const withScope = (st) => ({
    ...st,
    ...(from && to ? { dateFrom: from, dateTo: to } : {}),
    ...(inclDesc ? { includeDescendants: true } : {}),
  })

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
            ? `${workspace.name}${
                workspace.virtual
                  ? ' (횡단)'
                  : inclDesc
                    ? ' 및 하위 부서'
                    : ''
              }`
            : ''
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {/* 하위부서 포함 — org 에서만(목록 사이드바와 동일 UX). 켜면 자손
                부서 게시판까지 롤업해 집계. */}
            {isOrg && (
              <button
                type="button"
                onClick={() => setIncludeDescendants((v) => !v)}
                className={cn(
                  'h-9 rounded-md border px-2.5 text-xs font-medium transition-colors',
                  includeDescendants
                    ? 'border-sky-300 bg-sky-50 text-sky-700'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted',
                )}
                title="하위 부서 게시판까지 합쳐서 집계 (권한 범위 내)"
              >
                하위부서 {includeDescendants ? '포함' : '제외'}
              </button>
            )}
            <PeriodFilterControls period={period} />
          </div>
        }
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
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">분포</CardTitle>
              {distributions.length > 0 && (
                <select
                  value={activeDist?.key ?? ''}
                  onChange={(e) => setDimKey(e.target.value)}
                  className="h-7 rounded border border-input bg-background px-1.5 text-xs"
                  aria-label="분포 차원"
                >
                  {distributions.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <CardDescription>
              {activeDist
                ? `기간 내 보고서를 ${activeDist.label} 기준으로` +
                  (activeDist.total > activeDist.items.length
                    ? ` · 상위 ${activeDist.items.length}/${activeDist.total}`
                    : '')
                : '기간 내 보고서 분포'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!activeDist || activeDist.items.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                이 기간에 표시할 분포가 없습니다.
              </p>
            ) : (
              <BarList
                items={activeDist.items}
                footer={
                  activeDist.no_value > 0 ? `미지정 ${activeDist.no_value}건` : null
                }
                // 막대 클릭 → 그 값으로 필터된 보고서 목록. 엔티티·종류·템플릿
                // 모두 드릴다운(목록에 대응 필터 있음).
                onItemClick={
                  slug
                    ? (item) => {
                        const st = distDrilldownState(activeDist.key, item)
                        if (st) navigate(`/w/${slug}/reports`, { state: withScope(st) })
                      }
                    : undefined
                }
              />
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

      {distributions.length >= 2 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-base">교차 분석</CardTitle>
              <div className="flex items-center gap-1.5 text-xs">
                <select
                  value={rowDimEff}
                  onChange={(e) => setRowDim(e.target.value)}
                  className="h-7 rounded border border-input bg-background px-1.5 text-xs"
                  aria-label="행 차원"
                >
                  {distributions.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground">×</span>
                <select
                  value={colDimEff}
                  onChange={(e) => setColDim(e.target.value)}
                  className="h-7 rounded border border-input bg-background px-1.5 text-xs"
                  aria-label="열 차원"
                >
                  {distributions.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <CardDescription>
              두 차원 교차 보고서 수 · 셀을 클릭하면 두 필터로 목록 이동
              {crosstab &&
              (crosstab.row_total > crosstab.rows.length ||
                crosstab.col_total > crosstab.cols.length)
                ? ` · 건수 상위만 표시 (행 ${crosstab.rows.length}/${crosstab.row_total} · 열 ${crosstab.cols.length}/${crosstab.col_total})`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rowDimEff === colDimEff ? (
              <p className="text-sm text-muted-foreground py-2">
                서로 다른 두 차원을 선택하세요.
              </p>
            ) : !crosstab ||
              crosstab.rows.length === 0 ||
              crosstab.cols.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                이 조합으로 교차할 데이터가 없습니다.
              </p>
            ) : (
              <CrosstabTable
                data={crosstab}
                onCell={(rh, ch) => {
                  const st = crosstabDrilldownState(rowDimEff, rh, colDimEff, ch)
                  if (st && slug)
                    navigate(`/w/${slug}/reports`, { state: withScope(st) })
                }}
              />
            )}
          </CardContent>
        </Card>
      )}

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

// ── 드릴다운 상태 빌더 ──────────────────────────────────────────────────
// 분포 막대 클릭 → 보고서 목록 location.state. 차원 키에 맞는 필터 하나.
function distDrilldownState(distKey, item) {
  if (distKey.startsWith('entity:') && item.entity_id != null) {
    return {
      entityFilter: [
        { id: item.entity_id, type_slug: distKey.slice('entity:'.length), value: item.label },
      ],
    }
  }
  if (distKey === 'report_type' && item.report_type_id != null) {
    return { reportTypeId: item.report_type_id }
  }
  if (distKey === 'template' && item.template_id != null) {
    return { templateId: item.template_id }
  }
  if (distKey === 'mount' && item.mount_slug) {
    return { mountWorkspaceSlug: item.mount_slug }
  }
  return null
}

// 한 차원 헤더 → 부분 필터 조각.
function headerFilterParts(dimKey, h) {
  if (dimKey.startsWith('entity:') && h.entity_id != null) {
    return {
      entity: { id: h.entity_id, type_slug: dimKey.slice('entity:'.length), value: h.label },
    }
  }
  if (dimKey === 'report_type' && h.report_type_id != null) {
    return { reportTypeId: h.report_type_id }
  }
  if (dimKey === 'template' && h.template_id != null) {
    return { templateId: h.template_id }
  }
  if (dimKey === 'mount' && h.mount_slug) {
    return { mountWorkspaceSlug: h.mount_slug }
  }
  return {}
}

// 교차표 셀 클릭 → 행·열 두 필터를 합친 location.state.
function crosstabDrilldownState(rowKey, rh, colKey, ch) {
  const parts = [headerFilterParts(rowKey, rh), headerFilterParts(colKey, ch)]
  const state = {}
  const ents = parts.filter((p) => p.entity).map((p) => p.entity)
  if (ents.length) state.entityFilter = ents
  const rt = parts.find((p) => p.reportTypeId != null)
  if (rt) state.reportTypeId = rt.reportTypeId
  const tpl = parts.find((p) => p.templateId != null)
  if (tpl) state.templateId = tpl.templateId
  const mnt = parts.find((p) => p.mountWorkspaceSlug)
  if (mnt) state.mountWorkspaceSlug = mnt.mountWorkspaceSlug
  return Object.keys(state).length ? state : null
}

// ───────────────────────── Crosstab table ──────────────────────────────
function CrosstabTable({ data, onCell }) {
  const { rows, cols, cells } = data
  const max = Math.max(
    1,
    ...rows.flatMap((r) => cols.map((c) => cells[r.key]?.[c.key] ?? 0)),
  )
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="p-1.5 sticky left-0 bg-background" />
            {cols.map((c) => (
              <th
                key={c.key}
                className="p-1.5 font-medium text-muted-foreground whitespace-nowrap max-w-[7rem] truncate"
                title={c.label}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td
                className="p-1.5 font-medium whitespace-nowrap max-w-[8rem] truncate sticky left-0 bg-background"
                title={r.label}
              >
                {r.label}
              </td>
              {cols.map((c) => {
                const n = cells[r.key]?.[c.key] ?? 0
                return (
                  <td key={c.key} className="p-0.5 text-center">
                    {n > 0 ? (
                      <button
                        type="button"
                        onClick={() => onCell(r, c)}
                        title={`${r.label} × ${c.label}: ${n}건 — 보고서 보기`}
                        className="w-full rounded px-2 py-1 tabular-nums hover:ring-1 hover:ring-primary"
                        style={{
                          backgroundColor: `rgba(59,130,246,${(0.08 + 0.5 * (n / max)).toFixed(3)})`,
                        }}
                      >
                        {n}
                      </button>
                    ) : (
                      <span className="text-muted-foreground/40">·</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 가로 막대 목록 — {label, count}[] 을 상대 길이 막대로. 작성자 Top·분포 등
// "라벨별 건수 상위" 패널 공통. onItemClick 주면 행이 클릭 가능(드릴다운).
function BarList({ items, footer, onItemClick }) {
  const max = Math.max(1, ...items.map((e) => e.count))
  return (
    <div className="space-y-1.5">
      {items.map((e) => {
        const clickable = typeof onItemClick === 'function'
        return (
          <div
            key={e.label}
            className={cn(
              'grid grid-cols-[9rem_1fr_2rem] gap-2 items-center rounded',
              clickable && 'cursor-pointer hover:bg-muted/40 -mx-1 px-1',
            )}
            onClick={clickable ? () => onItemClick(e) : undefined}
            title={clickable ? `${e.label} 보고서 보기` : e.label}
          >
            <span className="text-xs truncate">{e.label}</span>
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
        )
      })}
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
