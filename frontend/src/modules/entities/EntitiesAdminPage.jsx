import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Combine,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  createEntity,
  deleteEntity,
  listEntities,
  listEntityTypes,
  mergeEntity,
  updateEntity,
} from '@/shared/api/entities'

/**
 * /admin/entities — admin-only management for the N-axis controlled
 * vocabulary. One sub-tab per axis (7 today, seeded by the backend
 * migration). Within an axis: search + 비활성 toggle + 추가 / 편집 /
 * 비활성·복원 / 머지 / 삭제.
 *
 * Backend gates the destructive actions on admin role, so a non-admin
 * who lands here via direct URL sees the data but their writes 403.
 * The sidebar entry itself is admin-only — this page is best-effort
 * accessible.
 */
export default function EntitiesAdminPage() {
  const {
    data: typesResp,
    loading: typesLoading,
    error: typesError,
  } = useAsync(() => listEntityTypes(), [])
  const types = typesResp?.items ?? []
  const [axisSlug, setAxisSlug] = useState(null)

  // Pick the first axis once the list arrives. Falls through cleanly on
  // re-mount because we treat null as "no axis chosen yet".
  useEffect(() => {
    if (axisSlug == null && types.length > 0) {
      setAxisSlug(types[0].slug)
    }
  }, [types, axisSlug])

  if (typesLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    )
  }
  if (typesError) {
    return (
      <div className="p-6">
        <ErrorState
          title="축 목록을 불러올 수 없습니다"
          description={typesError.message}
        />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="엔티티 관리"
        description="보고서를 태깅하는 N축 통제어휘. 사용자가 picker 에서 추가한 값을 정리/머지/비활성화 합니다."
      />

      <Tabs value={axisSlug ?? ''} onValueChange={setAxisSlug}>
        <TabsList className="w-fit flex-wrap h-auto">
          {types.map((t) => (
            <TabsTrigger key={t.slug} value={t.slug} className="text-xs">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {types.map((t) => (
          <TabsContent key={t.slug} value={t.slug} className="mt-4">
            {/* Mount fresh per axis (key on slug) so search/toggle/state
                resets when the admin switches tabs — keeps the mental
                model "each tab is its own grid". */}
            {axisSlug === t.slug && <AxisPanel key={t.slug} type={t} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

/**
 * The grid + dialogs for one axis. Owns its own reload counter so
 * mutations (create/update/merge/delete) reload only the current axis,
 * not the whole page.
 */
function AxisPanel({ type }) {
  const [reloadKey, setReloadKey] = useState(0)
  const [query, setQuery] = useState('')
  const [includeDeprecated, setIncludeDeprecated] = useState(true)

  const { data, loading, error } = useAsync(
    () =>
      listEntities({
        typeId: type.id,
        includeDeprecated,
        withUsage: true,
        limit: 500,
      }),
    [type.id, includeDeprecated, reloadKey],
  )
  const rows = data?.items ?? []
  // Client-side search across value/code/description — DataTable has its
  // own search box but we surface one in the toolbar above so it lives
  // alongside the "비활성 포함" toggle.
  const filteredRows = useMemo(() => {
    const n = query.trim().toLowerCase()
    if (!n) return rows
    return rows.filter(
      (r) =>
        r.value.toLowerCase().includes(n) ||
        (r.code ?? '').toLowerCase().includes(n) ||
        (r.description ?? '').toLowerCase().includes(n),
    )
  }, [rows, query])

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [mergeTarget, setMergeTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  function reload() {
    setReloadKey((n) => n + 1)
  }

  const columns = useMemo(
    () => [
      {
        key: 'value',
        header: '값',
        sortable: true,
        render: (r) => (
          <span
            className={
              r.status === 'deprecated'
                ? 'text-muted-foreground line-through'
                : 'font-medium'
            }
            title={r.description}
          >
            {r.value}
          </span>
        ),
      },
      {
        key: 'code',
        header: '코드',
        sortable: true,
        headerClassName: 'w-[120px]',
        render: (r) => (
          <span className="text-xs text-muted-foreground tabular-nums">
            {r.code ?? '—'}
          </span>
        ),
      },
      {
        key: 'status',
        header: '상태',
        sortable: true,
        headerClassName: 'w-[90px]',
        render: (r) =>
          r.status === 'active' ? (
            <Badge variant="secondary" className="text-[10px]">활성</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              비활성
            </Badge>
          ),
      },
      {
        key: 'usage_count',
        header: '사용',
        sortable: true,
        headerClassName: 'w-[80px] text-right',
        cellClassName: 'text-right',
        render: (r) => (
          <span className="text-xs tabular-nums">
            {r.usage_count ?? 0}건
          </span>
        ),
      },
      {
        key: 'created_at',
        header: '등록일',
        sortable: true,
        headerClassName: 'w-[110px]',
        render: (r) => (
          <span className="text-xs text-muted-foreground whitespace-nowrap font-mono">
            {formatDate(r.created_at)}
          </span>
        ),
      },
      {
        key: '_actions',
        header: '',
        headerClassName: 'w-[180px]',
        render: (r) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="편집"
              onClick={(e) => {
                e.stopPropagation()
                setEditTarget(r)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title={r.status === 'active' ? '비활성화' : '복원'}
              onClick={async (e) => {
                e.stopPropagation()
                try {
                  await updateEntity(r.id, {
                    status: r.status === 'active' ? 'deprecated' : 'active',
                  })
                  toast.success(
                    r.status === 'active'
                      ? `'${r.value}' 비활성화됨`
                      : `'${r.value}' 복원됨`,
                  )
                  reload()
                } catch (err) {
                  toast.error(err.message || '상태 변경 실패')
                }
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="다른 값으로 머지"
              onClick={(e) => {
                e.stopPropagation()
                setMergeTarget(r)
              }}
            >
              <Combine className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              title="삭제 (사용 중이면 차단)"
              onClick={(e) => {
                e.stopPropagation()
                setDeleteTarget(r)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
      },
    ],
    [],
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`${type.label} 검색 (값·코드·설명)`}
            className="h-8 pl-7 w-72 text-sm"
          />
        </div>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-xs">
          <input
            type="checkbox"
            checked={includeDeprecated}
            onChange={(e) => setIncludeDeprecated(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>비활성 포함</span>
        </label>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            추가
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-72" />
      ) : (
        <DataTable
          columns={columns}
          data={filteredRows}
          fixedLayout
          defaultSort={{ key: 'value', dir: 'asc' }}
          pageSizeStorageKey={`entities-${type.slug}`}
          searchableKeys={['value', 'code', 'description']}
          searchPlaceholder=""
        />
      )}

      {createOpen && (
        <EditDialog
          mode="create"
          type={type}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false)
            reload()
          }}
        />
      )}
      {editTarget && (
        <EditDialog
          mode="edit"
          type={type}
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null)
            reload()
          }}
        />
      )}
      {mergeTarget && (
        <MergeDialog
          type={type}
          source={mergeTarget}
          allRows={rows}
          onClose={() => setMergeTarget(null)}
          onMerged={() => {
            setMergeTarget(null)
            reload()
          }}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

/**
 * Create + edit share the same dialog — fields are identical
 * (value/code/description) and the only differences are the title and
 * the submit handler. `mode="create"` ignores `target`.
 */
function EditDialog({ mode, type, target, onClose, onSaved }) {
  const isCreate = mode === 'create'
  const [value, setValue] = useState(target?.value ?? '')
  const [code, setCode] = useState(target?.code ?? '')
  const [description, setDescription] = useState(target?.description ?? '')
  const [submitting, setSubmitting] = useState(false)

  const trimmedValue = value.trim()
  const canSubmit = trimmedValue.length > 0 && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      if (isCreate) {
        await createEntity({
          type_id: type.id,
          value: trimmedValue,
          code: code.trim() || undefined,
          description: description.trim(),
        })
        toast.success(`'${trimmedValue}' 추가됨`)
      } else {
        await updateEntity(target.id, {
          value: trimmedValue,
          code: code.trim() || '',
          description: description.trim(),
        })
        toast.success(`'${trimmedValue}' 수정됨`)
      }
      onSaved()
    } catch (err) {
      toast.error(err.message || '저장 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isCreate ? `${type.label} 추가` : `${type.label} 편집`}
          </DialogTitle>
          {!isCreate && target && (
            <DialogDescription className="text-xs">
              사용 중인 보고서 {target.usage_count ?? 0}건
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">값</Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={255}
              className="mt-1 h-9"
              autoFocus
            />
          </div>
          <div>
            <Label className="text-xs">코드 (선택)</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={64}
              className="mt-1 h-9"
              placeholder="예: AX-001"
            />
          </div>
          <div>
            <Label className="text-xs">설명 (선택)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? '저장 중...' : isCreate ? '추가' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Pick another value in the same axis as the merge target. Reuses the
 * already-fetched `allRows` so no extra request — admin lists everything
 * for the axis anyway. The source row is excluded from the pick list
 * (merging into itself is a no-op).
 */
function MergeDialog({ type, source, allRows, onClose, onMerged }) {
  const [intoId, setIntoId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const candidates = useMemo(
    () => allRows.filter((r) => r.id !== source.id),
    [allRows, source.id],
  )
  const target = candidates.find((r) => r.id === intoId)
  const canSubmit = !!target && !submitting

  async function handleMerge() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const res = await mergeEntity(source.id, intoId)
      toast.success(
        `'${source.value}' → '${target.value}' 머지 완료 (${res?.relinked_report_count ?? 0}건 재연결).`,
      )
      onMerged()
    } catch (err) {
      toast.error(err.message || '머지 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{type.label} 머지</DialogTitle>
          <DialogDescription className="text-xs">
            <strong>'{source.value}'</strong> 를 다른 값으로 합칩니다 —
            이 값을 사용하던 보고서들은 모두 선택한 대상 값으로 재연결되고,
            <strong>'{source.value}'</strong> 는 삭제됩니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs">합칠 대상</Label>
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {candidates.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                같은 축의 다른 값이 없습니다.
              </p>
            )}
            {candidates.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setIntoId(r.id)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                  intoId === r.id ? 'bg-accent' : ''
                }`}
              >
                <span
                  className={
                    r.status === 'deprecated'
                      ? 'text-muted-foreground line-through'
                      : ''
                  }
                >
                  {r.value}
                  {r.code && (
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      ({r.code})
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {r.usage_count ?? 0}건
                </span>
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button size="sm" onClick={handleMerge} disabled={!canSubmit}>
            {submitting ? '머지 중...' : '머지'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Hard-delete confirm. Backend returns 400 with the in-use message if
 * the value is still linked to reports; we surface that as a toast so
 * the admin knows to use merge/deprecate instead.
 */
function DeleteConfirmDialog({ target, onClose, onDeleted }) {
  const [submitting, setSubmitting] = useState(false)

  async function handleDelete() {
    setSubmitting(true)
    try {
      await deleteEntity(target.id)
      toast.success(`'${target.value}' 삭제됨`)
      onDeleted()
    } catch (err) {
      // The 400 from the in-use guard has its message in err.message
      // (axios client interceptor copies the envelope's `message`).
      toast.error(err.message || '삭제 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            삭제 확인
          </DialogTitle>
          <DialogDescription>
            <strong>'{target.value}'</strong> 를 완전히 삭제합니다. 이 값을
            사용 중인 보고서가 있으면 서버가 400으로 차단하니, 먼저 머지하거나
            비활성화 하세요.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={submitting}
          >
            {submitting ? '삭제 중...' : '삭제'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}
