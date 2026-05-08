import { useEffect, useMemo, useState } from 'react'
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
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceDependents,
} from '@/shared/api/workspaces'
import { WorkspaceTreeDnD } from './WorkspaceTreeDnD'

export default function AdminPage() {
  const { me } = useAuth()
  const isAdmin = me?.role === 'admin'

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="관리자" description="기준정보 정의 (카테고리 / 부서)" />
        <ErrorState
          title="권한 없음"
          description="관리자 페이지는 admin 권한이 있는 사용자만 접근 가능합니다."
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
        title="관리자"
        description="시스템 기준정보 — 템플릿 카테고리 / 부서 트리. 사용자 관리는 '멤버' 메뉴에서."
      />

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
        </TabsList>

        <TabsContent value="workspaces">
          <WorkspacesSection />
        </TabsContent>
        <TabsContent value="categories">
          <CategoriesSection />
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
              pattern="^[a-z0-9][a-z0-9-]*$"
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
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [editing, setEditing] = useState(null)
  const [moving, setMoving] = useState(false)

  const list = workspaces ?? []
  const real = list.filter((w) => !w.virtual)
  const virtuals = list.filter((w) => w.virtual)

  async function handleDelete(slug) {
    try {
      await deleteWorkspace(slug)
      toast.success('부서가 삭제되었습니다.')
      reload()
    } catch (err) {
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
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-3 w-3" />
            부서 추가
          </Button>
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
  const [color, setColor] = useState('#64748b')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (!open) {
      setSlug('')
      setName('')
      setParentSlug('')
      setColor('#64748b')
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
        color,
      })
      toast.success('부서가 생성되었습니다.')
      onCreated()
    } catch (err) {
      setErrorMsg(err.message || '생성 실패')
    } finally {
      setSubmitting(false)
    }
  }

  const ordered = orderTreeWithDepth(workspaces)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="dev-mobile"
              pattern="^[a-z0-9][a-z0-9-]*$"
              required
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">이름</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="모바일팀"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-parent">상위 부서 (없으면 본부 = 루트)</Label>
            <select
              id="ws-parent"
              value={parentSlug}
              onChange={(e) => setParentSlug(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">(루트 — 본부)</option>
              {ordered.map((w) => (
                <option key={w.slug} value={w.slug}>
                  {'  '.repeat(w.depth)}
                  {w.depth > 0 ? '└ ' : ''}
                  {w.name} ({w.slug})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-color">색상</Label>
            <ColorPicker id="ws-color" value={color} onChange={setColor} />
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
  const [color, setColor] = useState('')
  const [sortOrder, setSortOrder] = useState(0)
  const [parentSlug, setParentSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (ws) {
      setName(ws.name)
      setDescription(ws.description ?? '')
      setColor(ws.color ?? '#64748b')
      setSortOrder(ws.sort_order ?? 0)
      setParentSlug(ws.parent_slug ?? '')
      setErrorMsg(null)
    }
  }, [ws])

  // Forbid moving under self or any descendant — those are rejected by the
  // backend with cycle errors anyway, but pre-filter the dropdown for clarity.
  const eligibleParents = useMemo(() => {
    if (!ws || !workspaces) return []
    const descendants = new Set(collectDescendants(workspaces, ws.slug))
    descendants.add(ws.slug)
    const real = workspaces.filter((w) => !w.virtual && !descendants.has(w.slug))
    return orderTreeWithDepth(real)
  }, [ws, workspaces])

  const movedToDifferentParent = ws && (ws.parent_slug ?? '') !== parentSlug

  async function onSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const payload = {
        name,
        description,
        color,
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>부서 편집</DialogTitle>
          <DialogDescription>
            슬러그(<code className="font-mono">{ws?.slug}</code>) 외 모든 항목 변경 가능.
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
            <select
              id="edit-parent"
              value={parentSlug}
              onChange={(e) => setParentSlug(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">(루트 — 본부)</option>
              {eligibleParents.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {'  '.repeat(p.depth)}
                  {p.depth > 0 ? '└ ' : ''}
                  {p.name} ({p.slug})
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              자기 자신 / 하위 부서는 선택할 수 없습니다 (트리 순환 방지).
              {movedToDifferentParent && (
                <span className="ml-1 text-amber-600">
                  ※ 저장 시 부서 위치가 이동합니다.
                </span>
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>설명</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>색상</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div className="space-y-1.5">
            <Label>정렬 순서</Label>
            <Input
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
              저장
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

  useEffect(() => {
    if (!open || !ws) {
      setBlockers(null)
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
  const canDelete = !loading && blockers && totalBlockers === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>부서 삭제</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{ws?.slug}</code> 부서를 삭제합니다.
          </DialogDescription>
        </DialogHeader>

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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={!canDelete}>
            삭제
          </Button>
        </DialogFooter>
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
function orderTreeWithDepth(workspaces) {
  const byParent = new Map()
  for (const w of workspaces) {
    const arr = byParent.get(w.parent_slug ?? null) ?? []
    arr.push(w)
    byParent.set(w.parent_slug ?? null, arr)
  }
  const out = []
  function walk(parentSlug, depth) {
    const children = byParent.get(parentSlug ?? null) ?? []
    children.sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))
    for (const c of children) {
      out.push({ ...c, depth })
      walk(c.slug, depth + 1)
    }
  }
  walk(null, 0)
  return out
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
