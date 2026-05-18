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
      render: (r) => {
        // Multi-page reports may bind a different template per page. Show
        // every distinct (template_id, version) pair so the list reflects
        // the actual makeup. Falls back to the top-level binding when the
        // pages array is empty (legacy single-page rows).
        const pairs = uniqueTemplatePairs(r)
        const labels = pairs.map(
          ([id, ver]) => `${templateName(id)} v${ver}`,
        )
        const fullText = labels.join(', ')
        return (
          <span
            className="block truncate text-xs text-muted-foreground max-w-[260px]"
            title={fullText}
          >
            {fullText}
          </span>
        )
      },
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

/** Distinct `(template_id, template_version)` pairs across a report's pages,
 *  in first-seen order. Falls back to the legacy top-level binding when the
 *  report has no pages payload (e.g. legacy rows pre-multi-page). */
function uniqueTemplatePairs(report) {
  const pages = Array.isArray(report.pages) ? report.pages : []
  if (pages.length === 0) {
    return [[report.template_id, report.template_version]]
  }
  const seen = new Set()
  const out = []
  for (const p of pages) {
    const key = `${p.template_id}@${p.template_version}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([p.template_id, p.template_version])
  }
  return out
}
