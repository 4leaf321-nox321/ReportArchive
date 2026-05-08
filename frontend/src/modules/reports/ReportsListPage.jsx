import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from './api'
import { listTemplates } from '@/shared/api/templates'
import { STATUS_LABEL, STATUS_VARIANT } from './constants'

export default function ReportsListPage() {
  const { slug, workspace } = useWorkspace()
  const navigate = useNavigate()
  const { data: reports, loading, error, reload } = useAsync(
    () => (slug ? listReports() : Promise.resolve([])),
    [slug]
  )
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug]
  )
  const templateName = makeTemplateNameLookup(templates)

  const list = reports ?? []

  const columns = [
    { key: 'title', header: '제목', sortable: true, cellClassName: 'font-medium' },
    {
      key: 'template_id',
      header: '템플릿',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {templateName(r.template_id)}{' '}
          <span className="opacity-60">v{r.template_version}</span>
        </span>
      ),
    },
    {
      key: 'workspace_slug',
      header: '부서',
      sortable: true,
      render: (r) => <span className="text-xs text-muted-foreground">{r.workspace_slug}</span>,
    },
    {
      key: 'status',
      header: '상태',
      sortable: true,
      render: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
    },
    { key: 'period', header: '기간', sortable: true },
  ]

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="보고서"
        description={
          workspace ? `${workspace.name} — 총 ${list.length}건${workspace.virtual ? ' (횡단)' : ''}` : ''
        }
        actions={
          !workspace?.virtual && (
            <Button onClick={() => navigate(`/w/${slug}/reports/new`)}>
              <Plus className="mr-2 h-4 w-4" />
              신규 작성
            </Button>
          )
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
          searchableKeys={['title', 'template_id', 'workspace_slug', 'period']}
          searchPlaceholder="제목, 템플릿, 부서 검색"
          onRowClick={(r) => navigate(`/w/${slug}/reports/${r.id}`)}
        />
      )}
    </div>
  )
}

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
