import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, FileCode2, Pencil, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { EmptyState } from '@/shared/components/EmptyState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { useAsync } from '@/shared/hooks/useAsync'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { deleteTemplate, listTemplates } from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { makeCategoryNameLookup } from '@/modules/reports/constants'
import { toast } from 'sonner'

export default function TemplatesPage() {
  const { me } = useAuth()
  const { slug } = useWorkspace()
  // Template lifecycle (create / publish / delete) is the manager role's
  // responsibility. Regular users can view templates but can't author them.
  const canManageTemplates = me?.role === 'manager'
  const canDeleteTemplates = canManageTemplates
  // Gate on `slug` so we don't fire the request before WorkspaceProvider
  // has set the X-Workspace-Slug header on the API client.
  const { data: templates, loading, error, reload } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug]
  )
  const { data: categories } = useAsync(() => listTemplateCategories(), [])
  const categoryName = makeCategoryNameLookup(categories)
  const [pendingDelete, setPendingDelete] = useState(null) // template object or null

  async function onConfirmDelete() {
    if (!pendingDelete) return
    try {
      const result = await deleteTemplate(pendingDelete.template_id)
      toast.success(`${pendingDelete.name} 삭제됨 (버전 ${result.deleted_versions}개)`)
      setPendingDelete(null)
      reload()
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="템플릿 관리"
        description="JSON Schema 2020-12 기반 보고서 양식. 글로벌 + 부서 트리 종속 혼합 가시성."
        actions={
          canManageTemplates && (
            <Button asChild>
              <Link to="/templates/new">
                <Plus className="mr-2 h-4 w-4" />
                신규 템플릿
              </Link>
            </Button>
          )
        }
      />

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : !templates || templates.length === 0 ? (
        <EmptyState
          title="템플릿이 없습니다"
          description={
            canManageTemplates
              ? '신규 템플릿 버튼을 눌러 첫 양식을 만드세요.'
              : '관리자/매니저가 템플릿을 추가하면 여기에 표시됩니다.'
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((t) => (
            <TemplateCard
              key={`${t.template_id}-${t.version}`}
              template={t}
              canManage={canManageTemplates}
              canDelete={canDeleteTemplates}
              onDelete={() => setPendingDelete(t)}
              categoryName={categoryName}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="템플릿 삭제"
        description={
          pendingDelete
            ? `'${pendingDelete.name}' 템플릿의 모든 버전을 삭제합니다. 이 템플릿을 참조하는 보고서가 있으면 거부됩니다. 되돌릴 수 없습니다.`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

function TemplateCard({ template, canManage, canDelete, onDelete, categoryName }) {
  const blocks = Array.isArray(template.schema?.blocks) ? template.schema.blocks : []
  const blockSummaries = blocks
    .map((b) => labelForBlock(b))
    .filter(Boolean)
    .slice(0, 6)
  const overflow = Math.max(0, blocks.length - blockSummaries.length)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <CardTitle className="text-base truncate">{template.name}</CardTitle>
          </div>
          <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
            <Badge variant="outline">v{template.version}</Badge>
            {(!template.owner_workspace_slugs || template.owner_workspace_slugs.length === 0) ? (
              <Badge variant="secondary" className="text-[10px]">전사</Badge>
            ) : (
              template.owner_workspace_slugs.map((s) => (
                <Badge key={s} variant="secondary" className="text-[10px]">
                  {s}
                </Badge>
              ))
            )}
          </div>
        </div>
        <CardDescription>
          {template.description}
          <span className="ml-2 text-[10px] text-muted-foreground">
            · {categoryName(template.category)}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          블록 {blocks.length}개
        </div>
        <ul className="text-sm space-y-1">
          {blockSummaries.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="h-1 w-1 rounded-full bg-muted-foreground" />
              <span className="truncate">{s}</span>
            </li>
          ))}
          {overflow > 0 && (
            <li className="text-[11px] text-muted-foreground pl-3">
              … 외 {overflow}개
            </li>
          )}
        </ul>
        {(canManage || canDelete) && (
          <div className="mt-4 flex items-center gap-2">
            {canManage && (
              <Button asChild variant="outline" size="sm" className="flex-1">
                <Link to={`/templates/${template.template_id}/edit`}>
                  <Pencil className="mr-1 h-3 w-3" />
                  편집 (새 버전 발행)
                </Link>
              </Button>
            )}
            {canDelete && (
              <Button
                variant="outline"
                size="sm"
                onClick={onDelete}
                className="text-destructive hover:text-destructive"
                title="템플릿 삭제"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function labelForBlock(b) {
  if (!b) return null
  // Most widgets carry a `label` prop; heading uses `text`. Fall back to id.
  return b.props?.label || b.props?.text || b.id
}
