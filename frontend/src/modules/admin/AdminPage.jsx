import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus,
  Trash2,
  Pencil,
  Tags,
  Building2,
  Save,
  X,
  ChevronUp,
  ChevronDown,
  Move,
  Workflow,
  Bookmark,
  ShieldCheck,
  ShieldQuestion,
  FileType2,
  CheckCircle2,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ColorPicker } from '@/shared/components/ColorPicker'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  listTemplateCategories,
  createTemplateCategory,
  updateTemplateCategory,
  deleteTemplateCategory,
} from '@/shared/api/templateCategories'
import {
  listWorkspaces,
  createWorkspace,
  bulkCreateWorkspaces,
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceDependents,
} from '@/shared/api/workspaces'
import {
  listWidgetRelations,
  createWidgetRelation,
  updateWidgetRelation,
  deleteWidgetRelation,
} from '@/shared/api/widgetRelations'
import { invalidateWidgetRelationsCache } from '@/shared/hooks/useWidgetRelations'
import {
  listSectionCategories,
  createSectionCategory,
  updateSectionCategory,
  deleteSectionCategory,
  createSectionItem,
  updateSectionItem,
  deleteSectionItem,
} from '@/shared/api/sectionTaxonomy'
import { invalidateSectionTaxonomyCache } from '@/shared/hooks/useSectionTaxonomy'
import {
  listAllReportTypes,
  createReportType,
  updateReportType,
  promoteReportType,
  demoteReportType,
  deleteReportType,
} from '@/shared/api/reportTypes'
import { WorkspaceTreeDnD } from './WorkspaceTreeDnD'
import {
  listMembers,
  addMember,
  removeMember,
  searchUsers,
} from '@/shared/api/members'
import {
  listSystemAdmins,
  setSystemAdmin,
} from '@/shared/api/systemAdmins'
import { UserPlus, X as XIcon, Loader2 } from 'lucide-react'

export default function AdminPage() {
  const { me } = useAuth()
  // 시스템 관리 페이지 — 부서 트리, 카테고리 등 org-wide masters.
  // 부서 관리자(workspace role)가 아니라 시스템 관리자(is_system_admin)만.
  const isAdmin = me?.is_system_admin === true

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="시스템 관리" description="기준정보 정의 (카테고리 / 부서)" />
        <ErrorState
          title="권한 없음"
          description="시스템 관리 페이지는 시스템 관리자만 접근 가능합니다."
          action={
            <Button asChild variant="outline">
              <Link to="/">홈으로</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <PageHeader
        title="시스템 관리"
        description="시스템 기준정보 — 부서 트리 / 템플릿 카테고리 / 관계 라벨 / 단락 구분. 부서 멤버는 '부서 멤버' 메뉴, 서버 상태는 '서버' 메뉴에서."
      />

      <SystemAdminsCard meUserId={me?.user?.id} />

      <Tabs defaultValue="workspaces" className="space-y-4">
        <TabsList>
          <TabsTrigger value="workspaces">
            <Building2 className="mr-1 h-3 w-3" />
            부서 트리
          </TabsTrigger>
          <TabsTrigger value="categories">
            <Tags className="mr-1 h-3 w-3" />
            템플릿 카테고리
          </TabsTrigger>
          <TabsTrigger value="relations">
            <Workflow className="mr-1 h-3 w-3" />
            관계 라벨
          </TabsTrigger>
          <TabsTrigger value="sections">
            <Bookmark className="mr-1 h-3 w-3" />
            단락 구분
          </TabsTrigger>
          <TabsTrigger value="report-types">
            <FileType2 className="mr-1 h-3 w-3" />
            보고서 종류
          </TabsTrigger>
        </TabsList>

        <TabsContent value="workspaces">
          <WorkspacesSection />
        </TabsContent>
        <TabsContent value="categories">
          <CategoriesSection />
        </TabsContent>
        <TabsContent value="relations">
          <RelationsSection />
        </TabsContent>
        <TabsContent value="sections">
          <SectionsSection />
        </TabsContent>
        <TabsContent value="report-types">
          <ReportTypesSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// =========================================================================
// 카테고리
// =========================================================================
function CategoriesSection() {
  const { data: categories, loading, error, reload } = useAsync(
    () => listTemplateCategories(),
    []
  )
  const [editingSlug, setEditingSlug] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [creating, setCreating] = useState(false)

  async function handleDelete(slug) {
    try {
      const data = await deleteTemplateCategory(slug)
      const orphan = data?.orphan_template_count ?? 0
      toast.success(
        orphan > 0
          ? `삭제됨. ${orphan}개 템플릿이 이 카테고리를 참조 중이었습니다.`
          : '카테고리가 삭제되었습니다.'
      )
      reload()
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Tags className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">템플릿 카테고리</CardTitle>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-3 w-3" />
            추가
          </Button>
        </div>
        <CardDescription>
          보고서 템플릿을 묶는 분류축. 슬러그는 templates.category에 그대로 저장되며 카테고리를
          삭제해도 기존 템플릿은 그 슬러그를 유지합니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32" />
        ) : error ? (
          <ErrorState description={error.message} onRetry={reload} />
        ) : (categories ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">카테고리가 없습니다.</p>
        ) : (
          <ul className="divide-y">
            {(categories ?? []).map((c) => (
              <CategoryRow
                key={c.slug}
                category={c}
                editing={editingSlug === c.slug}
                onStartEdit={() => setEditingSlug(c.slug)}
                onCancel={() => setEditingSlug(null)}
                onSaved={() => {
                  setEditingSlug(null)
                  reload()
                }}
                onDelete={() => setConfirmDelete(c)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <CategoryCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setCreating(false)
          reload()
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={() => setConfirmDelete(null)}
        title="카테고리 삭제"
        description={
          confirmDelete
            ? `'${confirmDelete.name}' (${confirmDelete.slug}) 카테고리를 삭제하시겠습니까?`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={() => confirmDelete && handleDelete(confirmDelete.slug)}
      />
    </Card>
  )
}

function CategoryRow({ category, editing, onStartEdit, onCancel, onSaved, onDelete }) {
  const [name, setName] = useState(category.name)
  const [sortOrder, setSortOrder] = useState(category.sort_order)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(category.name)
    setSortOrder(category.sort_order)
  }, [category])

  async function onSave() {
    setSaving(true)
    try {
      await updateTemplateCategory(category.slug, { name, sortOrder: Number(sortOrder) })
      toast.success('수정되었습니다.')
      onSaved()
    } catch (err) {
      toast.error(err.message || '수정 실패')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <li className="grid grid-cols-12 gap-2 items-center py-3">
        <Badge variant="outline" className="font-mono col-span-3 justify-center">
          {category.slug}
        </Badge>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="col-span-5 h-9"
          placeholder="이름"
        />
        <Input
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          className="col-span-2 h-9"
          placeholder="정렬"
        />
        <div className="col-span-2 flex justify-end gap-1">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onSave} disabled={saving}>
            <Save className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-3 py-3">
      <Badge variant="outline" className="font-mono">
        {category.slug}
      </Badge>
      <span className="flex-1 font-medium">{category.name}</span>
      <span className="text-xs text-muted-foreground">정렬: {category.sort_order}</span>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onStartEdit}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}

function CategoryCreateDialog({ open, onOpenChange, onCreated }) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [sortOrder, setSortOrder] = useState(50)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (!open) {
      setSlug('')
      setName('')
      setSortOrder(50)
      setErrorMsg(null)
    }
  }, [open])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    setSubmitting(true)
    try {
      await createTemplateCategory({ slug, name, sortOrder: Number(sortOrder) })
      toast.success('카테고리가 추가되었습니다.')
      onCreated()
    } catch (err) {
      setErrorMsg(err.message || '생성 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 카테고리</DialogTitle>
          <DialogDescription>슬러그는 발행 후 변경 불가합니다.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cat-slug">슬러그</Label>
            <Input
              id="cat-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="weekly-report"
              pattern="^[a-z0-9][a-z0-9\-]*$"
              required
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              영문 소문자/숫자/하이픈만. 예: <code>weekly-report</code>
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">이름</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="주간 보고"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-sort">정렬 순서</Label>
            <Input
              id="cat-sort"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '추가 중...' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// =========================================================================
// 부서 트리
// =========================================================================
function WorkspacesSection() {
  const { data: workspaces, loading, error, reload } = useAsync(() => listWorkspaces(), [])
  const [creating, setCreating] = useState(false)
  const [bulkCreating, setBulkCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [editing, setEditing] = useState(null)
  const [moving, setMoving] = useState(false)

  const list = workspaces ?? []
  // Personal workspaces (`kind='personal'`) are auto-managed per-user
  // scratch spaces — they share the `workspaces` table for FK reuse but
  // are never edited from this admin tree. Excluding them keeps the
  // tree usable when there are thousands of users.
  const real = list.filter((w) => !w.virtual && w.kind !== 'personal')
  const virtuals = list.filter((w) => w.virtual)

  async function handleDelete(slug) {
    try {
      await deleteWorkspace(slug)
      toast.success('부서가 삭제되었습니다.')
      setConfirmDelete(null)
      reload()
    } catch (err) {
      // Keep the modal open on failure so the user can see the error and
      // either retry or cancel.
      toast.error(err.message || '삭제 실패')
    }
  }

  /** Apply a multi-row update plan from the DnD tree. */
  async function handleMove(plan) {
    setMoving(true)
    try {
      await Promise.all(plan.map((u) => updateWorkspace(u.slug, u.payload)))
      reload()
    } catch (err) {
      toast.error(err.message || '이동 실패')
    } finally {
      setMoving(false)
    }
  }

  /** ↑/↓ button — swap sort_order with previous/next sibling. Kept as a
   * fallback to drag-and-drop for keyboard / accessibility users. */
  async function handleReorder(ws, direction) {
    const siblings = real
      .filter((w) => (w.parent_slug ?? null) === (ws.parent_slug ?? null))
      .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))
    const idx = siblings.findIndex((w) => w.slug === ws.slug)
    const targetIdx = idx + direction
    if (idx < 0 || targetIdx < 0 || targetIdx >= siblings.length) return
    const target = siblings[targetIdx]

    let a = ws.sort_order
    let b = target.sort_order
    if (a === b) {
      if (direction < 0) a = b - 1
      else a = b + 1
    } else {
      ;[a, b] = [b, a]
    }

    setMoving(true)
    try {
      await Promise.all([
        updateWorkspace(ws.slug, { sortOrder: a }),
        updateWorkspace(target.slug, { sortOrder: b }),
      ])
      reload()
    } catch (err) {
      toast.error(err.message || '순서 변경 실패')
    } finally {
      setMoving(false)
    }
  }

  function rowActions(w) {
    const siblings = real
      .filter((s) => (s.parent_slug ?? null) === (w.parent_slug ?? null))
      .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))
    const sibIdx = siblings.findIndex((s) => s.slug === w.slug)
    return (
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => handleReorder(w, -1)}
          disabled={moving || sibIdx <= 0}
          aria-label="위로"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => handleReorder(w, +1)}
          disabled={moving || sibIdx >= siblings.length - 1}
          aria-label="아래로"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => setEditing(w)}
          disabled={moving}
          aria-label="편집"
          title="편집 (이름·상위 부서 변경)"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-destructive"
          onClick={() => setConfirmDelete(w)}
          disabled={moving}
          aria-label="삭제"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">부서 트리</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setBulkCreating(true)}>
              <Plus className="mr-1 h-3 w-3" />
              부서 일괄 추가
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-3 w-3" />
              부서 추가
            </Button>
          </div>
        </div>
        <CardDescription>
          그립(⋮⋮) 잡고 드래그 — 행 위쪽 가는 띠에 놓으면 그 형제 위로 끼움, 행 본체에 놓으면 그 부서의 자식이 됨.
          ↑/↓ 화살표는 형제 순서, 편집(✏️)에서도 상위 부서 변경 가능.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-48" />
        ) : error ? (
          <ErrorState description={error.message} onRetry={reload} />
        ) : (
          <>
            <WorkspaceTreeDnD
              workspaces={real}
              onMove={handleMove}
              disabled={moving}
              renderActions={rowActions}
            />
            {virtuals.length > 0 && (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mt-4 mb-2">
                  가상 부서 (수정 불가)
                </div>
                <ul className="divide-y">
                  {virtuals.map((w) => (
                    <WorkspaceRow key={w.slug} ws={w} virtual />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </CardContent>

      <WorkspaceCreateDialog
        open={creating}
        onOpenChange={setCreating}
        workspaces={real}
        onCreated={() => {
          setCreating(false)
          reload()
        }}
      />

      <WorkspaceBulkCreateDialog
        open={bulkCreating}
        onOpenChange={setBulkCreating}
        onCreated={(count) => {
          setBulkCreating(false)
          toast.success(`${count}개 부서가 추가되었습니다.`)
          reload()
        }}
      />

      <WorkspaceEditDialog
        ws={editing}
        workspaces={real}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null)
          reload()
        }}
      />

      <DeleteWorkspaceConfirm
        ws={confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete.slug)}
      />
    </Card>
  )
}

function WorkspaceRow({
  ws,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  disabled,
  virtual,
}) {
  return (
    <li
      className="flex items-center gap-2 py-3"
      style={{ paddingLeft: (ws.depth ?? 0) * 16 }}
    >
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: ws.color }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{ws.name}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {ws.slug}
          </Badge>
          {ws.parent_slug && (
            <span className="text-[10px] text-muted-foreground">↳ {ws.parent_slug}</span>
          )}
        </div>
        {ws.description && (
          <div className="text-xs text-muted-foreground truncate">{ws.description}</div>
        )}
      </div>

      {!virtual && onMoveUp && (
        <>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onMoveUp}
            disabled={disabled || !canMoveUp}
            aria-label="위로"
            title="형제 부서간 위로"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onMoveDown}
            disabled={disabled || !canMoveDown}
            aria-label="아래로"
            title="형제 부서간 아래로"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onEdit}
            disabled={disabled}
            aria-label="편집"
            title="편집 (이름·상위 부서 변경)"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive"
            onClick={onDelete}
            disabled={disabled}
            aria-label="삭제"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </li>
  )
}

function WorkspaceCreateDialog({ open, onOpenChange, workspaces, onCreated }) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [parentSlug, setParentSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (open) {
      // Auto-issue a UUID — slugs are immutable after creation and the
      // user only cares about the display name (`name` field). UUIDs
      // start with a hex digit so they satisfy the backend's
      // `^[a-z0-9][a-z0-9-]*$` pattern automatically.
      setSlug(globalThis.crypto?.randomUUID?.() ?? fallbackUuid())
      setName('')
      setParentSlug('')
      setErrorMsg(null)
    }
  }, [open])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    setSubmitting(true)
    try {
      await createWorkspace({
        slug,
        name,
        parentSlug: parentSlug || null,
      })
      toast.success('부서가 생성되었습니다.')
      onCreated()
    } catch (err) {
      setErrorMsg(err.message || '생성 실패')
    } finally {
      setSubmitting(false)
    }
  }

  // Parent picker only shows pickable nodes — exclude virtuals (can't
  // own children) and personals (auto-managed scratch spaces, never
  // parents of org workspaces).
  const eligibleParents = (workspaces ?? []).filter(
    (w) => !w.virtual && w.kind !== 'personal',
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Same dynamic-width policy as WorkspaceEditDialog — long parent
          paths in the combobox push the modal out to fit. */}
      <DialogContent className="w-fit min-w-[36rem] max-w-[min(95vw,56rem)]">
        <DialogHeader>
          <DialogTitle>새 부서</DialogTitle>
          <DialogDescription>슬러그는 발행 후 변경 불가합니다.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ws-slug">슬러그</Label>
            <Input
              id="ws-slug"
              value={slug}
              readOnly
              className="font-mono text-[11px] bg-muted/40"
            />
            <p className="text-[11px] text-muted-foreground">
              자동 발급된 UUID. URL·DB에 사용되며 생성 후 변경 불가.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">이름 (화면 표시용)</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="모바일팀"
              required
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              UI에 보이는 라벨 — 한글·기호 자유. 나중에 수정 가능.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-parent">상위 부서</Label>
            <WorkspaceCombobox
              id="ws-parent"
              workspaces={eligibleParents}
              value={parentSlug}
              onChange={setParentSlug}
              placeholder="(루트 — 본부)"
              allowNone
              noneLabel="(루트 — 본부)"
              noTruncate
            />
            <p className="text-[11px] text-muted-foreground">
              상위를 선택하지 않으면 루트(본부) 부서가 됩니다. 색상은 상위
              부서를 따라 자동 배정됩니다.
            </p>
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '생성 중...' : '생성'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceEditDialog({ ws, workspaces, onOpenChange, onSaved }) {
  const open = Boolean(ws)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sortOrder, setSortOrder] = useState(0)
  const [parentSlug, setParentSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (ws) {
      setName(ws.name)
      setDescription(ws.description ?? '')
      setSortOrder(ws.sort_order ?? 0)
      setParentSlug(ws.parent_slug ?? '')
      setErrorMsg(null)
    }
  }, [ws])

  // Forbid moving under self or any descendant — those are rejected by the
  // backend with cycle errors anyway, but pre-filter the picker for clarity.
  // Virtuals are also stripped: they can't own children.
  const eligibleParents = useMemo(() => {
    if (!ws || !workspaces) return []
    const descendants = new Set(collectDescendants(workspaces, ws.slug))
    descendants.add(ws.slug)
    return workspaces.filter(
      (w) => !w.virtual && w.kind !== 'personal' && !descendants.has(w.slug),
    )
  }, [ws, workspaces])

  const movedToDifferentParent = ws && (ws.parent_slug ?? '') !== parentSlug

  async function onSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const payload = {
        name,
        description,
        sortOrder: Number(sortOrder),
      }
      // Only send parent_slug when it actually changed — sending null when
      // the field was 'untouched' would still move to root.
      if (movedToDifferentParent) {
        payload.parentSlug = parentSlug || null
      }
      await updateWorkspace(ws.slug, payload)
      toast.success('수정되었습니다.')
      onSaved()
    } catch (err) {
      setErrorMsg(err.message || '수정 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Dynamic width — `w-fit` lets the modal grow to fit its widest
          child (the parent-부서 combobox, when noTruncate is on, expresses
          the full path's natural width). `min-w-[36rem]` keeps the
          form at a comfortable baseline; `max-w-[min(95vw,56rem)]`
          caps at 56rem or 95vw so very long names never push the
          modal off-screen. Without these together the combobox text
          either truncated (default max-w-xl) or extended past the
          modal edge. */}
      <DialogContent className="w-fit min-w-[36rem] max-w-[min(95vw,56rem)]">
        <DialogHeader>
          <DialogTitle>부서 편집</DialogTitle>
          <DialogDescription className="break-all">
            슬러그(<code className="font-mono">{ws?.slug}</code>) 외 모든 항목 변경 가능.
            색상은 상위 부서에 따라 자동 배정.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>이름</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-parent">
              <span className="inline-flex items-center gap-1">
                <Move className="h-3 w-3" />
                상위 부서
              </span>
            </Label>
            <WorkspaceCombobox
              id="edit-parent"
              workspaces={eligibleParents}
              value={parentSlug}
              onChange={setParentSlug}
              placeholder="(루트 — 본부)"
              allowNone
              noneLabel="(루트 — 본부)"
              noTruncate
            />
            <p className="text-[11px] text-muted-foreground">
              자기 자신 / 하위 부서는 선택할 수 없습니다 (트리 순환 방지).
              {movedToDifferentParent && (
                <span className="ml-1 text-amber-600">
                  ※ 저장 시 부서 위치 + 색상이 함께 이동합니다.
                </span>
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>설명</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>정렬 순서</Label>
            <Input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
          {ws && !ws.virtual && (
            <WorkspaceAdminsSection workspaceSlug={ws.slug} />
          )}
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              저장
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Bulk-add depts via a pasteable 2-column table. Operators copy from a
 * spreadsheet (parent name, dept name) and we resolve parents by name —
 * either against the existing tree or against earlier rows in the same
 * batch. Empty parent = root. Backend handles the topological order and
 * surfaces a per-row error for ambiguous / orphaned references.
 */
const BULK_EMPTY_ROW = { parentName: '', name: '' }

/** 부서 매니저 다중 picker. 시스템 관리자가 부서 편집 다이얼로그 안에서
 *  그 부서의 매니저들을 임명/해임.
 *
 *  이 섹션의 행위는 즉시 (저장 버튼과 무관) — 각 add/remove 호출 시
 *  바로 백엔드 반영. 다이얼로그를 닫지 않고도 추가 작업 가능. 부서
 *  이름·설명 등 다른 필드는 저장 버튼 눌러야 반영.
 *
 *  '매니저' = WorkspaceMember.role=admin 인 사람 (라벨 통일, 저장 값은
 *  여전히 admin). 한 부서에 여럿 가능. 일반 사용자는 여기서 안 보이고
 *  '/w/:slug/members' 페이지에서 따로 관리.
 */
function WorkspaceAdminsSection({ workspaceSlug }) {
  const [admins, setAdmins] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const items = await listMembers(workspaceSlug)
      // 'manager' role only (p8 이전엔 'admin'). 한 user 가 부서 트리
      // 에서 위/아래 모두에서 매니저로 잡히면 두 번 나오므로 dedup.
      const seenUsers = new Set()
      const onlyAdmins = []
      for (const m of items ?? []) {
        if (m.role !== 'manager') continue
        if (seenUsers.has(m.user_id)) continue
        seenUsers.add(m.user_id)
        onlyAdmins.push(m)
      }
      setAdmins(onlyAdmins)
    } catch (e) {
      toast.error(e?.message || '관리자 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug])

  // Debounced user search when the add-picker is open.
  useEffect(() => {
    if (!pickerOpen) return
    const id = setTimeout(async () => {
      setSearching(true)
      try {
        const users = await searchUsers({ search: query, limit: 12 })
        // Hide users already in the admin list — no point offering them.
        const existing = new Set(admins.map((m) => m.user_id))
        setSearchResults((users ?? []).filter((u) => !existing.has(u.id)))
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => clearTimeout(id)
  }, [query, pickerOpen, admins])

  async function handleAdd(email) {
    setAdding(true)
    try {
      await addMember(workspaceSlug, { email, role: 'manager' })
      toast.success(`${email} 매니저 추가`)
      setQuery('')
      setPickerOpen(false)
      await refresh()
    } catch (e) {
      toast.error(e?.message || '관리자 추가 실패')
    } finally {
      setAdding(false)
    }
  }

  async function handleRemove(member) {
    if (!window.confirm(`'${member.name || member.email}'을(를) 매니저에서 해임하시겠어요?\n(그 사용자의 다른 부서 멤버십은 영향 없음.)`)) {
      return
    }
    try {
      await removeMember(workspaceSlug, member.id)
      toast.success('해임 완료')
      await refresh()
    } catch (e) {
      toast.error(e?.message || '해임 실패')
    }
  }

  return (
    <div className="space-y-1.5 border-t pt-3">
      <Label className="flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
        매니저
      </Label>
      <p className="text-[11px] text-muted-foreground">
        이 부서의 멤버·템플릿·폴더·AI 프롬프트를 관리. 여러 명 가능.
        일반 사용자는 부서 페이지의 '부서 멤버'에서 추가하세요.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3 w-3 animate-spin" /> 불러오는 중...
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5 py-1">
          {admins.length === 0 ? (
            <span className="text-xs text-muted-foreground">아직 없음</span>
          ) : (
            admins.map((m) => (
              <Badge
                key={m.id}
                variant="secondary"
                className="gap-1 pr-1 max-w-[16rem]"
                title={
                  m.source_workspace_slug === workspaceSlug
                    ? `${m.name || m.email} · 직접 추가됨`
                    : `${m.name || m.email} · 상위 부서에서 상속됨: ${m.source_workspace_slug}`
                }
              >
                {/* Long names/emails would otherwise push the badge past
                    the dialog edge — cap + truncate, full text in title. */}
                <span className="text-xs truncate min-w-0">
                  {m.name || m.email}
                  {m.source_workspace_slug !== workspaceSlug && (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      (상속)
                    </span>
                  )}
                </span>
                {m.source_workspace_slug === workspaceSlug && (
                  <button
                    type="button"
                    onClick={() => handleRemove(m)}
                    className="hover:bg-muted-foreground/20 rounded p-0.5 shrink-0"
                    title="해임"
                  >
                    <XIcon className="h-2.5 w-2.5" />
                  </button>
                )}
              </Badge>
            ))
          )}
        </div>
      )}

      {!pickerOpen ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setPickerOpen(true)
            setTimeout(() => inputRef.current?.focus(), 30)
          }}
        >
          <UserPlus className="mr-1 h-3 w-3" />
          관리자 추가
        </Button>
      ) : (
        <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
          <Input
            ref={inputRef}
            placeholder="이름·이메일로 검색..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 text-xs"
          />
          {searching ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-1 py-1">
              <Loader2 className="h-3 w-3 animate-spin" /> 검색 중...
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {searchResults.length === 0 ? (
                <div className="text-xs text-muted-foreground px-1 py-1">
                  {query ? '일치하는 사용자 없음' : '검색어 입력'}
                </div>
              ) : (
                searchResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    disabled={adding}
                    onClick={() => handleAdd(u.email)}
                    className="flex items-center w-full gap-2 rounded px-2 py-1 text-xs text-left hover:bg-background min-w-0"
                  >
                    <span className="truncate shrink-0 max-w-[40%]">{u.name}</span>
                    {/* email gets the rest of the row + can shrink. Without
                        truncate+min-w-0 a long company email pushes the
                        row past the dialog edge. */}
                    <span className="text-[10px] text-muted-foreground truncate min-w-0 flex-1 text-right">
                      {u.email}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setPickerOpen(false)
                setQuery('')
              }}
            >
              닫기
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}


/** 시스템 관리자 (User.is_system_admin) 카드 — admin 페이지 상단.
 *
 *  시스템 운영자(부서 트리, 카테고리, 엔티티 등 org-wide 마스터)를
 *  임명/해임. 부서 매니저(WorkspaceMember.role=admin)와 별개.
 *
 *  자기 자신을 해제하는 액션은 백엔드가 "마지막 시스템 관리자" 인
 *  경우에 한해 막음. 프론트에서는 항상 본인 행에서 해제 버튼을
 *  비활성화로 표시 (지금 본인이 마지막인지 사전 판단 어려움 — 누른
 *  뒤 toast로 안내). 또는 안전하게 본인 제거 버튼 자체를 숨김 처리.
 */
function SystemAdminsCard({ meUserId }) {
  const [admins, setAdmins] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const rows = await listSystemAdmins()
      setAdmins(rows ?? [])
    } catch (e) {
      toast.error(e?.message || '시스템 관리자 목록 로드 실패')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  // Debounced search when picker open. Hide users who are already
  // system admins.
  useEffect(() => {
    if (!pickerOpen) return
    const id = setTimeout(async () => {
      setSearching(true)
      try {
        const users = await searchUsers({ search: query, limit: 12 })
        const existing = new Set(admins.map((a) => a.id))
        setSearchResults((users ?? []).filter((u) => !existing.has(u.id)))
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => clearTimeout(id)
  }, [query, pickerOpen, admins])

  async function handlePromote(user) {
    setAdding(true)
    try {
      await setSystemAdmin(user.id, true)
      toast.success(`${user.name || user.email} 시스템 관리자 임명`)
      setQuery('')
      setPickerOpen(false)
      await refresh()
    } catch (e) {
      toast.error(e?.message || '임명 실패')
    } finally {
      setAdding(false)
    }
  }

  async function handleDemote(admin) {
    const msg =
      admin.id === meUserId
        ? '본인을 시스템 관리자에서 해제하시겠어요?\n(마지막 시스템 관리자라면 백엔드가 거절.)'
        : `'${admin.name || admin.email}'을(를) 시스템 관리자에서 해제하시겠어요?`
    if (!window.confirm(msg)) return
    try {
      await setSystemAdmin(admin.id, false)
      toast.success('해제됨')
      await refresh()
    } catch (e) {
      toast.error(e?.response?.data?.message || e?.message || '해제 실패')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-amber-500" />
          시스템 관리자
        </CardTitle>
        <CardDescription className="text-xs">
          부서 트리·기준정보·서버 관리 권한. 부서 매니저와 별개. 소수만
          가져야 안전합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> 불러오는 중...
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {admins.length === 0 ? (
              <span className="text-sm text-muted-foreground">없음</span>
            ) : (
              admins.map((a) => {
                const isSelf = a.id === meUserId
                return (
                  <Badge
                    key={a.id}
                    variant={isSelf ? 'default' : 'secondary'}
                    className="gap-1 pr-1"
                    title={isSelf ? '본인' : ''}
                  >
                    <ShieldCheck className="h-3 w-3" />
                    <span className="text-xs">
                      {a.name || a.email}
                      {isSelf && (
                        <span className="ml-1 text-[10px] opacity-70">(본인)</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDemote(a)}
                      className="hover:bg-muted-foreground/20 rounded p-0.5"
                      title="해제"
                    >
                      <XIcon className="h-2.5 w-2.5" />
                    </button>
                  </Badge>
                )
              })
            )}
          </div>
        )}

        {!pickerOpen ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setPickerOpen(true)
              setTimeout(() => inputRef.current?.focus(), 30)
            }}
          >
            <UserPlus className="mr-1 h-3 w-3" />
            시스템 관리자 추가
          </Button>
        ) : (
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
            <Input
              ref={inputRef}
              placeholder="이름·이메일로 검색..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 text-xs"
            />
            {searching ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground px-1 py-1">
                <Loader2 className="h-3 w-3 animate-spin" /> 검색 중...
              </div>
            ) : (
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {searchResults.length === 0 ? (
                  <div className="text-xs text-muted-foreground px-1 py-1">
                    {query ? '일치하는 사용자 없음' : '검색어 입력'}
                  </div>
                ) : (
                  searchResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      disabled={adding}
                      onClick={() => handlePromote(u)}
                      className="flex items-center w-full gap-2 rounded px-2 py-1 text-xs text-left hover:bg-background"
                    >
                      <span className="flex-1 truncate">{u.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {u.email}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPickerOpen(false)
                  setQuery('')
                }}
              >
                닫기
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}


function WorkspaceBulkCreateDialog({ open, onOpenChange, onCreated }) {
  const [rows, setRows] = useState(() => Array.from({ length: 5 }, () => ({ ...BULK_EMPTY_ROW })))
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (open) {
      setRows(Array.from({ length: 5 }, () => ({ ...BULK_EMPTY_ROW })))
      setErrorMsg(null)
    }
  }, [open])

  function updateCell(rowIdx, key, value) {
    setRows((prev) => {
      const next = [...prev]
      next[rowIdx] = { ...next[rowIdx], [key]: value }
      return next
    })
  }

  function addRow() {
    setRows((prev) => [...prev, { ...BULK_EMPTY_ROW }])
  }

  function removeRow(rowIdx) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== rowIdx)))
  }

  // Intercept paste so a TSV from a spreadsheet (rows × tab-separated
  // cells) populates the table starting at the focused cell. Single-cell
  // pastes fall through to the default behavior.
  function handlePaste(rowIdx, colIdx, e) {
    const text = e.clipboardData.getData('text')
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return
    e.preventDefault()
    const grid = text
      .replace(/\r/g, '')
      .split('\n')
      .filter((line, idx, arr) => line.length > 0 || idx < arr.length - 1)
      .map((line) => line.split('\t'))
    setRows((prev) => {
      const next = [...prev]
      for (let i = 0; i < grid.length; i += 1) {
        const targetRow = rowIdx + i
        while (next.length <= targetRow) next.push({ ...BULK_EMPTY_ROW })
        const cells = grid[i]
        const merged = { ...next[targetRow] }
        for (let j = 0; j < cells.length; j += 1) {
          const targetCol = colIdx + j
          const value = (cells[j] ?? '').trim()
          if (targetCol === 0) merged.parentName = value
          else if (targetCol === 1) merged.name = value
        }
        next[targetRow] = merged
      }
      return next
    })
  }

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    const items = rows
      .map((r) => ({
        parentName: (r.parentName || '').trim(),
        name: (r.name || '').trim(),
      }))
      .filter((r) => r.name) // drop completely empty rows
    if (items.length === 0) {
      setErrorMsg('부서 이름이 입력된 행이 없습니다.')
      return
    }
    setSubmitting(true)
    try {
      const created = await bulkCreateWorkspaces(items)
      onCreated(Array.isArray(created) ? created.length : items.length)
    } catch (err) {
      setErrorMsg(err.message || '일괄 추가 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>부서 일괄 추가</DialogTitle>
          <DialogDescription>
            엑셀에서 두 열 (<strong>상위 부서</strong> / <strong>부서 이름</strong>)을
            복사한 뒤 첫 셀에 붙여넣으면 행이 채워집니다. 상위 부서는 기존
            부서명 또는 같은 표 안의 다른 행 이름과 일치해야 하며, 비우면
            루트(본부)가 됩니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium text-xs text-muted-foreground w-10">
                    #
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium text-xs text-muted-foreground">
                    상위 부서 이름{' '}
                    <span className="font-normal text-muted-foreground/70">
                      (비우면 루트)
                    </span>
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium text-xs text-muted-foreground">
                    부서 이름
                  </th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="px-2 py-1 text-xs text-muted-foreground">
                      {idx + 1}
                    </td>
                    <td className="p-1">
                      <Input
                        value={row.parentName}
                        onChange={(e) => updateCell(idx, 'parentName', e.target.value)}
                        onPaste={(e) => handlePaste(idx, 0, e)}
                        className="h-8 text-sm"
                        placeholder="(루트)"
                      />
                    </td>
                    <td className="p-1">
                      <Input
                        value={row.name}
                        onChange={(e) => updateCell(idx, 'name', e.target.value)}
                        onPaste={(e) => handlePaste(idx, 1, e)}
                        className="h-8 text-sm"
                        placeholder="부서 이름"
                      />
                    </td>
                    <td className="p-1 text-right">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground"
                        onClick={() => removeRow(idx)}
                        disabled={rows.length <= 1}
                        title="이 행 삭제"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <Plus className="mr-1 h-3 w-3" />행 추가
            </Button>
            <p className="text-[11px] text-muted-foreground">
              완료 후 색상은 새 트리 구조에 맞춰 자동 재배정됩니다.
            </p>
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '추가 중…' : '일괄 추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteWorkspaceConfirm({ ws, onOpenChange, onConfirm }) {
  const open = Boolean(ws)
  const [blockers, setBlockers] = useState(null)
  const [loading, setLoading] = useState(false)
  // Separate from `loading` (which tracks the initial blockers fetch) —
  // this guards the actual delete request so double-submit / Enter spam
  // can't fire it twice.
  const [submitting, setSubmitting] = useState(false)
  // Move keyboard focus to the destructive button once the blockers fetch
  // returns clean. `autoFocus` doesn't help here because the button starts
  // disabled — Radix can't focus a disabled control, and the prop only
  // fires on mount.
  const deleteBtnRef = useRef(null)

  useEffect(() => {
    if (!open || !ws) {
      setBlockers(null)
      setSubmitting(false)
      return
    }
    setLoading(true)
    getWorkspaceDependents(ws.slug)
      .then(setBlockers)
      .catch(() => setBlockers(null))
      .finally(() => setLoading(false))
  }, [open, ws?.slug])

  const totalBlockers = blockers
    ? Object.values(blockers).reduce((a, b) => a + b, 0)
    : 0
  const canDelete = !loading && !submitting && blockers && totalBlockers === 0

  useEffect(() => {
    if (canDelete) {
      // Defer so the button is for-sure enabled in the DOM before we
      // call focus() — React may not have flushed the disabled attr yet.
      const id = requestAnimationFrame(() => {
        deleteBtnRef.current?.focus()
      })
      return () => cancelAnimationFrame(id)
    }
  }, [canDelete])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canDelete) return
    setSubmitting(true)
    try {
      await onConfirm()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>부서 삭제</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{ws?.slug}</code> 부서를 삭제합니다.
          </DialogDescription>
        </DialogHeader>

        {/* Form wrapper so Enter on the dialog triggers the destructive
            action. The submit button auto-focuses to make the keyboard
            flow obvious. */}
        <form onSubmit={handleSubmit}>
          {loading ? (
            <Skeleton className="h-20" />
          ) : blockers ? (
            <div className="space-y-2 text-sm">
              <BlockerRow label="자식 부서" count={blockers.children} />
              <BlockerRow label="멤버" count={blockers.members} />
              <BlockerRow label="보고서" count={blockers.reports} />
              <BlockerRow label="이 부서가 소유한 템플릿" count={blockers.templates} />
              {totalBlockers > 0 && (
                <p className="text-xs text-amber-600 mt-2">
                  참조 중인 항목이 있어 삭제할 수 없습니다. 먼저 정리하세요.
                </p>
              )}
            </div>
          ) : null}

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button
              ref={deleteBtnRef}
              type="submit"
              variant="destructive"
              disabled={!canDelete}
            >
              {submitting ? '삭제 중…' : '삭제'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function BlockerRow({ label, count }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <Badge variant={count === 0 ? 'outline' : 'destructive'}>{count}</Badge>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Tree helpers
// --------------------------------------------------------------------------- //
/** RFC 4122 v4 UUID fallback for browsers without crypto.randomUUID
 *  (very old WebViews). Mirrors the helpers in TemplateEditorPage and
 *  ReportDetailPage so all "create-by-UUID" flows produce identically
 *  shaped ids. */
function fallbackUuid() {
  const hex = '0123456789abcdef'
  const out = new Array(36)
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out[i] = '-'
    else if (i === 14) out[i] = '4'
    else if (i === 19) out[i] = hex[(Math.random() * 4) | 0 | 8]
    else out[i] = hex[(Math.random() * 16) | 0]
  }
  return out.join('')
}

function collectDescendants(workspaces, slug) {
  const byParent = new Map()
  for (const w of workspaces) {
    const arr = byParent.get(w.parent_slug ?? null) ?? []
    arr.push(w)
    byParent.set(w.parent_slug ?? null, arr)
  }
  const out = []
  const stack = [slug]
  while (stack.length) {
    const cur = stack.pop()
    for (const c of byParent.get(cur) ?? []) {
      out.push(c.slug)
      stack.push(c.slug)
    }
  }
  return out
}

// =========================================================================
// 관계 라벨 (rich_text 위젯 아웃라인 항목의 부모 대비 역할)
// =========================================================================
function RelationsSection() {
  const { data: relations, loading, error, reload } = useAsync(
    () => listWidgetRelations(),
    [],
  )
  const [editingSlug, setEditingSlug] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [creating, setCreating] = useState(false)

  function refresh() {
    invalidateWidgetRelationsCache()
    reload()
  }

  async function handleDelete(slug) {
    try {
      await deleteWidgetRelation(slug)
      toast.success('관계가 삭제되었습니다.')
      refresh()
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Workflow className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">관계 라벨</CardTitle>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-3 w-3" />
            추가
          </Button>
        </div>
        <CardDescription>
          긴 글 위젯의 아웃라인 항목이 부모 항목에 대해 가지는 역할 라벨입니다 (예: 원인, 결과, 예시).
          빌트인 라벨은 이름·정렬·키워드만 수정할 수 있고 삭제는 불가합니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32" />
        ) : error ? (
          <ErrorState description={error.message} onRetry={refresh} />
        ) : (relations ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">관계가 없습니다.</p>
        ) : (
          <ul className="divide-y">
            {(relations ?? []).map((r) => (
              <RelationRow
                key={r.slug}
                relation={r}
                editing={editingSlug === r.slug}
                onStartEdit={() => setEditingSlug(r.slug)}
                onCancel={() => setEditingSlug(null)}
                onSaved={() => {
                  setEditingSlug(null)
                  refresh()
                }}
                onDelete={() => setConfirmDelete(r)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <RelationCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setCreating(false)
          refresh()
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={() => setConfirmDelete(null)}
        title="관계 삭제"
        description={
          confirmDelete
            ? `'${confirmDelete.name}' (${confirmDelete.slug}) 관계를 삭제하시겠습니까? 기존 보고서에 저장된 슬러그는 그대로 남지만 표시 라벨이 사라집니다.`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={() => confirmDelete && handleDelete(confirmDelete.slug)}
      />
    </Card>
  )
}

function RelationRow({ relation, editing, onStartEdit, onCancel, onSaved, onDelete }) {
  const [name, setName] = useState(relation.name)
  const [description, setDescription] = useState(relation.description ?? '')
  const [keywords, setKeywords] = useState((relation.hint_keywords ?? []).join(', '))
  const [sortOrder, setSortOrder] = useState(relation.sort_order)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(relation.name)
    setDescription(relation.description ?? '')
    setKeywords((relation.hint_keywords ?? []).join(', '))
    setSortOrder(relation.sort_order)
  }, [relation])

  async function onSave() {
    setSaving(true)
    try {
      await updateWidgetRelation(relation.slug, {
        name,
        description: description || null,
        hintKeywords: keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        sortOrder: Number(sortOrder),
      })
      toast.success('수정되었습니다.')
      onSaved()
    } catch (err) {
      toast.error(err.message || '수정 실패')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <li className="grid grid-cols-12 gap-2 items-start py-3">
        <Badge variant="outline" className="font-mono col-span-3 justify-center mt-1">
          {relation.slug}
        </Badge>
        <div className="col-span-7 space-y-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9"
            placeholder="이름 (한국어)"
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="h-9 text-xs"
            placeholder="설명 (선택)"
          />
          <Input
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            className="h-9 text-xs"
            placeholder="자동 감지 키워드 (쉼표 구분, 선택)"
          />
          <Input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="h-9 text-xs"
            placeholder="정렬"
          />
        </div>
        <div className="col-span-2 flex justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={onSave}
            disabled={saving}
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-3 py-3">
      <Badge variant="outline" className="font-mono shrink-0">
        {relation.slug}
      </Badge>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{relation.name}</span>
          {relation.is_builtin && (
            <Badge variant="secondary" className="text-[10px]">
              빌트인
            </Badge>
          )}
        </div>
        {relation.description && (
          <div className="text-xs text-muted-foreground truncate">{relation.description}</div>
        )}
        {(relation.hint_keywords ?? []).length > 0 && (
          <div className="text-[10px] text-muted-foreground font-mono truncate">
            힌트: {relation.hint_keywords.join(' · ')}
          </div>
        )}
      </div>
      <span className="text-xs text-muted-foreground">정렬: {relation.sort_order}</span>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onStartEdit}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-destructive disabled:opacity-30"
        onClick={onDelete}
        disabled={relation.is_builtin}
        title={relation.is_builtin ? '빌트인 관계는 삭제할 수 없습니다' : '삭제'}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}

function RelationCreateDialog({ open, onOpenChange, onCreated }) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [keywords, setKeywords] = useState('')
  const [sortOrder, setSortOrder] = useState(100)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (!open) {
      setSlug('')
      setName('')
      setDescription('')
      setKeywords('')
      setSortOrder(100)
      setErrorMsg(null)
    }
  }, [open])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    setSubmitting(true)
    try {
      await createWidgetRelation({
        slug,
        name,
        description: description || undefined,
        hintKeywords: keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        sortOrder: Number(sortOrder),
      })
      toast.success('관계가 추가되었습니다.')
      onCreated()
    } catch (err) {
      setErrorMsg(err.message || '생성 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 관계 라벨</DialogTitle>
          <DialogDescription>
            슬러그는 콘텐츠에 그대로 저장되므로 발행 후 변경 불가합니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rel-slug">슬러그</Label>
            <Input
              id="rel-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="hypothesis"
              pattern="^[a-z0-9][a-z0-9_\-]*$"
              required
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              영문 소문자/숫자/하이픈/언더스코어. 예: <code>hypothesis</code>
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rel-name">이름 (한국어)</Label>
            <Input
              id="rel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="가설"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rel-desc">설명 (선택)</Label>
            <Input
              id="rel-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="검증 대상 가정"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rel-keywords">자동 감지 키워드 (선택)</Label>
            <Input
              id="rel-keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="가정하면, 만약, 추정컨대"
            />
            <p className="text-[11px] text-muted-foreground">
              쉼표로 구분. 향후 자동 제안 힌트에 사용됩니다.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rel-sort">정렬 순서</Label>
            <Input
              id="rel-sort"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '추가 중...' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// =========================================================================
// 단락 구분 — 보고서 위젯에 우클릭으로 붙이는 'rationale/risk/...' 같은
// 태그 항목들을 관리. 분류·항목 모두 admin이 자유롭게 추가/수정/삭제할 수
// 있도록 master-detail 형태로 노출한다.
// =========================================================================
function SectionsSection() {
  const { data: categories, loading, error, reload } = useAsync(
    () => listSectionCategories(),
    [],
  )
  const list = categories ?? []
  const [selectedSlug, setSelectedSlug] = useState(null)
  const selected =
    list.find((c) => c.slug === selectedSlug) ?? list[0] ?? null

  const [creatingCat, setCreatingCat] = useState(false)
  const [editingCat, setEditingCat] = useState(null)
  const [confirmDeleteCat, setConfirmDeleteCat] = useState(null)

  const [creatingItem, setCreatingItem] = useState(false)
  const [editingItemCode, setEditingItemCode] = useState(null)
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null)

  function refresh() {
    invalidateSectionTaxonomyCache()
    reload()
  }

  async function handleDeleteCategory(slug) {
    try {
      await deleteSectionCategory(slug)
      toast.success('분류가 삭제되었습니다.')
      refresh()
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  async function handleDeleteItem(code) {
    try {
      await deleteSectionItem(code)
      toast.success('항목이 삭제되었습니다.')
      refresh()
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bookmark className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">단락 구분</CardTitle>
          </div>
          <Button size="sm" onClick={() => setCreatingCat(true)}>
            <Plus className="mr-1 h-3 w-3" />
            분류 추가
          </Button>
        </div>
        <CardDescription>
          보고서 작성 시 위젯에 우클릭으로 붙이는 단락 구분 태그입니다.
          분류·항목 모두 자유롭게 추가/수정/삭제 가능하지만 항목 코드는
          생성 후 변경할 수 없습니다 (저장된 보고서가 코드를 참조하므로).
          삭제 시 기존 보고서의 태그는 그대로 남고 표시만 사라집니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-48" />
        ) : error ? (
          <ErrorState description={error.message} onRetry={refresh} />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            분류가 없습니다. 우측 상단 '분류 추가'로 시작하세요.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
            <ul className="divide-y border rounded-md">
              {list.map((cat) => {
                const isActive = (selected?.slug ?? null) === cat.slug
                return (
                  <li
                    key={cat.slug}
                    className={`flex items-center gap-2 px-2 py-2 cursor-pointer hover:bg-muted/50 transition-colors ${
                      isActive ? 'bg-muted' : ''
                    }`}
                    onClick={() => setSelectedSlug(cat.slug)}
                  >
                    <span
                      className="h-3 w-3 rounded-full shrink-0 border"
                      style={{ backgroundColor: cat.color, borderColor: cat.color }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{cat.name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono truncate">
                        {cat.slug} · {cat.items?.length ?? 0}개 항목
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingCat(cat)
                      }}
                      aria-label="분류 편집"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDeleteCat(cat)
                      }}
                      aria-label="분류 삭제"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                )
              })}
            </ul>

            <div className="border rounded-md flex flex-col min-h-[24rem]">
              <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
                <div className="flex items-center gap-2 min-w-0">
                  {selected && (
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: selected.color }}
                    />
                  )}
                  <div className="text-sm font-semibold truncate">
                    {selected?.name ?? '분류를 선택하세요'}
                  </div>
                  {selected && (
                    <Badge variant="outline" className="text-[10px]">
                      {selected.items?.length ?? 0}개
                    </Badge>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCreatingItem(true)}
                  disabled={!selected}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  항목 추가
                </Button>
              </div>
              {selected ? (
                (selected.items ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    항목이 없습니다.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {(selected.items ?? []).map((item) => (
                      <SectionItemRow
                        key={item.code}
                        item={item}
                        categories={list}
                        editing={editingItemCode === item.code}
                        onStartEdit={() => setEditingItemCode(item.code)}
                        onCancel={() => setEditingItemCode(null)}
                        onSaved={() => {
                          setEditingItemCode(null)
                          refresh()
                        }}
                        onDelete={() => setConfirmDeleteItem(item)}
                      />
                    ))}
                  </ul>
                )
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  분류를 먼저 선택하세요.
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>

      <SectionCategoryDialog
        open={creatingCat}
        onOpenChange={setCreatingCat}
        onSaved={() => {
          setCreatingCat(false)
          refresh()
        }}
      />
      <SectionCategoryDialog
        open={Boolean(editingCat)}
        category={editingCat}
        onOpenChange={(open) => !open && setEditingCat(null)}
        onSaved={() => {
          setEditingCat(null)
          refresh()
        }}
      />

      <SectionItemDialog
        open={creatingItem}
        defaultCategorySlug={selected?.slug}
        categories={list}
        onOpenChange={setCreatingItem}
        onSaved={() => {
          setCreatingItem(false)
          refresh()
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDeleteCat)}
        onOpenChange={() => setConfirmDeleteCat(null)}
        title="분류 삭제"
        description={
          confirmDeleteCat
            ? `'${confirmDeleteCat.name}' (${confirmDeleteCat.slug}) 분류를 삭제합니다. 이 분류에 속한 ${
                confirmDeleteCat.items?.length ?? 0
              }개 항목도 함께 사라지며, 기존 보고서에 저장된 코드는 그대로 남지만 표시되지 않습니다.`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={() =>
          confirmDeleteCat && handleDeleteCategory(confirmDeleteCat.slug)
        }
      />

      <ConfirmDialog
        open={Boolean(confirmDeleteItem)}
        onOpenChange={() => setConfirmDeleteItem(null)}
        title="항목 삭제"
        description={
          confirmDeleteItem
            ? `'${confirmDeleteItem.label}' (${confirmDeleteItem.code}) 항목을 삭제합니다. 기존 보고서에 이 코드가 저장되어 있어도 그대로 남지만 표시되지 않습니다.`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={() =>
          confirmDeleteItem && handleDeleteItem(confirmDeleteItem.code)
        }
      />
    </Card>
  )
}

/** Inline row that toggles between read-mode and edit-mode. Code is shown
 *  but locked — changing a code would orphan tags already saved in reports. */
function SectionItemRow({
  item,
  categories,
  editing,
  onStartEdit,
  onCancel,
  onSaved,
  onDelete,
}) {
  const [label, setLabel] = useState(item.label)
  const [en, setEn] = useState(item.en ?? '')
  const [categorySlug, setCategorySlug] = useState(item.category_slug)
  const [sortOrder, setSortOrder] = useState(item.sort_order)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLabel(item.label)
    setEn(item.en ?? '')
    setCategorySlug(item.category_slug)
    setSortOrder(item.sort_order)
  }, [item])

  async function onSave() {
    setSaving(true)
    try {
      await updateSectionItem(item.code, {
        label,
        en: en || null,
        categorySlug,
        sortOrder: Number(sortOrder),
      })
      toast.success('수정되었습니다.')
      onSaved()
    } catch (err) {
      toast.error(err.message || '수정 실패')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <li className="grid grid-cols-12 gap-2 items-start px-3 py-3">
        <Badge variant="outline" className="font-mono col-span-3 justify-center mt-1">
          {item.code}
        </Badge>
        <div className="col-span-7 space-y-1.5">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-9"
            placeholder="이름 (한국어)"
          />
          <Input
            value={en}
            onChange={(e) => setEn(e.target.value)}
            className="h-9 text-xs"
            placeholder="영문명 (선택)"
          />
          <select
            value={categorySlug}
            onChange={(e) => setCategorySlug(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
          <Input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="h-9 text-xs"
            placeholder="정렬"
          />
        </div>
        <div className="col-span-2 flex justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={onSave}
            disabled={saving}
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Badge variant="outline" className="font-mono shrink-0 text-[10px]">
        {item.code}
      </Badge>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{item.label}</div>
        {item.en && (
          <div className="text-[10px] text-muted-foreground truncate">{item.en}</div>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground">정렬: {item.sort_order}</span>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onStartEdit}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}

/** Shared dialog for both 'new category' and 'edit category'. */
function SectionCategoryDialog({ open, category, onOpenChange, onSaved }) {
  const editing = Boolean(category)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [color, setColor] = useState('#64748b')
  const [sortOrder, setSortOrder] = useState(100)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (open) {
      setSlug(category?.slug ?? '')
      setName(category?.name ?? '')
      setColor(category?.color ?? '#64748b')
      setSortOrder(category?.sort_order ?? 100)
      setErrorMsg(null)
    }
  }, [open, category])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    setSubmitting(true)
    try {
      if (editing) {
        await updateSectionCategory(category.slug, {
          name,
          color,
          sortOrder: Number(sortOrder),
        })
        toast.success('수정되었습니다.')
      } else {
        await createSectionCategory({
          slug,
          name,
          color,
          sortOrder: Number(sortOrder),
        })
        toast.success('분류가 추가되었습니다.')
      }
      onSaved()
    } catch (err) {
      setErrorMsg(err.message || (editing ? '수정 실패' : '생성 실패'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? '분류 편집' : '새 분류'}</DialogTitle>
          <DialogDescription>
            {editing
              ? `슬러그(${category?.slug})는 변경할 수 없습니다.`
              : '슬러그는 생성 후 변경할 수 없습니다.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sec-slug">슬러그</Label>
            <Input
              id="sec-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="background_definition"
              pattern="^[a-z0-9][a-z0-9_-]*$"
              required
              readOnly={editing}
              disabled={editing}
              className="font-mono"
            />
            {!editing && (
              <p className="text-[11px] text-muted-foreground">
                영문 소문자/숫자/하이픈/언더스코어.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-name">이름</Label>
            <Input
              id="sec-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="배경 및 정의"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-color">색상</Label>
            <ColorPicker id="sec-color" value={color} onChange={setColor} />
            <p className="text-[11px] text-muted-foreground">
              플로팅 picker의 원형 배경과 위젯 배지에 사용됩니다.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-sort">정렬 순서</Label>
            <Input
              id="sec-sort"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (editing ? '저장 중...' : '추가 중...') : editing ? '저장' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Dialog for adding a brand-new item. Edits use the inline row instead. */
function SectionItemDialog({
  open,
  defaultCategorySlug,
  categories,
  onOpenChange,
  onSaved,
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [en, setEn] = useState('')
  const [categorySlug, setCategorySlug] = useState('')
  const [sortOrder, setSortOrder] = useState(100)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (open) {
      setCode('')
      setLabel('')
      setEn('')
      setCategorySlug(defaultCategorySlug ?? categories[0]?.slug ?? '')
      setSortOrder(100)
      setErrorMsg(null)
    }
  }, [open, defaultCategorySlug, categories])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    setSubmitting(true)
    try {
      await createSectionItem({
        code,
        categorySlug,
        label,
        en: en || undefined,
        sortOrder: Number(sortOrder),
      })
      toast.success('항목이 추가되었습니다.')
      onSaved()
    } catch (err) {
      setErrorMsg(err.message || '생성 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 항목</DialogTitle>
          <DialogDescription>
            코드는 보고서에 저장되므로 생성 후 변경할 수 없습니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sec-it-code">코드</Label>
            <Input
              id="sec-it-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toLowerCase())}
              placeholder="risk"
              pattern="^[a-z0-9][a-z0-9_-]*$"
              required
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              영문 소문자/숫자/하이픈/언더스코어. 전체 항목 중 고유해야 합니다.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-it-cat">분류</Label>
            <select
              id="sec-it-cat"
              value={categorySlug}
              onChange={(e) => setCategorySlug(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              required
            >
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name} ({c.slug})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-it-label">이름 (한국어)</Label>
            <Input
              id="sec-it-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="리스크"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-it-en">영문명 (선택)</Label>
            <Input
              id="sec-it-en"
              value={en}
              onChange={(e) => setEn(e.target.value)}
              placeholder="Risk"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-it-sort">정렬 순서</Label>
            <Input
              id="sec-it-sort"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '추가 중...' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// =========================================================================
// 보고서 종류
// =========================================================================
function ReportTypesSection() {
  const { data, loading, error, reload } = useAsync(
    () => listAllReportTypes({ limit: 500 }),
    []
  )
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)

  const items = data?.items ?? []
  // Client-side substring filter on top of the server list. Server-side
  // search is also supported (q param), but the admin tab usually
  // shows ≤ a few hundred entries, so an instant local filter beats
  // round-tripping per keystroke.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return items
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(needle) ||
        (it.description ?? '').toLowerCase().includes(needle),
    )
  }, [items, q])
  const unofficialCount = items.filter((it) => it.status === 'unofficial').length

  async function handlePromote(it) {
    try {
      await promoteReportType(it.id)
      toast.success(`'${it.name}' 을(를) 공식으로 승격했습니다.`)
      reload()
    } catch (err) {
      toast.error(err.message || '승격 실패')
    }
  }

  async function handleDemote(it) {
    try {
      await demoteReportType(it.id)
      toast.success(`'${it.name}' 을(를) 비공식으로 되돌렸습니다.`)
      reload()
    } catch (err) {
      toast.error(err.message || '되돌리기 실패')
    }
  }

  async function handleDelete(it) {
    try {
      const res = await deleteReportType(it.id)
      const orphan = res?.orphan_report_count ?? 0
      toast.success(
        orphan > 0
          ? `'${it.name}' 삭제. ${orphan}건의 보고서에서 연결이 해제되었습니다.`
          : `'${it.name}' 삭제 완료.`,
      )
      reload()
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileType2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">보고서 종류</CardTitle>
            {unofficialCount > 0 && (
              <Badge variant="outline" className="ml-1 gap-1 text-[10px]">
                <ShieldQuestion className="h-3 w-3" />
                비공식 {unofficialCount}건
              </Badge>
            )}
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-3 w-3" />
            추가
          </Button>
        </div>
        <CardDescription>
          보고서의 <strong>용도</strong>를 분류하는 라벨 (예: 주간 보고, 안전 점검).
          템플릿(보고서의 모양)과는 별개로 관리되며, 시스템 전체에서 공유됩니다.
          일반 사용자가 보고서 설정에서 새 종류를 입력하면 <strong>비공식</strong>
          상태로 여기에 추가되고, 관리자가 <CheckCircle2 className="inline h-3 w-3" />
          버튼으로 <strong>공식</strong>으로 승격하면 모든 사용자에게 노출됩니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="이름 / 설명 검색..."
            className="h-9"
          />
        </div>
        {loading ? (
          <Skeleton className="h-40" />
        ) : error ? (
          <ErrorState description={error.message} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            {q.trim() ? '검색 결과가 없습니다.' : '등록된 종류가 없습니다.'}
          </p>
        ) : (
          <ul className="divide-y">
            {filtered.map((it) => (
              <ReportTypeRow
                key={it.id}
                row={it}
                onEdit={() => setEditing(it)}
                onPromote={() => handlePromote(it)}
                onDemote={() => handleDemote(it)}
                onDelete={() => setConfirmDelete(it)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <ReportTypeFormDialog
        open={creating || Boolean(editing)}
        row={editing}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(false)
            setEditing(null)
          }
        }}
        onSaved={() => {
          setCreating(false)
          setEditing(null)
          reload()
        }}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={() => setConfirmDelete(null)}
        title="보고서 종류 삭제"
        description={
          confirmDelete
            ? `'${confirmDelete.name}' 종류를 삭제하시겠습니까? 이 종류를 사용하던 보고서들은 종류 없음 상태가 됩니다 (보고서 자체는 삭제되지 않습니다).`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
      />
    </Card>
  )
}

function ReportTypeRow({ row, onEdit, onPromote, onDemote, onDelete }) {
  const isOfficial = row.status === 'official'
  return (
    <li className="flex items-center gap-3 py-3">
      <Badge
        variant={isOfficial ? 'secondary' : 'outline'}
        className="gap-1 shrink-0"
        title={isOfficial ? '공식 — 모든 사용자에게 노출' : '비공식 — 작성자와 관리자만 볼 수 있음'}
      >
        {isOfficial ? <ShieldCheck className="h-3 w-3" /> : <ShieldQuestion className="h-3 w-3" />}
        {isOfficial ? '공식' : '비공식'}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{row.name}</div>
        {row.description && (
          <p className="truncate text-xs text-muted-foreground mt-0.5">
            {row.description}
          </p>
        )}
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {row.created_by ? `등록: ${row.created_by.name}` : '등록자 미상'}
          {row.approved_by && ` · 승인: ${row.approved_by.name}`}
        </p>
      </div>
      {!isOfficial ? (
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-emerald-600"
          onClick={onPromote}
          title="공식으로 승격"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground"
          onClick={onDemote}
          title="비공식으로 되돌리기"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onEdit} title="수정">
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-destructive"
        onClick={onDelete}
        title="삭제"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}

/**
 * Unified create/edit dialog — when `row` is null we POST a new entry
 * (defaults to `official` since the admin tab is the canonical "I
 * approve this" surface); when `row` is set we PATCH name/description.
 * Status flips have their own buttons on the row (promote/demote) —
 * not exposed here.
 */
function ReportTypeFormDialog({ open, row, onOpenChange, onSaved }) {
  const isEdit = Boolean(row)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (open) {
      setName(row?.name ?? '')
      setDescription(row?.description ?? '')
      setErrorMsg(null)
    }
  }, [open, row])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    setSubmitting(true)
    try {
      if (isEdit) {
        await updateReportType(row.id, { name, description })
        toast.success('수정되었습니다.')
      } else {
        await createReportType({ name, description, status: 'official' })
        toast.success('공식 종류로 추가되었습니다.')
      }
      onSaved()
    } catch (err) {
      setErrorMsg(err?.response?.data?.detail ?? err.message ?? '저장 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? '보고서 종류 수정' : '새 보고서 종류'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '이름과 설명을 변경할 수 있습니다. 상태(공식/비공식)는 목록의 승격/되돌리기 버튼으로 바꾸세요.'
              : '관리자가 직접 추가하는 종류는 곧바로 공식으로 등록됩니다.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rt-name">이름</Label>
            <Input
              id="rt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              placeholder="예: 주간 보고"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rt-desc">설명</Label>
            <textarea
              id="rt-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={4}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="이 종류를 언제 사용하는지 짧게 설명해주세요."
            />
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? (isEdit ? '저장 중...' : '추가 중...') : isEdit ? '저장' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
