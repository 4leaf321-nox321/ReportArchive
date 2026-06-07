import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, Calendar, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react'
import { SharePopover } from '@/shared/components/SharePopover'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent } from '@/shared/components/ui/card'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import {
  PeriodFilterControls,
  usePeriodFilter,
} from '@/shared/components/PeriodFilterControls'
import { dateInPeriodRange, formatRangeLabel } from '@/shared/lib/period'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listComposites } from '@/shared/api/composites'
import { NewCompositeDialog } from './NewCompositeDialog'

/** 종합보고 목록 — 정기(period-anchored) vs 주제(time-independent) 는
 *  brain models 가 달라서 한 리스트에 섞으면 어색해진다. Tabs 으로
 *  분리:
 *    - 정기  : period 필터 활성 + 월별 그룹핑 헤더 (시간축 인덱스)
 *    - 주제  : period 필터 숨김 + 단순 sortable 테이블 (제목 인덱스)
 *  Tab 라벨에 각각의 건수를 박아 두어 어느 쪽에 데이터가 있는지 즉시
 *  보이게 한다.
 */
export default function CompositesListPage() {
  const { slug, workspace, all: workspaces } = useWorkspace()
  const navigate = useNavigate()
  const location = useLocation()
  const [newOpen, setNewOpen] = useState(false)
  // 상세에서 "목록"으로 돌아올 때 보던 주차/탭을 복원(location.state). 없으면
  // 기본(현재 주차·정기 탭). 하드 새로고침 시엔 state 가 사라져 기본값.
  const [tab, setTab] = useState(() =>
    location.state?.listKind === 'theme' ? 'theme' : 'recurring',
  )
  const period = usePeriodFilter('week', location.state?.listAnchorDate)
  // 주제 탭은 period_date 가 없어 정기와 같은 주/월 축은 안 맞지만,
  // 연도 정도 단위는 인덱스로 의미가 있다. created_at 기준으로 한 해에
  // 만들어진 것만 보여준다. 기본값은 현재 연도.
  const [themeYear, setThemeYear] = useState(() => new Date().getFullYear())

  const { data: items, loading, error, reload } = useAsync(
    () => (slug ? listComposites() : Promise.resolve([])),
    [slug],
  )

  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])

  const decorated = useMemo(
    () =>
      (items ?? []).map((r) => ({
        ...r,
        workspace_name: workspaceName(r.workspace_slug),
      })),
    [items, workspaceName],
  )

  const recurring = useMemo(
    () =>
      decorated
        .filter((r) => r.kind === 'recurring')
        .filter((r) => dateInPeriodRange(r.period_date, period.range)),
    [decorated, period.range],
  )
  const themesAll = useMemo(
    () => decorated.filter((r) => r.kind === 'theme'),
    [decorated],
  )
  // 선택된 연도 안에서 만들어진 것만. created_at 은 백엔드 schema 가
  // 필수라 nullish 케이스는 거의 없지만, 혹시라도 빠져 있으면 필터에서
  // 빠뜨려서 사용자가 의아한 항목을 보지 않게 한다.
  const themes = useMemo(
    () =>
      themesAll.filter((r) => {
        if (!r.created_at) return false
        return new Date(r.created_at).getFullYear() === themeYear
      }),
    [themesAll, themeYear],
  )

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="종합보고"
        description={
          workspace
            ? `${workspace.name}${workspace.virtual ? ' (횡단)' : ''} — 정기 ${recurring.length}건 · 주제 ${themes.length}건`
            : ''
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {tab === 'recurring' && <PeriodFilterControls period={period} />}
            {tab === 'theme' && (
              <YearNavigator
                year={themeYear}
                onPrev={() => setThemeYear((y) => y - 1)}
                onNext={() => setThemeYear((y) => y + 1)}
              />
            )}
            {!workspace?.virtual && (
              <Button onClick={() => setNewOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                새 종합보고
              </Button>
            )}
          </div>
        }
      />

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-96" />
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="recurring">
              <Calendar className="mr-1.5 h-3.5 w-3.5" />
              정기 ({recurring.length})
            </TabsTrigger>
            <TabsTrigger value="theme">
              <BookOpen className="mr-1.5 h-3.5 w-3.5" />
              주제 ({themes.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="recurring" className="mt-3">
            <RecurringList
              items={recurring}
              rangeLabel={formatRangeLabel(period.range)}
              onOpen={(r) => navigate(`/w/${slug}/composites/${r.id}`)}
            />
          </TabsContent>

          <TabsContent value="theme" className="mt-3">
            <ThemeList
              items={themes}
              year={themeYear}
              workspaceName={workspaceName}
              onOpen={(r) => navigate(`/w/${slug}/composites/${r.id}`)}
            />
          </TabsContent>
        </Tabs>
      )}

      <NewCompositeDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        currentWorkspaceSlug={slug}
        workspaces={workspaces}
        onCreated={(id) => {
          setNewOpen(false)
          toast.success('종합보고가 생성되었습니다.')
          // 생성 직후 바로 편집 모드로 진입 — 사용자가 어차피 곧장 편집한다.
          navigate(`/w/${slug}/composites/${id}`, {
            state: { startEditing: true },
          })
        }}
      />
    </div>
  )
}

/** 정기 종합 — period_date 기준 월 그룹으로 묶어 시간축 인덱스처럼
 *  보여준다. 같은 달의 종합이 여러 건이면 그 안에서 날짜 desc 정렬.
 *  월별로 「YYYY년 M월 (N건)」 헤더가 위에 붙는다. */
function RecurringList({ items, rangeLabel, onOpen }) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          {rangeLabel} 범위에 정기 종합이 없습니다.
        </CardContent>
      </Card>
    )
  }
  // Group by YYYY-MM; null period_date is rare for recurring but
  // possible (legacy data) — bucket those under a "(기준일 없음)"
  // group at the end.
  const groups = new Map()
  for (const it of items) {
    const key = it.period_date ? it.period_date.slice(0, 7) : '__nodate'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(it)
  }
  // Sort group keys: real months desc, no-date bucket last.
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === '__nodate') return 1
    if (b === '__nodate') return -1
    return b.localeCompare(a)
  })
  return (
    <div className="space-y-4">
      <div className="text-[11px] text-muted-foreground">
        범위: {rangeLabel} · {items.length}건
      </div>
      {sortedKeys.map((key) => {
        const list = groups.get(key) ?? []
        list.sort((a, b) => (b.period_date ?? '').localeCompare(a.period_date ?? ''))
        return (
          <section key={key}>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pb-1.5 border-b mb-1.5">
              {formatMonthHeader(key)} <span className="ml-1 font-normal">({list.length})</span>
            </h3>
            <div className="divide-y border rounded-md overflow-hidden">
              {list.map((r) => (
                <RecurringRow key={r.id} item={r} onClick={() => onOpen(r)} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function RecurringRow({ item, onClick }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      }}
      className="w-full grid grid-cols-12 gap-3 px-3 py-2 text-left hover:bg-muted/40 transition-colors cursor-pointer"
    >
      <div className="col-span-1 font-mono text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {item.period_date ?? '—'}
      </div>
      <div className="col-span-5 font-medium text-sm flex items-center gap-1.5 min-w-0">
        <span className="truncate">{item.title}</span>
        <SharePopover
          contentType="composites"
          contentId={item.id}
          ownerUserId={item.owner_user_id}
          compact
          initialGrants={item.shares}
          triggerClassName="text-muted-foreground hover:text-foreground shrink-0"
        />
      </div>
      <div className="col-span-2 text-xs text-muted-foreground truncate" title={item.workspace_slug}>
        {item.workspace_name}
      </div>
      <div className="col-span-1 text-xs text-muted-foreground tabular-nums">
        {item.item_count}건
      </div>
      <div className="col-span-2 text-xs text-muted-foreground truncate">
        {item.owner_name ?? '—'}
      </div>
      <div className="col-span-1 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {item.updated_at?.slice(0, 10) ?? '—'}
      </div>
    </div>
  )
}

function formatMonthHeader(key) {
  if (key === '__nodate') return '(기준일 없음)'
  const [y, m] = key.split('-')
  return `${y}년 ${Number(m)}월`
}

/** 주제 종합 — period_date 가 없지만 생성 연도 단위로는 인덱스가
 *  의미가 있다. 페이지가 연도 필터를 걸어 한 해 분량만 넘겨주면 그
 *  안에서 sortable 테이블로 제목·작성자·부서·수정일 인덱싱. */
function ThemeList({ items, year, workspaceName, onOpen }) {
  const columns = [
    {
      key: 'title',
      header: '제목',
      sortable: true,
      cellClassName: 'font-medium',
      render: (r) => (
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{r.title}</span>
          <SharePopover
            contentType="composites"
            contentId={r.id}
            ownerUserId={r.owner_user_id}
            compact
            initialGrants={r.shares}
            triggerClassName="text-muted-foreground hover:text-foreground shrink-0"
          />
        </span>
      ),
    },
    {
      key: 'workspace_slug',
      header: '부서',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-muted-foreground" title={r.workspace_slug}>
          {workspaceName(r.workspace_slug)}
        </span>
      ),
    },
    {
      key: 'item_count',
      header: '안건',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-muted-foreground tabular-nums">{r.item_count}건</span>
      ),
    },
    {
      key: 'owner_name',
      header: '작성자',
      sortable: true,
      render: (r) => (
        <span
          className="text-xs text-muted-foreground"
          title={r.owner_email ? `${r.owner_name} (${r.owner_email})` : undefined}
        >
          {r.owner_name ?? '—'}
        </span>
      ),
    },
    {
      key: 'updated_at',
      header: '수정일',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {r.updated_at?.slice(0, 10) ?? '—'}
        </span>
      ),
    },
  ]
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          {year}년에 만들어진 주제 종합이 없습니다.
        </CardContent>
      </Card>
    )
  }
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground">
        범위: {year}년 · {items.length}건
      </div>
      <DataTable
        columns={columns}
        data={items}
        pageSizeStorageKey="composites-theme"
        searchableKeys={['title', 'workspace_slug', 'workspace_name', 'owner_name', 'owner_email']}
        searchPlaceholder="제목, 부서, 작성자 검색"
        onRowClick={onOpen}
      />
    </div>
  )
}

/** 연도 prev/next 네비게이터 — 정기 탭의 PointNavigator 와 동일한
 *  시각 패턴. 정기는 주/월/분기 등 여러 단위를 다뤄야 해서 별도
 *  컴포넌트를 가져오고, 주제는 연도 한 가지만 다루므로 로컬 inline. */
function YearNavigator({ year, onPrev, onNext }) {
  return (
    <div className="inline-flex items-center gap-1 h-9 rounded-md border bg-background px-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onPrev}
        aria-label="이전 연도"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-sm font-medium min-w-[5rem] text-center tabular-nums">
        {year}년
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onNext}
        aria-label="다음 연도"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
