import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from '@/modules/reports/api'
import { listTemplates } from '@/shared/api/templates'
import { STATUS_LABEL } from '@/modules/reports/constants'

export default function DashboardPage() {
  const { workspace, slug } = useWorkspace()
  const { data: reports, loading, error, reload } = useAsync(
    () => (slug ? listReports() : Promise.resolve([])),
    [slug]
  )
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug]
  )
  const templateName = makeTemplateNameLookup(templates)

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
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

  const list = reports ?? []
  const byStatus = list.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1
    return acc
  }, {})
  const byTemplate = list.reduce((acc, r) => {
    acc[r.template_id] = (acc[r.template_id] || 0) + 1
    return acc
  }, {})
  const byWorkspace = list.reduce((acc, r) => {
    acc[r.workspace_slug] = (acc[r.workspace_slug] || 0) + 1
    return acc
  }, {})

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="대시보드"
        description={`${workspace?.name ?? ''} ${workspace?.virtual ? '— 부서 횡단 집계' : '부서 보고서 집계'}`}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">상태별</CardTitle>
            <CardDescription>워크플로 분포</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(byStatus).map(([k, v]) => (
              <BarRow key={k} label={STATUS_LABEL[k] || k} value={v} max={list.length} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">템플릿별</CardTitle>
            <CardDescription>어떤 양식이 가장 많이 쓰였나</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(byTemplate).map(([k, v]) => (
              <BarRow key={k} label={templateName(k)} value={v} max={list.length} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">부서별</CardTitle>
            <CardDescription>활동량</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(byWorkspace).map(([k, v]) => (
              <BarRow key={k} label={k} value={v} max={list.length} />
            ))}
          </CardContent>
        </Card>
      </div>
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

function BarRow({ label, value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <Badge variant="outline">{value}</Badge>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
