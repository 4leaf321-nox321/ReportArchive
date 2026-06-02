import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, FileCode2, Pencil, Trash2, Sparkles, Search } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
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
import { listPresets, deletePreset } from '@/shared/api/presets'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { makeCategoryNameLookup } from '@/modules/reports/constants'
import { cn } from '@/shared/lib/utils'
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
    [slug],
  )
  const { data: categories } = useAsync(() => listTemplateCategories(), [])
  const categoryName = makeCategoryNameLookup(categories)

  // 프리셋(프리셋) — 템플릿에 종속되므로 같은 화면에서 관리. template_id
  // 로 그룹핑해 선택한 템플릿의 프리셋만 우측에 보여준다.
  const { data: presets, reload: reloadPresets } = useAsync(
    () => (slug ? listPresets() : Promise.resolve([])),
    [slug],
  )
  const presetsByTemplate = useMemo(() => {
    const map = new Map()
    for (const p of presets ?? []) {
      if (!map.has(p.template_id)) map.set(p.template_id, [])
      map.get(p.template_id).push(p)
    }
    return map
  }, [presets])

  const [pendingDelete, setPendingDelete] = useState(null) // template or null
  const [pendingPresetDelete, setPendingPresetDelete] = useState(null)
  const [selectedId, setSelectedId] = useState(null) // template_id
  const [query, setQuery] = useState('')

  const list = useMemo(() => templates ?? [], [templates])
  const trimmed = query.trim().toLowerCase()
  const filteredTemplates = trimmed
    ? list.filter(
        (t) =>
          t.name.toLowerCase().includes(trimmed) ||
          (t.description || '').toLowerCase().includes(trimmed) ||
          t.template_id.toLowerCase().includes(trimmed),
      )
    : list

  // 선택 유지: 목록이 로드되면 첫 항목을 선택하고, 선택한 템플릿이 사라지면
  // (삭제 등) 첫 항목으로 되돌린다.
  useEffect(() => {
    if (list.length === 0) {
      setSelectedId(null)
      return
    }
    if (!list.some((t) => t.template_id === selectedId)) {
      setSelectedId(list[0].template_id)
    }
  }, [list, selectedId])

  const selected = list.find((t) => t.template_id === selectedId) ?? null
  const selectedPresets = selected
    ? presetsByTemplate.get(selected.template_id) ?? []
    : []

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

  async function onConfirmPresetDelete() {
    if (!pendingPresetDelete) return
    try {
      await deletePreset(pendingPresetDelete.id)
      toast.success(`'${pendingPresetDelete.name}' 프리셋 삭제됨`)
      setPendingPresetDelete(null)
      reloadPresets()
    } catch (err) {
      toast.error(err.message || '프리셋 삭제 실패')
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
        <div className="flex gap-6">
          <Skeleton className="h-96 w-72 shrink-0" />
          <Skeleton className="h-96 flex-1" />
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="템플릿이 없습니다"
          description={
            canManageTemplates
              ? '신규 템플릿 버튼을 눌러 첫 양식을 만드세요.'
              : '관리자/매니저가 템플릿을 추가하면 여기에 표시됩니다.'
          }
        />
      ) : (
        <div className="flex items-start gap-6">
          {/* ── 좌측: 템플릿 목록 (sticky) ── */}
          <aside className="sticky top-6 w-72 shrink-0 self-start">
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="템플릿 검색"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <ul className="max-h-[calc(100vh-200px)] space-y-1 overflow-y-auto pr-1">
              {filteredTemplates.length === 0 ? (
                <li className="px-2 py-3 text-xs text-muted-foreground">
                  검색 결과가 없습니다.
                </li>
              ) : (
                filteredTemplates.map((t) => (
                  <li key={t.template_id}>
                    <TemplateListItem
                      template={t}
                      active={t.template_id === selectedId}
                      presetCount={(presetsByTemplate.get(t.template_id) ?? []).length}
                      onClick={() => setSelectedId(t.template_id)}
                    />
                  </li>
                ))
              )}
            </ul>
          </aside>

          {/* ── 우측: 선택한 템플릿 상세 + 프리셋 ── */}
          <section className="min-w-0 flex-1">
            {selected ? (
              <TemplateDetail
                template={selected}
                categoryName={categoryName}
                canManage={canManageTemplates}
                canDelete={canDeleteTemplates}
                onDelete={() => setPendingDelete(selected)}
                presets={selectedPresets}
                currentUserId={me?.user?.id}
                isAdmin={me?.is_system_admin === true}
                onDeletePreset={(p) => setPendingPresetDelete(p)}
              />
            ) : (
              <div className="py-12 text-center text-sm text-muted-foreground">
                왼쪽에서 템플릿을 선택하세요.
              </div>
            )}
          </section>
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

      <ConfirmDialog
        open={!!pendingPresetDelete}
        onOpenChange={(open) => !open && setPendingPresetDelete(null)}
        title="프리셋 삭제"
        description={
          pendingPresetDelete
            ? `'${pendingPresetDelete.name}' 프리셋을 삭제합니다. 이 프리셋으로 이미 만든 보고서에는 영향이 없습니다. 되돌릴 수 없습니다.`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={onConfirmPresetDelete}
      />
    </div>
  )
}

function TemplateListItem({ template, active, presetCount, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors',
        active ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
      )}
    >
      <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{template.name}</span>
        <span className="block text-[10px] text-muted-foreground">
          v{template.version}
        </span>
      </span>
      {presetCount > 0 && (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          <Sparkles className="h-2.5 w-2.5" />
          {presetCount}
        </span>
      )}
    </button>
  )
}

function TemplateDetail({
  template,
  categoryName,
  canManage,
  canDelete,
  onDelete,
  presets,
  currentUserId,
  isAdmin,
  onDeletePreset,
}) {
  const blocks = Array.isArray(template.schema?.blocks) ? template.schema.blocks : []
  const scoped =
    Array.isArray(template.owner_workspace_slugs) &&
    template.owner_workspace_slugs.length > 0

  const [q, setQ] = useState('')
  useEffect(() => {
    setQ('')
  }, [template.template_id])
  const trimmed = q.trim().toLowerCase()
  const filteredPresets = trimmed
    ? presets.filter(
        (p) =>
          p.name.toLowerCase().includes(trimmed) ||
          (p.description || '').toLowerCase().includes(trimmed),
      )
    : presets

  return (
    <div className="space-y-6">
      {/* ── 기본 정보 ── */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <FileCode2 className="h-5 w-5 shrink-0 text-muted-foreground" />
              <h2 className="text-lg font-semibold">{template.name}</h2>
              <Badge variant="outline">v{template.version}</Badge>
              {scoped ? (
                template.owner_workspace_slugs.map((s) => (
                  <Badge key={s} variant="secondary" className="text-[10px]">
                    {s}
                  </Badge>
                ))
              ) : (
                <Badge variant="secondary" className="text-[10px]">전사</Badge>
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {categoryName(template.category)} · {template.template_id}
            </p>
            {template.description && (
              <p className="mt-2 text-sm text-muted-foreground">
                {template.description}
              </p>
            )}
          </div>
          {(canManage || canDelete) && (
            <div className="flex shrink-0 gap-2">
              {canManage && (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/templates/${template.template_id}/edit`}>
                    <Pencil className="mr-1 h-3 w-3" />
                    편집
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
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── 구성 블록 ── */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          구성 블록 {blocks.length}개
        </div>
        {blocks.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">정의된 블록이 없습니다.</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {blocks.map((b, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                <span className="truncate">{labelForBlock(b)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── 프리셋 ── */}
      <div className="border-t pt-4">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-primary" />
          프리셋 {presets.length}개
        </div>
        {presets.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            아직 이 템플릿의 프리셋이 없습니다. 보고서를 만든 뒤 “프리셋으로
            저장”으로 추가할 수 있습니다.
          </p>
        ) : (
          <div className="space-y-2">
            {presets.length > 8 && (
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="프리셋 이름·설명 검색"
                className="h-8 text-sm"
              />
            )}
            <ul className="space-y-1">
              {filteredPresets.length === 0 ? (
                <li className="py-4 text-center text-sm text-muted-foreground">
                  검색 결과가 없습니다.
                </li>
              ) : (
                filteredPresets.map((p) => {
                  const canDel =
                    isAdmin ||
                    (currentUserId && p.created_by_user_id === currentUserId)
                  return (
                    <li
                      key={p.id}
                      className="flex items-start gap-2 rounded-md border px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <Sparkles className="h-3 w-3 shrink-0 text-primary" />
                          <span className="truncate">{p.name}</span>
                          {(p.owner_workspace_slugs ?? []).length === 0 && (
                            <Badge variant="secondary" className="text-[9px]">
                              전사
                            </Badge>
                          )}
                        </div>
                        {p.description && (
                          <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                            {p.description}
                          </p>
                        )}
                        {p.created_by_name && (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            만든 사람: {p.created_by_name}
                          </p>
                        )}
                      </div>
                      {canDel && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => onDeletePreset(p)}
                          title="이 프리셋 삭제"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function labelForBlock(b) {
  if (!b) return null
  // Most widgets carry a `label` prop; heading uses `text`. Fall back to id.
  return b.props?.label || b.props?.text || b.id
}
