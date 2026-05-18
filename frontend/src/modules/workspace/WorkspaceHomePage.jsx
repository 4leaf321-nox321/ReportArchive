import { Link } from 'react-router-dom'
import { FileText, Plus } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from '@/modules/reports/api'
import { listTemplates } from '@/shared/api/templates'
import { STATUS_LABEL, STATUS_VARIANT } from '@/modules/reports/constants'

export default function WorkspaceHomePage() {
  const { workspace, slug } = useWorkspace()
  const { data: reports, loading, error, reload } = useAsync(
    () => (slug ? listReports() : Promise.resolve([])),
    [slug]
  )
  // Fetch templates so we can show names instead of UUID-style ids.
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug]
  )
  const templateName = makeTemplateNameLookup(templates)

  if (!workspace || loading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
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

  const list = reports ?? []
  const recent = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)

  // Status-based KPIs (검토 중 / 승인 완료) used to live here but there is
  // no workflow that ever transitions a report off `draft` — no submit /
  // approve UI, no API for it — so those tiles always read 0. Removed
  // until a real review process exists; the status enum on the model is
  // kept so adding the workflow later is non-destructive.

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={`${workspace.name}`}
        description={
          [workspace.description, `보고서 ${list.length}건`]
            .filter(Boolean)
            .join(' · ')
        }
        actions={
          !workspace.virtual && (
            <Button asChild>
              <Link to={`/w/${slug}/reports/new`}>
                <Plus className="mr-2 h-4 w-4" />
                보고서 작성
              </Link>
            </Button>
          )
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">최근 보고서</CardTitle>
          <CardDescription>최근 업데이트 순 5건</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {recent.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground text-center">
              아직 보고서가 없습니다.
            </div>
          ) : (
            recent.map((r) => (
              <Link
                key={r.id}
                to={`/w/${slug}/reports/${r.id}`}
                className="flex items-center gap-3 py-3 hover:bg-muted/40 -mx-6 px-6"
              >
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{r.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {templateName(r.template_id)} v{r.template_version} · {r.workspace_slug} · {r.report_date ?? '—'}
                  </div>
                </div>
                <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Build a (template_id → display name) lookup from the API list. Falls back
 * to the id itself when the template can't be found (deleted / not yet
 * loaded), but trims long UUIDs so the row doesn't blow up.
 */
function makeTemplateNameLookup(templates) {
  const map = new Map((templates ?? []).map((t) => [t.template_id, t.name]))
  return (id) => {
    if (!id) return ''
    const name = map.get(id)
    if (name) return name
    // Looks like a UUID? show a compact prefix.
    if (id.length > 16) return `${id.slice(0, 8)}…`
    return id
  }
}
