import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  PeriodFilterControls,
  usePeriodFilter,
} from '@/shared/components/PeriodFilterControls'
import { dateInPeriodRange, formatRangeLabel } from '@/shared/lib/period'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listComposites } from '@/shared/api/composites'
import { KINDS, KIND_LABEL, KIND_VARIANT } from './constants'
import { NewCompositeDialog } from './NewCompositeDialog'

/** 종합보고 목록. The reports API + composites API are sibling endpoints —
 *  same UX pattern, but composites carry kind/period_date instead of a
 *  template binding. */
export default function CompositesListPage() {
  const { slug, workspace, all: workspaces } = useWorkspace()
  const navigate = useNavigate()
  const [newOpen, setNewOpen] = useState(false)
  const period = usePeriodFilter('month')

  const { data: items, loading, error, reload } = useAsync(
    () => (slug ? listComposites() : Promise.resolve([])),
    [slug],
  )

  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])

  // Period filter targets period_date — applies to recurring composites
  // only. Theme composites have no date, so they fall out of the list
  // when a range is active (by design, mirroring the picker dialog).
  const list = (items ?? [])
    .filter((r) => dateInPeriodRange(r.period_date, period.range))
    .map((r) => ({
      ...r,
      workspace_name: workspaceName(r.workspace_slug),
    }))

  const columns = [
    { key: 'title', header: '제목', sortable: true, cellClassName: 'font-medium' },
    {
      key: 'kind',
      header: '타입',
      sortable: true,
      render: (r) => (
        <Badge variant={KIND_VARIANT[r.kind]} className="text-[10px]">
          {KIND_LABEL[r.kind] ?? r.kind}
        </Badge>
      ),
    },
    {
      key: 'period_date',
      header: '기준일',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap font-mono">
          {r.period_date ?? '—'}
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

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="종합보고"
        description={
          workspace
            ? `${workspace.name} 및 하위 부서${workspace.virtual ? ' (횡단)' : ''} — ${list.length}건 · ${formatRangeLabel(period.range)}`
            : ''
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <PeriodFilterControls period={period} />
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
        <DataTable
          columns={columns}
          data={list}
          searchableKeys={['title', 'kind', 'workspace_slug', 'workspace_name', 'owner_name', 'owner_email']}
          searchPlaceholder="제목, 타입, 부서, 작성자 검색"
          onRowClick={(r) => navigate(`/w/${slug}/composites/${r.id}`)}
        />
      )}

      <NewCompositeDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        currentWorkspaceSlug={slug}
        workspaces={workspaces}
        onCreated={(id) => {
          setNewOpen(false)
          toast.success('종합보고가 생성되었습니다.')
          navigate(`/w/${slug}/composites/${id}`)
        }}
      />
    </div>
  )
}
