import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ExternalLink,
  Link2Off,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  createEntity,
  createEntityType,
  deleteEntity,
  deleteEntityType,
  listEntities,
  listEntityTypes,
  listEntityUsage,
  mergeEntity,
  unlinkEntityFromAllReports,
  unlinkEntityFromReport,
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
    reload: reloadTypes,
  } = useAsync(() => listEntityTypes(), [])
  const types = typesResp?.items ?? []
  const [axisSlug, setAxisSlug] = useState(null)
  const [newAxisOpen, setNewAxisOpen] = useState(false)

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
        actions={
          <Button size="sm" onClick={() => setNewAxisOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            새 축 추가
          </Button>
        }
      />

      {/* 좌측 세로 리스트 + 우측 활성 축 패널. 가로 strip 으로 보이던
          이전 레이아웃은 축이 많아지면 줄바꿈이 어지러워 사용 어려웠음.
          왼쪽 컬럼은 max-h + overflow-y-auto 로 자체 스크롤, 오른쪽은
          페이지 흐름에 따라 자연스럽게 늘어남. */}
      <Tabs
        orientation="vertical"
        value={axisSlug ?? ''}
        onValueChange={setAxisSlug}
        className="flex gap-4 items-start"
      >
        <TabsList className="flex flex-col items-stretch h-auto w-44 shrink-0 max-h-[calc(100vh-180px)] overflow-y-auto">
          {types.map((t) => (
            <TabsTrigger
              key={t.slug}
              value={t.slug}
              className="justify-start text-xs whitespace-normal text-left"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex-1 min-w-0">
          {types.map((t) => (
            <TabsContent key={t.slug} value={t.slug} className="mt-0">
              {/* Mount fresh per axis (key on slug) so search/toggle/state
                  resets when the admin switches tabs — keeps the mental
                  model "each tab is its own grid". */}
              {axisSlug === t.slug && (
                <AxisPanel
                  key={t.slug}
                  type={t}
                  onAxisDeleted={() => {
                    // 다른 축으로 자동 전환 — 삭제 직후 사라진 탭에
                    // 머무를 수 없으므로 첫 번째로 이동(없으면 null).
                    // reloadTypes 가 끝나면 자연스럽게 첫 축이 재진입.
                    const remaining = types.filter((x) => x.id !== t.id)
                    setAxisSlug(remaining[0]?.slug ?? null)
                    reloadTypes()
                  }}
                />
              )}
            </TabsContent>
          ))}
        </div>
      </Tabs>

      {newAxisOpen && (
        <NewAxisDialog
          existingSlugs={types.map((t) => t.slug)}
          onClose={() => setNewAxisOpen(false)}
          onCreated={(created) => {
            setNewAxisOpen(false)
            // 새 축으로 즉시 전환 — 추가한 흐름에서 자연스럽게 그 축에서
            // 값을 등록하기 시작할 것이라 가정.
            setAxisSlug(created.slug)
            reloadTypes()
          }}
        />
      )}
    </div>
  )
}

/** 축 자체 삭제 확인 다이얼로그. 값이 0건이어야만 백엔드가 받아주므로
 *  안내 문구로 그 사실을 분명히 한다. 값을 직접 정리하지 않은 채 들어
 *  오면 destructive 버튼이 disable 되고, 사용자는 값 정리 후 재시도. */
function DeleteAxisDialog({ type, valueCount, onClose, onDeleted }) {
  const [submitting, setSubmitting] = useState(false)
  const canDelete = !submitting && valueCount === 0

  async function handleDelete() {
    if (!canDelete) return
    setSubmitting(true)
    try {
      await deleteEntityType(type.id)
      toast.success(`'${type.label}' 축 삭제됨`)
      onDeleted()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '삭제 실패')
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
            축 삭제 확인
          </DialogTitle>
          <DialogDescription>
            <strong>'{type.label}'</strong> 축({type.slug}) 자체를 삭제합니다.
            이 축에 속한 모든 picker 옵션이 함께 사라지고, 이미 이 축으로
            태깅된 보고서가 있는 경우엔 삭제할 수 없습니다.
          </DialogDescription>
        </DialogHeader>

        {valueCount > 0 ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs space-y-1.5">
            <p className="font-medium text-destructive">
              이 축에는 {valueCount}건의 값이 등록되어 있어 삭제할 수
              없습니다.
            </p>
            <p className="text-muted-foreground">
              값을 하나씩 삭제하거나 다른 축으로 머지해 0건이 된 뒤 다시
              시도하세요. (사용 중인 보고서가 있으면 그 값 자체부터
              머지하거나 비활성화해야 합니다.)
            </p>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            현재 등록된 값이 없습니다. 안전하게 삭제할 수 있습니다.
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={!canDelete}
            title={
              valueCount > 0
                ? '이 축에 등록된 값이 있어 삭제할 수 없습니다.'
                : undefined
            }
          >
            {submitting ? '삭제 중...' : '축 삭제'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 새 축(엔티티 타입) 추가 다이얼로그. label/slug 가 필수, 나머지는
 *  선택. slug 는 영어 소문자/숫자/언더스코어/대시만 — picker URL 의
 *  ?type= 파라미터로도 쓰일 수 있는 키이므로 안전한 식별자만 허용. */
function NewAxisDialog({ existingSlugs, onClose, onCreated }) {
  const [label, setLabel] = useState('')
  const [slug, setSlug] = useState('')
  // 사용자가 slug 를 직접 만지지 않은 동안엔 label 에서 자동 파생.
  const [slugTouched, setSlugTouched] = useState(false)
  const [icon, setIcon] = useState('')
  const [multi, setMulti] = useState(true)
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // label → slug 추정: 영문자만 남기고 lower-case + dash 정리. 한글
  // label 이면 결과가 비어서 사용자가 slug 를 직접 입력하게 됨.
  const autoSlug = useMemo(() => {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
  }, [label])

  const effectiveSlug = slugTouched ? slug.trim() : autoSlug
  const slugIsValid = /^[a-z0-9_-]+$/.test(effectiveSlug)
  const slugClash =
    !!effectiveSlug && existingSlugs.includes(effectiveSlug)
  const canSubmit =
    !submitting &&
    label.trim().length > 0 &&
    effectiveSlug.length > 0 &&
    slugIsValid &&
    !slugClash

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const created = await createEntityType({
        slug: effectiveSlug,
        label: label.trim(),
        icon: icon.trim(),
        multi,
        description: description.trim(),
      })
      toast.success(`'${created.label}' 축 추가됨`)
      onCreated(created)
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '추가 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>새 축 추가</DialogTitle>
          <DialogDescription className="text-xs">
            새 N축을 만들면 보고서 태그 picker 에 해당 축이 노출되어
            사용자가 값을 등록할 수 있게 됩니다. 축은 한 번 만들고 나면
            slug 가 식별자로 굳기 때문에 신중히 정해 주세요 (라벨/설명은
            추후 시드 마이그레이션 또는 별도 편집 기능으로 바꾸어야 함).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">라벨</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={64}
              autoFocus
              className="mt-1 h-9"
              placeholder="예: 시험 조건"
            />
          </div>
          <div>
            <Label className="text-xs">
              slug
              {!slugTouched && autoSlug && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  (라벨에서 자동 생성됨)
                </span>
              )}
            </Label>
            <Input
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value.toLowerCase())
              }}
              maxLength={32}
              className="mt-1 h-9 font-mono text-sm"
              placeholder="예: test_condition"
            />
            {effectiveSlug && !slugIsValid && (
              <p className="mt-1 text-[11px] text-destructive">
                소문자·숫자·언더스코어(_)·대시(-) 만 사용할 수 있습니다.
              </p>
            )}
            {slugClash && (
              <p className="mt-1 text-[11px] text-destructive">
                이미 같은 slug 의 축이 있습니다.
              </p>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={multi}
                onChange={(e) => setMulti(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span>다중 선택 허용</span>
            </label>
            <span className="text-[11px] text-muted-foreground">
              {multi
                ? '한 보고서에 여러 값을 태깅할 수 있음'
                : 'picker 가 단일 선택으로 동작 (DB 강제 아님)'}
            </span>
          </div>
          <div>
            <Label className="text-xs">
              아이콘 (선택, Lucide 이름)
            </Label>
            <Input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={32}
              className="mt-1 h-9"
              placeholder="예: Tags, FlaskConical"
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
              placeholder="이 축이 무엇을 분류하는지 — picker 에 hover 도움말로도 노출됨"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? '추가 중...' : '추가'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The grid + dialogs for one axis. Owns its own reload counter so
 * mutations (create/update/merge/delete) reload only the current axis,
 * not the whole page.
 */
function AxisPanel({ type, onAxisDeleted }) {
  const [reloadKey, setReloadKey] = useState(0)
  const [query, setQuery] = useState('')
  const [includeDeprecated, setIncludeDeprecated] = useState(true)
  const [deleteAxisOpen, setDeleteAxisOpen] = useState(false)

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
        render: (r) => <UsageCell entity={r} onReload={reload} />,
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
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            추가
          </Button>
          {/* 이 축 자체를 통째로 삭제. 값이 남아 있으면 백엔드가 400으로
              막고, 다이얼로그가 그 안내를 그대로 보여준다. */}
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteAxisOpen(true)}
            title="이 축(엔티티 타입) 자체를 삭제합니다"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            축 삭제
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
          onSwitchToMerge={() => {
            // Hand off to the merge dialog without losing context — the
            // common reason a delete is blocked is duplicate-cleanup, and
            // merge is the right next action.
            setMergeTarget(deleteTarget)
            setDeleteTarget(null)
          }}
        />
      )}
      {deleteAxisOpen && (
        <DeleteAxisDialog
          type={type}
          valueCount={rows.length}
          onClose={() => setDeleteAxisOpen(false)}
          onDeleted={() => {
            setDeleteAxisOpen(false)
            onAxisDeleted?.()
          }}
        />
      )}
    </div>
  )
}

/**
 * Usage-count cell. Renders "N건" — and when N > 0, clicking opens a
 * popover with the actual reports (id + title + workspace + updated)
 * so the admin can jump straight to any of them in a new tab. Reduces
 * the "왜 못 지우지?" guessing cost from O(grep the whole list) to a
 * single click.
 *
 * Each row also has a × that unlinks the entity from that one report
 * in place. After unlink we refetch the popover list AND call onReload
 * on the parent so the row's usage count + delete-button state stays
 * in sync.
 */
function UsageCell({ entity, onReload }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const count = entity.usage_count ?? 0

  function refetch() {
    setItems(null)
    setError(null)
    listEntityUsage(entity.id)
      .then((res) => setItems(res?.items ?? []))
      .catch((e) => setError(e))
  }

  useEffect(() => {
    if (!open || items !== null) return
    let cancelled = false
    listEntityUsage(entity.id)
      .then((res) => {
        if (!cancelled) setItems(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [open, items, entity.id])

  async function handleUnlink(reportId) {
    try {
      await unlinkEntityFromReport(entity.id, reportId)
      toast.success(`보고서 ${reportId} 에서 '${entity.value}' 태그 해제됨`)
      refetch()
      onReload?.()
    } catch (err) {
      toast.error(err.message || '태그 해제 실패')
    }
  }

  if (count <= 0) {
    return <span className="text-xs text-muted-foreground tabular-nums">0건</span>
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="text-xs tabular-nums underline-offset-2 hover:underline"
          title="이 값을 사용 중인 보고서 보기"
        >
          {count}건
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <UsageList items={items} error={error} onUnlink={handleUnlink} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Shared list rendering used by the cell popover, the delete-confirm
 * dialog, and the merge preview. Each item links out to the report in
 * a new tab (target=_blank) so the admin doesn't lose their place. When
 * `onUnlink(reportId)` is provided, each row also gets a small × button
 * so the admin can untag a single report inline — useful for surgical
 * fixes ("this one report has the wrong tag").
 */
function UsageList({
  items,
  error,
  emptyLabel = '사용 중인 보고서가 없습니다.',
  onUnlink,
}) {
  if (error) {
    return (
      <p className="text-xs text-destructive">
        목록을 불러올 수 없습니다.
      </p>
    )
  }
  if (items === null) {
    return (
      <p className="text-xs text-muted-foreground">불러오는 중...</p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{emptyLabel}</p>
    )
  }
  return (
    <ul className="max-h-72 overflow-y-auto divide-y">
      {items.map((r) => (
        <li key={r.id} className="flex items-stretch">
          <a
            href={`/w/${r.workspace_slug}/reports/${r.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-1 items-start justify-between gap-2 px-2 py-1.5 text-sm hover:bg-accent min-w-0"
            title={`${r.workspace_slug} · 수정 ${formatDate(r.updated_at)}`}
          >
            <span className="flex-1 truncate">{r.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
              {r.workspace_slug}
              <ExternalLink className="h-3 w-3" />
            </span>
          </a>
          {onUnlink && (
            <button
              type="button"
              onClick={() => onUnlink(r.id)}
              className="px-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="이 보고서에서 태그 해제"
            >
              <Link2Off className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
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
 * already-fetched `allRows` so no extra request for the candidate list
 * — admin lists everything for the axis anyway. The source row is
 * excluded from the pick list (merging into itself is a no-op).
 *
 * When the source has any usage, we also fetch the actual list of
 * affected reports so the admin can preview which reports will be
 * re-tagged before committing.
 */
function MergeDialog({ type, source, allRows, onClose, onMerged }) {
  const [intoId, setIntoId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [usage, setUsage] = useState(null) // null = loading | array
  const [usageError, setUsageError] = useState(null)
  const candidates = useMemo(
    () => allRows.filter((r) => r.id !== source.id),
    [allRows, source.id],
  )
  const target = candidates.find((r) => r.id === intoId)
  const canSubmit = !!target && !submitting
  const sourceUsage = source.usage_count ?? 0

  useEffect(() => {
    if (sourceUsage <= 0) {
      setUsage([]) // skip the network call when there's nothing to preview
      return
    }
    let cancelled = false
    listEntityUsage(source.id)
      .then((res) => {
        if (!cancelled) setUsage(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setUsageError(e)
      })
    return () => {
      cancelled = true
    }
  }, [source.id, sourceUsage])

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
        <div className="space-y-3">
          {sourceUsage > 0 && (
            <div className="rounded-md border bg-muted/30 p-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                재연결될 보고서 ({sourceUsage}건)
              </div>
              <UsageList items={usage} error={usageError} />
            </div>
          )}
          <div>
            <Label className="text-xs">합칠 대상</Label>
            <div className="mt-1 max-h-60 overflow-y-auto rounded-md border">
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
 * Hard-delete confirm. On open, fetches the actual list of reports using
 * this entity so the admin can see them inline (instead of getting a
 * bare "사용 중" error toast after clicking 삭제). When there's any
 * usage the destructive action is disabled and three escape routes
 * surface:
 *
 *   - 대신 머지   — consolidate with another value (preserves the tagging)
 *   - 태그 해제   — unlink from one report (×) or all reports (footer button);
 *                   the entity itself stays
 *   - 취소
 *
 * Once usage drops to 0 (via × or bulk-unlink), the 삭제 button enables.
 * The list and count refresh in place after each unlink so the admin
 * doesn't have to re-open the dialog.
 */
function DeleteConfirmDialog({ target, onClose, onDeleted, onSwitchToMerge }) {
  const [submitting, setSubmitting] = useState(false)
  const [unlinkingAll, setUnlinkingAll] = useState(false)
  const [usage, setUsage] = useState(null) // null = loading | array
  const [usageError, setUsageError] = useState(null)

  function refetchUsage() {
    setUsage(null)
    setUsageError(null)
    listEntityUsage(target.id)
      .then((res) => setUsage(res?.items ?? []))
      .catch((e) => setUsageError(e))
  }

  useEffect(() => {
    let cancelled = false
    listEntityUsage(target.id)
      .then((res) => {
        if (!cancelled) setUsage(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setUsageError(e)
      })
    return () => {
      cancelled = true
    }
  }, [target.id])

  // Server's count and our just-fetched list may diverge by 1–2 if a
  // concurrent edit landed between the grid load and now; we trust the
  // freshly-fetched list to drive the disabled state.
  const blockedByUsage = (usage?.length ?? 0) > 0 || usage === null
  const canDelete = !submitting && usage !== null && usage.length === 0

  async function handleUnlinkOne(reportId) {
    try {
      await unlinkEntityFromReport(target.id, reportId)
      toast.success(`보고서 ${reportId} 에서 '${target.value}' 태그 해제됨`)
      refetchUsage()
    } catch (err) {
      toast.error(err.message || '태그 해제 실패')
    }
  }

  async function handleUnlinkAll() {
    if (!usage || usage.length === 0) return
    setUnlinkingAll(true)
    try {
      const res = await unlinkEntityFromAllReports(target.id)
      toast.success(
        `${res?.removed_count ?? usage.length}건의 보고서에서 '${target.value}' 태그 해제됨`,
      )
      refetchUsage()
    } catch (err) {
      toast.error(err.message || '태그 해제 실패')
    } finally {
      setUnlinkingAll(false)
    }
  }

  async function handleDelete() {
    setSubmitting(true)
    try {
      await deleteEntity(target.id)
      toast.success(`'${target.value}' 삭제됨`)
      onDeleted()
    } catch (err) {
      // Defensive: a concurrent edit might have re-introduced usage
      // between our refetch and the delete call. Surface the server's
      // message verbatim in that case.
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
            <strong>'{target.value}'</strong> 를 완전히 삭제합니다.
            {usage !== null && usage.length === 0
              ? ' 사용 중인 보고서가 없어 안전하게 삭제할 수 있습니다.'
              : ' 사용 중인 보고서가 있으면 직접 삭제할 수 없습니다 — 머지하거나, 아래 ×/일괄 해제로 태그를 먼저 풀어주세요.'}
          </DialogDescription>
        </DialogHeader>

        {blockedByUsage && (
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                {usage === null
                  ? '사용 중인 보고서 확인 중...'
                  : `사용 중인 보고서 (${usage.length}건)`}
              </span>
              {usage !== null && usage.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={handleUnlinkAll}
                  disabled={unlinkingAll}
                  title="이 모든 보고서에서 태그만 해제 — 엔티티 자체는 남습니다"
                >
                  <Link2Off className="mr-1 h-3 w-3" />
                  {unlinkingAll ? '해제 중...' : '모두 해제'}
                </Button>
              )}
            </div>
            <UsageList
              items={usage}
              error={usageError}
              onUnlink={handleUnlinkOne}
            />
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          {usage !== null && usage.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={onSwitchToMerge}
              className="gap-1"
            >
              <Combine className="h-3.5 w-3.5" />
              대신 머지하기
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={!canDelete}
            title={
              usage !== null && usage.length > 0
                ? '사용 중인 보고서가 있어서 삭제할 수 없습니다.'
                : undefined
            }
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
