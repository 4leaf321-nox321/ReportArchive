import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus,
  FileCode2,
  Pencil,
  Trash2,
  Sparkles,
  Search,
  Share2,
  Building2,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Layers,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import {
  ScopeCategorySidebar,
  useScopeCategories,
} from '@/shared/components/ScopeCategories'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Badge } from '@/shared/components/ui/badge'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { EmptyState } from '@/shared/components/EmptyState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { useAsync } from '@/shared/hooks/useAsync'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { deleteTemplate, listTemplates, setTemplateScope } from '@/shared/api/templates'
import { listPresets, deletePreset } from '@/shared/api/presets'
import {
  listCompositePresets,
  updateCompositePreset,
  deleteCompositePreset,
} from '@/shared/api/compositePresets'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { makeCategoryNameLookup } from '@/modules/reports/constants'
import { cn } from '@/shared/lib/utils'
import { toast } from 'sonner'

export default function TemplatesPage() {
  const { me } = useAuth()
  const { slug, all: workspaces } = useWorkspace()
  const orgWorkspaces = useMemo(
    () => (workspaces ?? []).filter((w) => w.kind === 'org' && !w.virtual),
    [workspaces],
  )
  const workspaceName = (s) =>
    (workspaces ?? []).find((w) => w.slug === s)?.name ?? s
  // 매니저: 보이는 템플릿 전반을 관리. 일반 멤버: *자기 부서* 템플릿만
  // 생성/수정/삭제(전사공개·타부서·공유 범위는 매니저 영역).
  const role = me?.role
  const isManager = role === 'manager'
  const currentWs = (workspaces ?? []).find((w) => w.slug === slug)
  const currentIsOrgDept = currentWs?.kind === 'org' && !currentWs?.virtual
  // 신규 생성 가능: 매니저, 또는 현재 조직 부서를 보고 있는 일반 멤버.
  const canCreateTemplates = isManager || (role === 'user' && currentIsOrgDept)
  // 특정 템플릿 수정/삭제: 매니저(보이는 것 전부), 본인 개인(비공개) 템플릿,
  // 또는 멤버(자기 부서 소유). 백엔드 _assert_can_manage_template 와 일치시킨다.
  const myPersonalSlug = me?.user?.id ? `personal-${me.user.id}` : null
  const isMyPrivateTemplate = (t) =>
    Boolean(myPersonalSlug) &&
    Array.isArray(t?.owner_workspace_slugs) &&
    t.owner_workspace_slugs.length === 1 &&
    t.owner_workspace_slugs[0] === myPersonalSlug
  const isSysAdmin = me?.is_system_admin === true
  const canManageTemplate = (t) =>
    isSysAdmin ||
    isManager ||
    isMyPrivateTemplate(t) ||
    (role === 'user' &&
      Array.isArray(t?.owner_workspace_slugs) &&
      t.owner_workspace_slugs.includes(slug))
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
  const [scopeEditFor, setScopeEditFor] = useState(null) // 공유 부서 편집 대상
  const [selectedId, setSelectedId] = useState(null) // template_id
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('templates') // 'templates' | 'composite-presets'

  const list = useMemo(() => templates ?? [], [templates])
  // 전사/조직별/개인 분류 — 종합보고 양식 picker 와 같은 방식(공용 훅).
  const tplCat = useScopeCategories(list, {
    currentUserId: me?.user?.id,
    getName: workspaceName,
  })
  const byCat = list.filter(tplCat.filter)
  const trimmed = query.trim().toLowerCase()
  const filteredTemplates = trimmed
    ? byCat.filter(
        (t) =>
          t.name.toLowerCase().includes(trimmed) ||
          (t.description || '').toLowerCase().includes(trimmed) ||
          t.template_id.toLowerCase().includes(trimmed),
      )
    : byCat

  // 선택 유지: 현재 분류에서 첫 항목을 선택하고, 선택한 템플릿이 분류 밖으로
  // 벗어나거나(분류 전환·삭제) 사라지면 분류의 첫 항목으로 되돌린다. 검색은
  // 선택을 리셋하지 않도록 분류(byCat) 기준으로만 본다.
  useEffect(() => {
    const visible = list.filter(tplCat.filter)
    if (visible.length === 0) {
      setSelectedId(null)
      return
    }
    if (!visible.some((t) => t.template_id === selectedId)) {
      setSelectedId(visible[0].template_id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, tplCat.cat, selectedId])

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
        description="JSON Schema 2020-12 기반 보고서 양식 + 종합보고 양식. 글로벌 + 부서 트리 종속 혼합 가시성."
        actions={
          tab === 'templates' &&
          canCreateTemplates && (
            <Button asChild>
              <Link to="/templates/new">
                <Plus className="mr-2 h-4 w-4" />
                신규 템플릿
              </Link>
            </Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="templates">
            <FileCode2 className="mr-1.5 h-3.5 w-3.5" />
            보고서 템플릿
          </TabsTrigger>
          <TabsTrigger value="composite-presets">
            <Layers className="mr-1.5 h-3.5 w-3.5" />
            종합보고 양식
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="mt-4">
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
                canCreateTemplates
                  ? '신규 템플릿 버튼을 눌러 첫 양식을 만드세요.'
                  : '매니저 또는 부서 멤버가 템플릿을 추가하면 여기에 표시됩니다.'
              }
            />
          ) : (
            <div className="flex items-start gap-5">
              {/* ── 분류 사이드바(공용) — 전사/조직별/개인 ── */}
              <ScopeCategorySidebar
                counts={tplCat.counts}
                orgGroups={tplCat.orgGroups}
                cat={tplCat.cat}
                onChange={tplCat.setCat}
                mineLabel="개인 (내 템플릿)"
                emptyOrgText="조직 템플릿이 없습니다."
                // 시스템 관리자에게만 모든 사용자의 개인(비공개) 템플릿을
                // 한 칸으로 묶어 노출(일반 사용자는 자기 것뿐이라 숨김).
                showPrivate={isSysAdmin}
                className="sticky top-6 w-44 shrink-0 self-start border-r pr-2"
              />
              {/* ── 좌측: 템플릿 목록 (sticky) ── */}
              <aside className="sticky top-6 w-64 shrink-0 self-start">
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
                      {trimmed ? '검색 결과가 없습니다.' : '이 분류에 템플릿이 없습니다.'}
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
                    workspaceName={workspaceName}
                    canManage={canManageTemplate(selected)}
                    canDelete={canManageTemplate(selected)}
                    canEditScope={isManager}
                    onDelete={() => setPendingDelete(selected)}
                    onEditScope={() => setScopeEditFor(selected)}
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
        </TabsContent>

        <TabsContent value="composite-presets" className="mt-4">
          <CompositePresetsPanel
            orgOptions={orgWorkspaces}
            workspaceName={workspaceName}
            isManager={isManager}
            isAdmin={me?.is_system_admin === true}
            currentUserId={me?.user?.id}
          />
        </TabsContent>
      </Tabs>

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

      <TemplateScopeDialog
        template={scopeEditFor}
        orgWorkspaces={orgWorkspaces}
        onClose={() => setScopeEditFor(null)}
        onSaved={() => reload()}
      />
    </div>
  )
}

/** 종합보고 양식 관리 탭 — 보고서 템플릿과 달리 종합보고 양식은 템플릿에
 *  묶이지 않으므로 좌우 패널이 아닌 단일 목록으로 관리한다. 메타정보(이름·
 *  설명·공개범위)와 그룹 골격을 편집 다이얼로그에서 수정. 권한: 만든 사람 ·
 *  매니저 · 시스템관리자. */
function CompositePresetsPanel({
  orgOptions,
  workspaceName,
  isManager,
  isAdmin,
  currentUserId,
}) {
  const { data: presets, loading, error, reload } = useAsync(
    () => listCompositePresets(),
    [],
  )
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null) // preset or null
  const [pendingDelete, setPendingDelete] = useState(null)

  const canManage = (p) =>
    isManager || isAdmin || (currentUserId && p.created_by_user_id === currentUserId)

  const rows = useMemo(() => presets ?? [], [presets])
  // 전사/조직별/개인 분류 — 보고서 템플릿 탭·picker 와 같은 방식(공용 훅).
  const { cat, setCat, counts, orgGroups, filter } = useScopeCategories(rows, {
    currentUserId,
    getName: workspaceName,
  })
  const byCat = rows.filter(filter)
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? byCat.filter(
        (p) =>
          p.name.toLowerCase().includes(trimmed) ||
          (p.description || '').toLowerCase().includes(trimmed) ||
          (p.groups ?? []).some((g) => g.toLowerCase().includes(trimmed)),
      )
    : byCat

  async function onConfirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteCompositePreset(pendingDelete.id)
      toast.success(`'${pendingDelete.name}' 양식 삭제됨`)
      setPendingDelete(null)
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '양식 삭제 실패')
    }
  }

  if (error) {
    return <ErrorState description={error.message} onRetry={reload} />
  }
  if (loading) {
    return <Skeleton className="h-72" />
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="종합보고 양식이 없습니다"
        description="종합보고 상세에서 '양식으로 저장'을 누르면 여기에 표시됩니다."
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Layers className="h-4 w-4 text-primary" />
          종합보고 양식 {rows.length}개
        </div>
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="양식 이름·설명·그룹 검색"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>
      <div className="flex items-start gap-5">
        {/* ── 분류 사이드바(공용) — 전사/조직별/개인 ── */}
        <ScopeCategorySidebar
          counts={counts}
          orgGroups={orgGroups}
          cat={cat}
          onChange={setCat}
          mineLabel="개인 (내 양식)"
          emptyOrgText="조직 양식이 없습니다."
          showPrivate={isAdmin}
          className="sticky top-6 w-44 shrink-0 self-start border-r pr-2"
        />
        <div className="min-w-0 flex-1">
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {trimmed ? '검색 결과가 없습니다.' : '이 분류에 양식이 없습니다.'}
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((p) => {
                const isGlobal = (p.owner_workspace_slugs ?? []).length === 0
                const manage = canManage(p)
                return (
                  <li
                    key={p.id}
                    className="flex items-start gap-2 rounded-md border px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="truncate">{p.name}</span>
                        {isGlobal ? (
                          <Badge variant="secondary" className="text-[9px]">
                            전사
                          </Badge>
                        ) : (
                          (p.owner_workspace_slugs ?? []).map((s) => (
                            <Badge key={s} variant="outline" className="text-[9px]">
                              {workspaceName ? workspaceName(s) : s}
                            </Badge>
                          ))
                        )}
                      </div>
                      {p.description && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                          {p.description}
                        </p>
                      )}
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        요약 {p.summary_widget_count ?? 0}개 · 그룹{' '}
                        {(p.groups ?? []).length}개
                        {(p.groups ?? []).length > 0 &&
                          ` (${p.groups.slice(0, 4).join(', ')}${
                            p.groups.length > 4 ? ' …' : ''
                          })`}
                      </p>
                      {p.created_by_name && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          만든 사람: {p.created_by_name}
                        </p>
                      )}
                    </div>
                    {manage && (
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => setEditing(p)}
                          title="양식 정보 수정"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setPendingDelete(p)}
                          title="양식 삭제"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      <CompositePresetEditDialog
        preset={editing}
        orgOptions={orgOptions}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          reload()
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="종합보고 양식 삭제"
        description={
          pendingDelete
            ? `'${pendingDelete.name}' 양식을 삭제합니다. 이 양식으로 이미 만든 종합보고에는 영향이 없습니다. 되돌릴 수 없습니다.`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

/** 종합보고 양식 메타정보 + 그룹 골격 편집. 요약 위젯·보기설정은 여기서
 *  못 고친다(종합보고 에디터에서 다시 저장). 공개범위는 전사 또는 특정 조직
 *  하나(생성 다이얼로그와 동일 단일 선택). */
function CompositePresetEditDialog({ preset, orgOptions, onClose, onSaved }) {
  const open = Boolean(preset)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState('') // '' = 전사
  const [groups, setGroups] = useState([]) // [{ id, name }]
  const [submitting, setSubmitting] = useState(false)
  const nextId = useRef(0)

  useEffect(() => {
    if (!preset) return
    setName(preset.name ?? '')
    setDescription(preset.description ?? '')
    setScope((preset.owner_workspace_slugs ?? [])[0] ?? '')
    nextId.current = 0
    setGroups(
      (preset.groups ?? []).map((g) => ({ id: nextId.current++, name: g })),
    )
    setSubmitting(false)
  }, [preset])

  function setGroupName(id, value) {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, name: value } : g)))
  }
  function removeGroup(id) {
    setGroups((prev) => prev.filter((g) => g.id !== id))
  }
  function addGroup() {
    setGroups((prev) => [...prev, { id: nextId.current++, name: '' }])
  }
  function moveGroup(idx, dir) {
    setGroups((prev) => {
      const j = idx + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    // 빈 그룹·중복 제거(순서 유지) — 백엔드도 정규화하지만 미리 다듬는다.
    const seen = new Set()
    const cleanGroups = []
    for (const g of groups) {
      const t = (g.name || '').trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        cleanGroups.push(t)
      }
    }
    setSubmitting(true)
    try {
      await updateCompositePreset(preset.id, {
        name: trimmedName,
        description: description.trim(),
        owner_workspace_slugs: scope ? [scope] : null,
        groups: cleanGroups,
      })
      toast.success('양식이 수정되었습니다.')
      onSaved?.()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '양식 수정 실패')
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>양식 정보 수정</DialogTitle>
          <DialogDescription>
            이름·설명·공개범위와 그룹 골격을 수정합니다. 요약 위젯과 보기 설정은
            종합보고에서 다시 “양식으로 저장”해야 반영됩니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-1.5">
              <label htmlFor="cp-edit-name" className="text-sm font-medium">
                양식 이름
              </label>
              <Input
                id="cp-edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="cp-edit-desc" className="text-sm font-medium">
                설명 (선택)
              </label>
              <Textarea
                id="cp-edit-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="resize-none text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="cp-edit-scope" className="text-sm font-medium">
                공개 범위
              </label>
              <select
                id="cp-edit-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">전사 공개 (모든 조직)</option>
                {(orgOptions ?? []).map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">그룹 골격</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={addGroup}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  그룹 추가
                </Button>
              </div>
              {groups.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  그룹이 없습니다. “그룹 추가”로 골격을 만드세요.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {groups.map((g, idx) => (
                    <li key={g.id} className="flex items-center gap-1.5">
                      <Input
                        value={g.name}
                        onChange={(e) => setGroupName(g.id, e.target.value)}
                        placeholder="그룹 이름"
                        className="h-8 text-sm"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => moveGroup(idx, -1)}
                        disabled={idx === 0}
                        title="위로"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => moveGroup(idx, 1)}
                        disabled={idx === groups.length - 1}
                        title="아래로"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeGroup(g.id)}
                        title="삭제"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted-foreground">
                새 종합보고를 이 양식으로 시작하면 이 그룹들이 빈 골격으로
                채워집니다.
              </p>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              취소
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? '저장 중...' : '저장'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  workspaceName,
  canManage,
  canDelete,
  canEditScope,
  onDelete,
  onEditScope,
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

      {/* ── 공유 부서 ── */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            공유 부서
          </div>
          {canEditScope && scoped && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onEditScope}
            >
              <Share2 className="mr-1 h-3 w-3" />
              편집
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {scoped ? (
            template.owner_workspace_slugs.map((s) => (
              <Badge key={s} variant="secondary">
                {workspaceName ? workspaceName(s) : s}
              </Badge>
            ))
          ) : (
            <Badge variant="secondary">전사 공개 (모든 부서)</Badge>
          )}
        </div>
        {!scoped && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            전사 공개 템플릿의 공유 범위는 시스템 관리자만 바꿀 수 있습니다.
          </p>
        )}
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

/** 공유 부서 선택 — "조직 게시판에 게시" 다이얼로그(MountDialog)와 같은
 *  트리+검색 패턴. 조직 워크스페이스를 부모-자식 트리로 펼쳐 체크. 부서가
 *  많아도 펼침/검색으로 다룬다. 하나도 안 고르면 전사 공개. 현재 소유 중인데
 *  트리에 없는(내가 못 보는) 부서는 selected 에 보존돼 저장 시 유지된다. */
function TemplateScopeDialog({ template, orgWorkspaces, onClose, onSaved }) {
  const open = Boolean(template)
  const [selected, setSelected] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set())
  const [query, setQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 조직 워크스페이스를 부모-자식 트리로. 부모가 org 집합 안에 없으면 root.
  const { roots, childrenOf, bySlug } = useMemo(() => {
    const orgs = orgWorkspaces ?? []
    const orgSet = new Set(orgs.map((w) => w.slug))
    const bySlug = new Map(orgs.map((w) => [w.slug, w]))
    const childrenOf = new Map()
    const roots = []
    const byName = (a, b) => a.name.localeCompare(b.name)
    for (const w of [...orgs].sort(byName)) {
      if (w.parent_slug && orgSet.has(w.parent_slug)) {
        if (!childrenOf.has(w.parent_slug)) childrenOf.set(w.parent_slug, [])
        childrenOf.get(w.parent_slug).push(w)
      } else {
        roots.push(w)
      }
    }
    return { roots, childrenOf, bySlug }
  }, [orgWorkspaces])

  function ancestorsOf(slug) {
    const out = []
    let cur = bySlug.get(slug)
    while (cur?.parent_slug && bySlug.has(cur.parent_slug)) {
      out.push(cur.parent_slug)
      cur = bySlug.get(cur.parent_slug)
    }
    return out
  }
  function pathLabel(slug) {
    return ancestorsOf(slug)
      .reverse()
      .map((s) => bySlug.get(s)?.name ?? s)
      .join(' / ')
  }

  useEffect(() => {
    if (!open) return
    const init = new Set(template.owner_workspace_slugs ?? [])
    setSelected(init)
    setQuery('')
    setSubmitting(false)
    // 이미 공유 중인 부서의 조상들을 펼쳐 바로 보이게.
    const exp = new Set()
    for (const s of init) for (const a of ancestorsOf(s)) exp.add(a)
    setExpanded(exp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template])

  function toggleSelect(slug) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }
  function toggleExpand(slug) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  const trimmed = query.trim().toLowerCase()
  const searching = trimmed.length > 0
  const searchResults = (orgWorkspaces ?? [])
    .filter(
      (w) =>
        w.name.toLowerCase().includes(trimmed) ||
        w.slug.toLowerCase().includes(trimmed),
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  function renderNode(w, depth) {
    const kids = childrenOf.get(w.slug) ?? []
    return (
      <Fragment key={w.slug}>
        <ShareRow
          ws={w}
          depth={depth}
          hasChildren={kids.length > 0}
          isExpanded={expanded.has(w.slug)}
          checked={selected.has(w.slug)}
          onToggleSelect={() => toggleSelect(w.slug)}
          onToggleExpand={kids.length > 0 ? () => toggleExpand(w.slug) : null}
        />
        {kids.length > 0 &&
          expanded.has(w.slug) &&
          kids.map((k) => renderNode(k, depth + 1))}
      </Fragment>
    )
  }

  async function handleSave() {
    setSubmitting(true)
    try {
      const slugs = [...selected]
      await setTemplateScope(template.template_id, slugs.length ? slugs : null)
      toast.success('공유 부서가 변경되었습니다.')
      onSaved?.()
      onClose()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '공유 부서 변경 실패',
      )
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-[90vw] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>공유 부서 추가 — {template?.name}</DialogTitle>
          <DialogDescription>
            체크한 부서(그 트리)에서 이 템플릿이 보입니다. 같은 원본을 공유하므로
            편집은 모든 소유 부서에 반영됩니다.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="조직명 / slug 검색 (비우면 트리 보기)"
            className="h-8 pl-8 text-sm"
          />
        </div>

        <div className="-mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
          {searching ? (
            searchResults.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                매칭되는 조직이 없습니다.
              </p>
            ) : (
              searchResults.map((w) => (
                <ShareRow
                  key={w.slug}
                  ws={w}
                  depth={0}
                  hasChildren={false}
                  isExpanded={false}
                  onToggleExpand={null}
                  pathLabel={pathLabel(w.slug)}
                  checked={selected.has(w.slug)}
                  onToggleSelect={() => toggleSelect(w.slug)}
                />
              ))
            )
          ) : roots.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              부서가 없습니다.
            </p>
          ) : (
            roots.map((w) => renderNode(w, 0))
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-[11px] text-muted-foreground">
            {selected.size === 0
              ? '⚠ 아무 부서도 안 고르면 전사 공개로 전환됩니다'
              : `${selected.size}개 부서 공유`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              취소
            </Button>
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting ? '저장 중…' : '저장'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 공유 부서 트리/검색 한 줄 — chevron(자식 펼침) + 체크박스 + 조직명. */
function ShareRow({
  ws,
  depth,
  isExpanded,
  checked,
  onToggleSelect,
  onToggleExpand,
  pathLabel,
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-muted/40"
      style={{ marginLeft: depth * 16 }}
    >
      {onToggleExpand ? (
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
          aria-label={isExpanded ? '접기' : '펼치기'}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" aria-hidden />
      )}
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggleSelect}
          className="h-4 w-4 shrink-0"
        />
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: ws.color || '#64748b' }}
        />
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{ws.name}</span>
          {pathLabel && (
            <span className="block truncate text-[10px] text-muted-foreground">
              {pathLabel}
            </span>
          )}
        </span>
      </label>
    </div>
  )
}
