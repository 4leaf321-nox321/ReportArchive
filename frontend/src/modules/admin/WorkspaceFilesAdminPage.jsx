import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  FolderInput,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  listWorkspaceFiles,
  bulkDeleteFiles,
  reassignFiles,
} from '@/shared/api/files'

function human(n) {
  let f = Number(n) || 0
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (f < 1024 || unit === 'TB') {
      return unit === 'B' ? `${Math.round(f)} B` : `${f.toFixed(1)} ${unit}`
    }
    f /= 1024
  }
  return `${f.toFixed(1)} TB`
}

// 참조 상태 배지 — 살아있는 보고서가 쓰면 삭제 위험(빨강), 이력/휴지통만이면
// 주황, 아무도 안 쓰면 회색. title 에 참조하는 보고서 제목을 나열한다.
function refTitle(it) {
  if (!it.references?.length) return '참조하는 보고서 없음'
  return it.references
    .map((r) => (r.deleted ? '🗑 ' : '') + (r.title || r.type))
    .join(', ')
}

/**
 * 관리자 — 한 부서가 소유한 파일 정리. files.workspace_slug=RESTRICT 라 부서에
 * 파일이 남으면 부서 삭제가 막힌다(조직개편·계정삭제_설계.md 후속). 여기서
 * 파일을 (a) 다른 부서로 이관하거나 (b) 일괄 삭제해 정리한다. 부서 삭제
 * 다이얼로그의 "파일" 숫자를 눌러 새 탭으로 열린다.
 */
export default function WorkspaceFilesAdminPage() {
  const { slug } = useParams()
  const { me } = useAuth()
  const { all } = useWorkspace()
  const isAdmin = me?.is_system_admin === true

  const { data, loading, error, reload } = useAsync(
    () => (isAdmin && slug ? listWorkspaceFiles(slug) : Promise.resolve(null)),
    [isAdmin, slug],
  )

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('')

  const wsName = useMemo(
    () => (all ?? []).find((w) => w.slug === slug)?.name ?? slug,
    [all, slug],
  )
  // 이관 대상 후보 — 실재 org 부서(가상/개인/보관/자기자신 제외).
  const targets = useMemo(
    () =>
      (all ?? []).filter(
        (w) =>
          !w.virtual &&
          w.kind !== 'personal' &&
          w.status !== 'archived' &&
          w.slug !== slug,
      ),
    [all, slug],
  )

  const items = useMemo(() => data?.items ?? [], [data])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (it) =>
        it.filename?.toLowerCase().includes(q) ||
        it.id?.toLowerCase().includes(q),
    )
  }, [items, query])

  const selectedItems = filtered.filter((it) => selected.has(it.id))
  const selectedBytes = selectedItems.reduce((a, it) => a + (it.size || 0), 0)
  const selectedLiveRefs = selectedItems.filter((it) => it.referenced_live).length
  const allShownSelected =
    filtered.length > 0 && filtered.every((it) => selected.has(it.id))

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleAllShown() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allShownSelected) filtered.forEach((it) => next.delete(it.id))
      else filtered.forEach((it) => next.add(it.id))
      return next
    })
  }

  async function doDelete() {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    try {
      const res = await bulkDeleteFiles(ids)
      toast.success(`${res.deleted}개 삭제 · ${human(res.freed_bytes)} 정리`)
      setSelected(new Set())
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || '삭제 실패')
    } finally {
      setBusy(false)
    }
  }

  async function doReassign() {
    const ids = [...selected]
    if (ids.length === 0 || !target) return
    setBusy(true)
    try {
      const res = await reassignFiles(ids, target)
      const tName = targets.find((w) => w.slug === target)?.name ?? target
      toast.success(`${res.reassigned}개 파일을 '${tName}'(으)로 이관했습니다.`)
      setSelected(new Set())
      setTarget('')
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || '이관 실패')
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="부서 파일 정리" description="부서가 소유한 업로드 파일 관리" />
        <ErrorState
          title="권한 없음"
          description="시스템 관리자만 접근할 수 있습니다."
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
    <div className="p-6 space-y-4 max-w-5xl">
      <PageHeader
        title="부서 파일 정리"
        description={`'${wsName}' 부서가 소유한 업로드 파일. 부서를 삭제하려면 이 파일들을 다른 부서로 이관하거나 삭제해야 합니다. 살아있는 보고서가 쓰는 파일을 지우면 그 보고서의 이미지·첨부가 깨지니, 개편(부서 병합)이라면 이관을 쓰세요.`}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FolderInput className="h-4 w-4" /> {wsName}
              </CardTitle>
              <CardDescription>
                {data
                  ? `파일 ${data.total_count}개 · 합계 ${human(data.total_size)}`
                  : '불러오는 중…'}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="파일명 · ID로 검색"
              className="h-9 pl-9"
            />
          </div>

          {/* 액션 바 — 이관(대상 선택) + 삭제. 선택이 있을 때만 활성. */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-2">
            <span className="text-xs text-muted-foreground">
              선택 {selected.size}개
              {selected.size ? ` · ${human(selectedBytes)}` : ''}
              {selectedLiveRefs ? ` · 사용 중 ${selectedLiveRefs}` : ''}
            </span>
            <div className="flex items-center gap-1.5 ml-auto">
              <WorkspaceCombobox
                workspaces={targets}
                value={target}
                onChange={setTarget}
                placeholder="이관 대상 부서…"
                compact
                className="w-56"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === 0 || !target || busy}
                onClick={doReassign}
              >
                {busy ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <FolderInput className="mr-1 h-4 w-4" />
                )}
                선택 이관
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={selected.size === 0 || busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                선택 삭제
              </Button>
            </div>
          </div>

          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : error ? (
            <ErrorState description={error.message} onRetry={reload} />
          ) : filtered.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {items.length === 0
                ? '이 부서가 소유한 파일이 없습니다.'
                : '검색 결과가 없습니다.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-2">
                      <input
                        type="checkbox"
                        checked={allShownSelected}
                        onChange={toggleAllShown}
                        aria-label="전체 선택"
                      />
                    </th>
                    <th className="px-2 py-2 text-left font-medium">파일명</th>
                    <th className="px-2 py-2 text-right font-medium">크기</th>
                    <th className="px-2 py-2 text-left font-medium">형식</th>
                    <th className="px-2 py-2 text-left font-medium">업로드</th>
                    <th className="px-2 py-2 text-left font-medium">참조</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => (
                    <tr
                      key={it.id}
                      className="border-t hover:bg-muted/30 cursor-pointer"
                      onClick={() => toggle(it.id)}
                    >
                      <td
                        className="px-2 py-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(it.id)}
                          onChange={() => toggle(it.id)}
                          aria-label={it.filename}
                        />
                      </td>
                      <td
                        className="px-2 py-1.5 max-w-[20rem] truncate"
                        title={it.filename}
                      >
                        {it.filename}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {human(it.size)}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        {(it.mime_type || '').split('/')[1] ||
                          it.mime_type ||
                          '—'}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        {(it.uploaded_at || '').slice(0, 10)}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap" title={refTitle(it)}>
                        {it.referenced_live ? (
                          <Badge variant="destructive">
                            사용 중 {it.reference_count}
                          </Badge>
                        ) : it.referenced_any ? (
                          <Badge variant="secondary">이력/휴지통만</Badge>
                        ) : (
                          <Badge variant="outline">미참조</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="파일 삭제"
        description={
          `선택한 ${selected.size}개 파일(${human(selectedBytes)})을 디스크와 DB에서 영구 삭제합니다. 되돌릴 수 없습니다.` +
          (selectedLiveRefs
            ? ` ⚠ 이 중 ${selectedLiveRefs}개는 살아있는 보고서가 사용 중이라, 삭제하면 그 보고서의 이미지·첨부가 깨집니다. 자료를 보존하려면 대신 '이관'을 쓰세요.`
            : '')
        }
        variant="destructive"
        confirmLabel="삭제"
        onConfirm={doDelete}
      />
    </div>
  )
}
