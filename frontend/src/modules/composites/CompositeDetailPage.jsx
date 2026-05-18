import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Layers,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent } from '@/shared/components/ui/card'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ErrorState } from '@/shared/components/ErrorState'
import { PageWidthToggle, usePageWidth } from '@/shared/components/PageWidthToggle'
import { cn } from '@/shared/lib/utils'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  deleteComposite,
  getComposite,
  updateComposite,
} from '@/shared/api/composites'
import { KIND_LABEL, KIND_VARIANT, KINDS } from './constants'
import { ItemPickerDialog } from './ItemPickerDialog'
import { InlineCompositeView, InlineReportView } from './InlineReportView'

export default function CompositeDetailPage() {
  const { compositeId } = useParams()
  const navigate = useNavigate()
  const { slug, all: workspaces } = useWorkspace()

  const { data: composite, loading, error, reload } = useAsync(
    () => (compositeId ? getComposite(Number(compositeId)) : Promise.resolve(null)),
    [compositeId],
  )

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pageWidth, setPageWidth] = usePageWidth()
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
    setDraft({ ...draft, items: [...draft.items, ...additions] })
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
  function setItemNote(idx, note) {
    const next = draft.items.map((it, i) => (i === idx ? { ...it, note } : it))
    setDraft({ ...draft, items: next })
  }

  return (
    <div className={cn('p-6 space-y-6', pageWidth === 'narrow' && 'max-w-5xl')}>
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
        <PageWidthToggle value={pageWidth} onChange={setPageWidth} />
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
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
              <Pencil className="mr-1 h-3 w-3" />
              편집
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1 h-3 w-3" />
              삭제
            </Button>
          </>
        )}
      </div>

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
                  onOpen={() => {
                    if (it.ref_report_id) {
                      const ws = it._display?.ref_report?.workspace_slug ?? slug
                      navigate(`/w/${ws}/reports/${it.ref_report_id}`)
                    } else if (it.ref_composite_id) {
                      const ws = it._display?.ref_composite?.workspace_slug ?? slug
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
}) {
  const isReport = Boolean(item.ref_report_id)
  const ref = isReport ? item._display?.ref_report : item._display?.ref_composite
  return (
    <li className="py-3">
      <div className="flex items-start gap-2">
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
            <InlineReportView reportId={item.ref_report_id} />
          ) : item.ref_composite_id ? (
            <InlineCompositeView compositeId={item.ref_composite_id} />
          ) : null}
        </div>
      )}
    </li>
  )
}
