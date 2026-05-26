import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  FileType2,
  GripVertical,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { cn } from '@/shared/lib/utils'
import { toast } from 'sonner'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent } from '@/shared/components/ui/card'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ErrorState } from '@/shared/components/ErrorState'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  createComposite,
  deleteComposite,
  getComposite,
  publishComposite,
  unpublishComposite,
  updateComposite,
} from '@/shared/api/composites'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { KIND_LABEL, KIND_VARIANT, KINDS } from './constants'
import { ItemPickerDialog } from './ItemPickerDialog'
import { InlineCompositeView, InlineReportView } from './InlineReportView'

export default function CompositeDetailPage() {
  const { compositeId } = useParams()
  const navigate = useNavigate()
  const { slug, all: workspaces } = useWorkspace()
  const { me } = useAuth()

  // Gate the fetch on `slug` too — on a hard reload the URL gives us
  // `compositeId` immediately but the workspace context's
  // `setCurrentWorkspace()` runs in an effect, so firing the request
  // before that lands sends it without the `X-Workspace-Slug` header
  // → backend returns 400. ReportDetailPage uses the same gate.
  const { data: composite, loading, error, reload } = useAsync(
    () =>
      compositeId && slug
        ? getComposite(Number(compositeId))
        : Promise.resolve(null),
    [compositeId, slug],
  )

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  // Drag-and-drop state for item reorder. Declared up here with the
  // other hooks (not next to the reorderItems handler below) because
  // hooks must run in the same order every render — the component has
  // early returns for loading/error, so deferring these would skip
  // them on first render and surface as "Rendered more hooks than
  // during the previous render".
  const [draggingIdx, setDraggingIdx] = useState(null)
  const [dropOverIdx, setDropOverIdx] = useState(null)
  // DOCX export progress (same reason as drag state — must run on every
  // render). `null` when not exporting; otherwise the latest progress
  // event from exportCompositeToDocx.
  const [docxProgress, setDocxProgress] = useState(null)
  // Per-item expansion state, keyed by row index. Reset when the draft is
  // rebuilt so newly-added items start collapsed.
  const [expanded, setExpanded] = useState(new Set())

  // Snapshot existing → draft when the row loads or after a successful save.
  useEffect(() => {
    if (composite) {
      setDraft({
        title: composite.title,
        kind: composite.kind,
        period_date: composite.period_date ?? '',
        description: composite.description ?? '',
        items: composite.items.map((it) => ({
          // Server-side `id` is preserved on round-trip; new items omit it.
          note: it.note ?? '',
          ref_report_id: it.item_type === 'report' ? it.ref_report?.id : null,
          ref_composite_id: it.item_type === 'composite' ? it.ref_composite?.id : null,
          display_column: it.display_column ?? 1,
          // Cached display info for the table (not sent on save).
          _display: it,
        })),
      })
    }
  }, [composite])

  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])

  if (loading || !draft || !composite) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48" />
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

  async function onSave() {
    try {
      await updateComposite(composite.id, {
        title: draft.title,
        kind: draft.kind,
        period_date: draft.kind === 'recurring' ? draft.period_date || null : null,
        description: draft.description ?? '',
        items: draft.items.map((it) => ({
          note: it.note,
          ref_report_id: it.ref_report_id,
          ref_composite_id: it.ref_composite_id,
          display_column: it.display_column ?? 1,
        })),
      })
      toast.success('저장되었습니다.')
      setIsEditing(false)
      reload()
    } catch (err) {
      toast.error(err.message || '저장 실패')
    }
  }

  async function onDelete() {
    try {
      await deleteComposite(composite.id)
      toast.success('삭제되었습니다.')
      navigate(`/w/${slug}/composites`)
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  /** Clone the current composite into a new draft owned by the current
   *  user. Items (ref_report_id / ref_composite_id / note / display_column)
   *  carry over verbatim — published snapshots intentionally do NOT, so the
   *  copy starts as a live composite even when the source was 발행됨.
   *  period_date for recurring resets to today (same convention as report
   *  copy resetting report_date). New title comes from the dialog input;
   *  workspace stays the same as the source so the copy lives next to the
   *  original. After creation we navigate to the new composite. */
  async function onCopy(newTitle) {
    if (!composite) return
    try {
      const created = await createComposite({
        workspace_slug: composite.workspace_slug,
        title: newTitle,
        kind: composite.kind,
        period_date:
          composite.kind === 'recurring'
            ? new Date().toISOString().slice(0, 10)
            : null,
        description: composite.description ?? '',
        items: composite.items.map((it) => ({
          note: it.note ?? '',
          ref_report_id:
            it.item_type === 'report' ? it.ref_report?.id : null,
          ref_composite_id:
            it.item_type === 'composite' ? it.ref_composite?.id : null,
          display_column: it.display_column ?? 1,
        })),
      })
      toast.success('종합보고가 복사되었습니다.')
      setCopyOpen(false)
      // Navigate using the server-returned slug — same defensive move
      // ReportDetailPage uses, since the copy could land in a different
      // workspace if the user's permissions changed mid-request.
      navigate(`/w/${created.workspace_slug}/composites/${created.id}`)
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '복사 실패')
      throw err
    }
  }

  function addItems(newItems) {
    const existingKeys = new Set(
      draft.items.map((it) =>
        it.ref_report_id
          ? `r:${it.ref_report_id}`
          : `c:${it.ref_composite_id}`,
      ),
    )
    const additions = newItems.filter((it) => {
      const k = it.ref_report_id ? `r:${it.ref_report_id}` : `c:${it.ref_composite_id}`
      return !existingKeys.has(k)
    })
    // Auto-assign display_column alternating 1 ↔ 2 so a multi-item
    // add fills both Word-export columns instead of stacking
    // everything in col 1. Seed from the last existing item's column
    // so a prior manual reassignment is respected on the next add
    // (last in col 2 → next added starts at col 1, and so on).
    const lastCol =
      draft.items.length > 0
        ? (draft.items[draft.items.length - 1].display_column ?? 1)
        : 2 // sentinel so the very first added item lands in col 1
    let nextCol = lastCol === 1 ? 2 : 1
    const additionsWithCol = additions.map((it) => {
      const placed = {
        ...it,
        display_column: it.display_column ?? nextCol,
      }
      nextCol = nextCol === 1 ? 2 : 1
      return placed
    })
    setDraft({ ...draft, items: [...draft.items, ...additionsWithCol] })
  }
  function removeItem(idx) {
    setDraft({ ...draft, items: draft.items.filter((_, i) => i !== idx) })
  }
  function moveItem(idx, dir) {
    const next = [...draft.items]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setDraft({ ...draft, items: next })
  }
  // Drag-and-drop reorder (HTML5 native — same pattern as FolderSidebar
  // for consistency with the rest of the app). "Drop on row X" = insert
  // before X; dragging down through the splice math is the only edge
  // case worth noting. (State for this lives up with the other useState
  // calls — see comment there about hook order vs early returns.)
  function reorderItems(fromIdx, toIdx) {
    if (fromIdx === toIdx) return
    setDraft((d) => {
      if (!d) return d
      const next = [...d.items]
      const [moved] = next.splice(fromIdx, 1)
      // splice removal shifts later indices down by 1, so when moving
      // down (from < to) the target idx loses 1. Without this, dragging
      // A → C in [A, B, C, D] lands as [B, C, A, D] instead of [B, A,
      // C, D] which is what "drop on C" means visually.
      const adjustedToIdx = fromIdx < toIdx ? toIdx - 1 : toIdx
      next.splice(adjustedToIdx, 0, moved)
      return { ...d, items: next }
    })
  }
  function setItemNote(idx, note) {
    const next = draft.items.map((it, i) => (i === idx ? { ...it, note } : it))
    setDraft({ ...draft, items: next })
  }
  function setItemColumn(idx, col) {
    const next = draft.items.map((it, i) =>
      i === idx ? { ...it, display_column: col } : it,
    )
    setDraft({ ...draft, items: next })
  }

  // Phase 5A — publish state + handlers. theme composites stay live by
  // design so we don't surface publish UI for them (publish would only
  // stamp `published_at` without freezing anything — cosmetic only).
  const isPublished = Boolean(composite?.published_at)
  // (docxProgress state lives up top with the other useState calls —
  // see comment there about hook order vs early returns.)

  async function handleExportDocx(layoutChoice) {
    if (!composite) return
    setDocxProgress({ phase: 'start', label: '준비 중...' })
    try {
      const { exportCompositeToDocx } = await import('./exportCompositeToDocx')
      await exportCompositeToDocx({
        composite,
        layout: layoutChoice,
        onProgress: setDocxProgress,
      })
      toast.success('Word 파일로 저장했습니다.')
    } catch (err) {
      console.error(err)
      toast.error(`Word 저장 실패: ${err?.message ?? err}`)
    } finally {
      setDocxProgress(null)
    }
  }
  const isOwner = me?.user?.id && composite?.owner_user_id === me.user.id
  const isSysAdmin = me?.is_system_admin === true
  const canPublish =
    composite?.kind === 'recurring' && (isOwner || isSysAdmin)

  async function handlePublish() {
    try {
      await publishComposite(composite.id)
      toast.success('발행되었습니다. 모든 안건이 현 시점으로 박제됩니다.')
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '발행 실패')
    }
  }

  async function handleUnpublish() {
    try {
      await unpublishComposite(composite.id)
      toast.success('발행이 취소되었습니다.')
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '발행 취소 실패')
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="제목"
              className="border-0 px-0 text-2xl font-semibold focus-visible:ring-0 h-auto py-0"
            />
          ) : (
            <h1 className="text-2xl font-semibold truncate">{draft.title}</h1>
          )}
          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            <Layers className="h-3 w-3" />
            {isEditing ? (
              <KindToggle
                value={draft.kind}
                onChange={(v) => setDraft({ ...draft, kind: v })}
              />
            ) : (
              <Badge variant={KIND_VARIANT[draft.kind]} className="text-[10px]">
                {KIND_LABEL[draft.kind] ?? draft.kind}
              </Badge>
            )}
            {draft.kind === 'recurring' && (
              <span className="inline-flex items-center gap-1">
                <span>기준일</span>
                {isEditing ? (
                  <Input
                    type="date"
                    value={draft.period_date || ''}
                    onChange={(e) => setDraft({ ...draft, period_date: e.target.value })}
                    className="h-6 w-[140px] px-1.5 text-[11px] font-mono"
                  />
                ) : (
                  <span className="font-mono text-foreground/80">
                    {draft.period_date || '—'}
                  </span>
                )}
              </span>
            )}
            <span>· {workspaceName(composite.workspace_slug)}</span>
            <span>· 안건 {draft.items.length}건</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            작성 {composite.owner_name ?? '—'} · {composite.created_at?.slice(0, 10)}
            {composite.updated_at && composite.updated_at !== composite.created_at && (
              <> · 최근 수정 {composite.updated_by_name ?? '—'} · {composite.updated_at?.slice(0, 10)}</>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/w/${slug}/composites`)}>
          <ArrowLeft className="mr-1 h-3 w-3" />
          목록
        </Button>
        {isEditing ? (
          <>
            <Button variant="outline" size="sm" onClick={onSave}>
              <Save className="mr-1 h-3 w-3" />
              저장
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); reload() }}>
              <X className="mr-1 h-3 w-3" />
              취소
            </Button>
          </>
        ) : (
          <>
            {/* 편집 — recurring 발행 후엔 차단 (보고서 finalized 와 동일
                패턴). 발행 취소 후 편집해야 한다는 흐름을 강제. theme
                은 publish 개념이 없어 항상 편집 가능. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
              disabled={isPublished && composite?.kind === 'recurring'}
              title={
                isPublished && composite?.kind === 'recurring'
                  ? '발행된 종합보고는 편집할 수 없습니다. 발행 취소 후 수정하세요.'
                  : undefined
              }
            >
              <Pencil className="mr-1 h-3 w-3" />
              편집
            </Button>
            {/* 발행 / 발행 취소 — recurring + 작성자(또는 sys admin) 만.
                publish 는 그 시점 모든 item 의 ref_report content 를 박제
                → 6개월 뒤 봐도 발행 시점 그대로 보임. */}
            {canPublish && (
              <Button
                variant={isPublished ? 'secondary' : 'default'}
                size="sm"
                onClick={isPublished ? handleUnpublish : handlePublish}
              >
                {isPublished ? '발행 취소' : '발행'}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={Boolean(docxProgress)}>
                  <FileType2 className="mr-1 h-3 w-3" />
                  Word로 저장
                  <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => handleExportDocx('portrait-1col')}>
                  A4 세로 (한 열)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleExportDocx('landscape-2col')}>
                  A4 가로 (두 열)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* 복사 — 일반 보고서의 복사 패턴과 동일. 발행 여부와 무관하게
                항상 가능 (발행은 원본의 상태이고, 사본은 새 draft 로 시작). */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCopyOpen(true)}
            >
              <Copy className="mr-1 h-3 w-3" />
              복사
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1 h-3 w-3" />
              삭제
            </Button>
          </>
        )}
      </div>

      {/* 발행 배너 — recurring 발행 후만. 보고서의 phase=finalized 배너와
          비슷한 패턴. 발행 시각 + 누가 발행했는지 + 박제 의미 안내. */}
      {isPublished && composite?.kind === 'recurring' && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-900 px-4 py-2.5 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-[10px]">발행됨</Badge>
            <span className="text-foreground/80">
              {composite.published_at?.slice(0, 16).replace('T', ' ')}
              {composite.published_by_name &&
                ` · ${composite.published_by_name}`}
            </span>
            <span className="text-xs text-muted-foreground">
              이 시점의 안건 내용이 박제되어 있어 원본이 수정되어도 여기 표시는 그대로 유지됩니다.
            </span>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="pt-5 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground">설명</div>
          {isEditing ? (
            <Textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="이 종합보고의 맥락·요약을 자유롭게 작성하세요"
              rows={4}
            />
          ) : draft.description ? (
            <div className="text-sm whitespace-pre-wrap">{draft.description}</div>
          ) : (
            <div className="text-sm text-muted-foreground italic">설명 없음</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div className="text-sm font-semibold">포함된 안건</div>
              <div className="text-[11px] text-muted-foreground">
                보고서 또는 다른 종합보고를 선택해 추가
              </div>
            </div>
            <div className="flex items-center gap-2">
              {draft.items.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setExpanded((prev) =>
                      prev.size === draft.items.length
                        ? new Set()
                        : new Set(draft.items.map((_, i) => i)),
                    )
                  }}
                >
                  {expanded.size === draft.items.length ? (
                    <>
                      <ChevronRight className="mr-1 h-3 w-3" />
                      모두 접기
                    </>
                  ) : (
                    <>
                      <ChevronDown className="mr-1 h-3 w-3" />
                      모두 펼치기
                    </>
                  )}
                </Button>
              )}
              {isEditing && (
                <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                  <Plus className="mr-1 h-3 w-3" />
                  안건 추가
                </Button>
              )}
            </div>
          </div>
          {draft.items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              아직 추가된 안건이 없습니다.
            </p>
          ) : (
            <ul className="divide-y">
              {draft.items.map((it, idx) => (
                <ItemRow
                  key={`${it.ref_report_id ?? ''}-${it.ref_composite_id ?? ''}-${idx}`}
                  item={it}
                  index={idx}
                  editing={isEditing}
                  expanded={expanded.has(idx)}
                  onToggleExpand={() => {
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(idx)) next.delete(idx)
                      else next.add(idx)
                      return next
                    })
                  }}
                  workspaceName={workspaceName}
                  onMoveUp={() => moveItem(idx, -1)}
                  onMoveDown={() => moveItem(idx, +1)}
                  onRemove={() => removeItem(idx)}
                  onChangeNote={(n) => setItemNote(idx, n)}
                  displayColumn={it.display_column ?? 1}
                  onSetColumn={(c) => setItemColumn(idx, c)}
                  isDragging={draggingIdx === idx}
                  isDropTarget={
                    dropOverIdx === idx &&
                    draggingIdx !== null &&
                    draggingIdx !== idx
                  }
                  onDragStart={() => setDraggingIdx(idx)}
                  onDragOver={() => {
                    if (draggingIdx !== null && dropOverIdx !== idx) {
                      setDropOverIdx(idx)
                    }
                  }}
                  onDrop={() => {
                    if (draggingIdx !== null) reorderItems(draggingIdx, idx)
                    setDraggingIdx(null)
                    setDropOverIdx(null)
                  }}
                  onDragEnd={() => {
                    setDraggingIdx(null)
                    setDropOverIdx(null)
                  }}
                  onOpen={() => {
                    // Always navigate via the composite's workspace
                    // (= `slug`). The composite is in an org workspace
                    // and the report is mounted there (that's how it
                    // got picked as an item), so this slug always sees
                    // the report.
                    //
                    // The previous "prefer report's own workspace_slug"
                    // logic broke post-Phase-1: every report's home is
                    // `personal-{ownerId}`, which non-owner viewers
                    // can't enter (is_visible_to → 403). Composites
                    // are by definition shared, so the composite's
                    // workspace is the always-visible landing pad.
                    if (it.ref_report_id) {
                      navigate(`/w/${slug}/reports/${it.ref_report_id}`)
                    } else if (it.ref_composite_id) {
                      // Sub-composites land in their own workspace —
                      // those are real org workspaces, not personal.
                      const ws =
                        it._display?.ref_composite?.workspace_slug ?? slug
                      navigate(`/w/${ws}/composites/${it.ref_composite_id}`)
                    }
                  }}
                  total={draft.items.length}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ItemPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        excludeCompositeId={composite.id}
        existingItems={draft.items}
        onPick={(items) => {
          addItems(items)
          setPickerOpen(false)
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="종합보고 삭제"
        description="이 종합보고를 삭제하시겠습니까? 묶인 안건의 원본 보고서는 그대로 유지됩니다."
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={onDelete}
      />

      <CompositeCopyDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        sourceTitle={composite.title}
        sourceKind={composite.kind}
        onConfirm={onCopy}
      />

      {docxProgress && <DocxExportOverlay progress={docxProgress} />}
    </div>
  )
}

/** Asks the user for the new title before kicking off a copy. Pre-fills
 *  '{원본} 사본' so the common case is one Enter; trims and rejects empty.
 *  Mirrors ReportDetailPage's ReportCopyDialog — kept local to the
 *  composites module since the wording / hint copy differs slightly
 *  (recurring 의 period_date 도 오늘로 리셋된다는 안내). */
function CompositeCopyDialog({ open, onOpenChange, sourceTitle, sourceKind, onConfirm }) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      const base = (sourceTitle ?? '').trim()
      setTitle(base ? `${base} 사본` : '')
      setSubmitting(false)
    }
  }, [open, sourceTitle])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onConfirm(trimmed)
    } catch {
      // onConfirm surfaces its own toast on failure; keep the dialog
      // open so the user can retry with the same title.
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>종합보고 복사</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="composite-copy-title" className="text-sm font-medium">
              새 종합보고 제목
            </label>
            <Input
              id="composite-copy-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="새 제목"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted-foreground">
              안건·설명·열 배치는 그대로 복사되며, 작성인은 현재 사용자로
              설정됩니다.
              {sourceKind === 'recurring'
                ? ' 정기 기준일은 오늘로, 발행 상태는 초기화됩니다.'
                : ''}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? '복사 중...' : '복사'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Centered blocking spinner during composite DOCX export.
 *  Same shape as ReportDetailPage's overlay — pulled inline here to
 *  avoid cross-module import for one component. */
function DocxExportOverlay({ progress }) {
  const isBlock = progress.phase === 'block'
  const pct =
    isBlock && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : null
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="rounded-lg border bg-card shadow-xl px-6 py-5 min-w-[280px] max-w-sm">
        <div className="flex items-center gap-3 mb-2">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="font-semibold text-sm">Word 파일로 저장 중</div>
        </div>
        <div className="text-xs text-muted-foreground mb-2">
          {progress.label ?? '진행 중...'}
        </div>
        {isBlock && progress.total > 0 && (
          <>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
              {progress.current}/{progress.total} ({pct}%)
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function KindToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded border bg-background overflow-hidden h-6">
      {KINDS.map((k) => (
        <button
          key={k.value}
          type="button"
          onClick={() => onChange(k.value)}
          className={
            'px-2 text-[11px] transition-colors ' +
            (value === k.value
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-muted')
          }
        >
          {k.label}
        </button>
      ))}
    </div>
  )
}

function ItemRow({
  item,
  index,
  total,
  editing,
  expanded,
  onToggleExpand,
  workspaceName,
  onMoveUp,
  onMoveDown,
  onRemove,
  onChangeNote,
  onOpen,
  // Drag-and-drop reorder. Wired only when `editing` so view mode
  // stays read-only. `isDragging` dims the source row; `isDropTarget`
  // draws a primary-colored top border to show where the drop will
  // land (= insert before this row).
  isDragging,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  // Per-item layout column (1 = left, 2 = right). Only meaningful in
  // the landscape-2col DOCX export; portrait/1-col ignores it.
  displayColumn,
  onSetColumn,
}) {
  const isReport = Boolean(item.ref_report_id)
  const ref = isReport ? item._display?.ref_report : item._display?.ref_composite
  return (
    <li
      // Whole row is draggable while editing. Buttons/inputs inside
      // still fire their own click/focus events; HTML5 distinguishes
      // click (mousedown+up no movement) from drag (mousedown+move).
      // Setting draggable={false} explicitly on input prevents text-
      // selection-drag from hijacking the row drag.
      draggable={editing}
      onDragStart={editing ? onDragStart : undefined}
      onDragOver={
        editing
          ? (e) => {
              // preventDefault on dragover enables the drop. Required
              // by HTML5 spec — without it the browser refuses drop.
              e.preventDefault()
              onDragOver?.()
            }
          : undefined
      }
      onDrop={
        editing
          ? (e) => {
              e.preventDefault()
              onDrop?.()
            }
          : undefined
      }
      onDragEnd={editing ? onDragEnd : undefined}
      className={cn(
        'py-3 transition-colors',
        editing && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
        // Drop-target marker: thick primary top border = "drop lands
        // here, inserting before this row".
        isDropTarget && 'border-t-2 border-primary -mt-px',
      )}
    >
      <div className="flex items-start gap-2">
        {editing && (
          <span
            className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-muted-foreground h-5 w-5 flex items-center justify-center"
            aria-hidden="true"
            title="끌어서 순서 변경"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        )}
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-0.5 shrink-0 rounded hover:bg-muted h-5 w-5 flex items-center justify-center text-muted-foreground"
          aria-label={expanded ? '접기' : '펼치기'}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className="text-xs text-muted-foreground w-5 tabular-nums pt-0.5 shrink-0">
          {index + 1}.
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-[10px]">
              {isReport ? '보고서' : '종합'}
            </Badge>
            <button
              type="button"
              onClick={onOpen}
              className="font-medium text-sm hover:underline text-left truncate"
            >
              {ref?.title ?? (isReport ? `report #${item.ref_report_id}` : `composite #${item.ref_composite_id}`)}
            </button>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
            {ref?.workspace_slug && <span>{workspaceName(ref.workspace_slug)}</span>}
            {isReport && ref?.report_date && <span>· 기준 {ref.report_date}</span>}
            {!isReport && ref?.period_date && <span>· 기준 {ref.period_date}</span>}
            {ref?.owner_name && <span>· {ref.owner_name}</span>}
          </div>
          {(editing || item.note) && (
            <div className="mt-2">
              {editing ? (
                <Input
                  value={item.note}
                  onChange={(e) => onChangeNote(e.target.value)}
                  placeholder="이 안건에 대한 메모 (선택)"
                  className="h-8 text-xs"
                />
              ) : (
                <div className="text-xs text-muted-foreground italic">
                  메모: {item.note}
                </div>
              )}
            </div>
          )}
        </div>
        {editing && (
          <div className="flex items-center gap-0.5 shrink-0">
            {/* 1열 / 2열 토글 — 가로 2단 Word 내보내기에서 이 안건이 좌/우
                어느 컬럼에 들어갈지. 단일 column 내보내기에선 영향 없음
                이지만 사전 설정해 두면 편함. 클릭 한 번에 1↔2 토글. */}
            <button
              type="button"
              onClick={() => onSetColumn?.(displayColumn === 2 ? 1 : 2)}
              className={cn(
                'h-6 rounded border px-1.5 text-[10px] font-medium tabular-nums transition-colors',
                displayColumn === 2
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted',
              )}
              title={
                displayColumn === 2
                  ? '오른쪽 열 (클릭하면 왼쪽으로)'
                  : '왼쪽 열 (클릭하면 오른쪽으로)'
              }
              aria-label="2단 내보내기 열 선택"
            >
              {displayColumn === 2 ? '2열' : '1열'}
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onMoveUp}
              disabled={index === 0}
              aria-label="위로"
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onMoveDown}
              disabled={index === total - 1}
              aria-label="아래로"
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              onClick={onRemove}
              aria-label="제거"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="mt-3 ml-12 pl-4 border-l-2">
          {isReport && item.ref_report_id ? (
            // Phase 5A — pass snapshot when present. Published recurring
            // composites freeze each item's content into snapshot_content
            // so the as-of-publish state survives later edits to the
            // source report. Theme + unpublished recurring leave snapshot
            // NULL → live fetch via reportId.
            <InlineReportView
              reportId={item.ref_report_id}
              snapshot={item.snapshot_content ?? undefined}
            />
          ) : item.ref_composite_id ? (
            <InlineCompositeView compositeId={item.ref_composite_id} />
          ) : null}
        </div>
      )}
    </li>
  )
}
