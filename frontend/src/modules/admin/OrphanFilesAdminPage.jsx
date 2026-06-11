import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  FileQuestion,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
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
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listOrphanFiles, deleteOrphanFiles } from '@/shared/api/admin'

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

/**
 * 관리자 — 오펀(미참조) 업로드 파일 정리. 보고서에서 뺀 영상/이미지는 앱이 자동
 * 삭제하지 않아 디스크에 쌓이는데, 이 화면에서 어느 보고서도 참조하지 않는 파일을
 * 검색·선택해 지운다. 삭제 직전 서버가 다시 검증하므로(그 사이 참조/유예) 안전.
 */
export default function OrphanFilesAdminPage() {
  const { me } = useAuth()
  const isAdmin = me?.is_system_admin === true

  // 유예 기간(시간) — 최근 N시간 내 업로드 파일은 목록에서 보호. 0=즉시(보호 없음).
  // 막 올렸다 뺀 파일을 바로 확인하려면 낮춘다.
  const [graceHours, setGraceHours] = useState(48)
  const { data, loading, error, reload } = useAsync(
    () => (isAdmin ? listOrphanFiles({ graceHours }) : Promise.resolve(null)),
    [isAdmin, graceHours],
  )

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const items = useMemo(() => data?.items ?? [], [data])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (it) =>
        it.filename?.toLowerCase().includes(q) ||
        it.id?.toLowerCase().includes(q) ||
        it.workspace_slug?.toLowerCase().includes(q),
    )
  }, [items, query])

  const selectedItems = filtered.filter((it) => selected.has(it.id))
  const selectedBytes = selectedItems.reduce((a, it) => a + (it.size || 0), 0)
  const allShownSelected = filtered.length > 0 && filtered.every((it) => selected.has(it.id))

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
    setDeleting(true)
    try {
      const res = await deleteOrphanFiles(ids, { graceHours })
      const skipped = res.skipped?.length ?? 0
      toast.success(
        `${res.deleted}개 삭제 · ${human(res.freed_bytes)} 정리` +
          (skipped ? ` (건너뜀 ${skipped}개 — 그 사이 참조됨/유예)` : ''),
      )
      setSelected(new Set())
      reload()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '삭제에 실패했습니다.',
      )
    } finally {
      setDeleting(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="오펀 파일 정리" description="미참조 업로드 파일 관리" />
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
        title="오펀 파일 정리"
        description="어느 보고서·종합보고에서도 참조하지 않는 업로드 파일. 보고서에서 빼도 파일은 디스크에 남으므로, 여기서 확인·삭제해 용량을 회수합니다."
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileQuestion className="h-4 w-4" /> 미참조 파일
              </CardTitle>
              <CardDescription>
                {data
                  ? `오펀 ${data.total_count}개 · 합계 ${human(data.total_size)} · 참조됨 ${data.referenced_count} · 최근 ${data.grace_hours}h 보호 ${data.grace_protected}`
                  : '불러오는 중…'}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {data?.has_versions && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>
                버전 관리(report_versions)가 감지됐습니다. 옛 버전이 참조하는 파일까지
                확인해야 안전해, 현재는 삭제가 차단됩니다(버전 스캔 구현 필요).
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
              유예
              <select
                value={graceHours}
                onChange={(e) => {
                  setGraceHours(Number(e.target.value))
                  setSelected(new Set())
                }}
                title="최근 이 기간 내 업로드된 파일은 목록에서 보호합니다. 방금 뺀 파일을 바로 보려면 '즉시'로."
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                <option value={0}>즉시(보호 안 함)</option>
                <option value={24}>24시간</option>
                <option value={48}>48시간</option>
                <option value={168}>7일</option>
              </select>
            </label>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="파일명 · ID · 부서로 검색"
                className="h-9 pl-9"
              />
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={selected.size === 0 || deleting || data?.has_versions}
              onClick={() => setConfirmOpen(true)}
            >
              {deleting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              선택 삭제{selected.size ? ` (${selected.size} · ${human(selectedBytes)})` : ''}
            </Button>
          </div>

          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : error ? (
            <ErrorState description={error.message} onRetry={reload} />
          ) : filtered.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {items.length === 0 ? '오펀 파일이 없습니다.' : '검색 결과가 없습니다.'}
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
                    <th className="px-2 py-2 text-left font-medium">부서</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => (
                    <tr
                      key={it.id}
                      className="border-t hover:bg-muted/30 cursor-pointer"
                      onClick={() => toggle(it.id)}
                    >
                      <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(it.id)}
                          onChange={() => toggle(it.id)}
                          aria-label={it.filename}
                        />
                      </td>
                      <td className="px-2 py-1.5 max-w-[20rem] truncate" title={it.filename}>
                        {it.filename}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {human(it.size)}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        {(it.mime_type || '').split('/')[1] || it.mime_type || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        {(it.uploaded_at || '').slice(0, 10)}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        {it.workspace_slug || '—'}
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
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="오펀 파일 삭제"
        description={`선택한 ${selected.size}개 파일(${human(selectedBytes)})을 디스크와 DB에서 영구 삭제합니다. 되돌릴 수 없습니다. (삭제 직전 서버가 다시 검증해, 그 사이 보고서가 참조하게 됐거나 최근 업로드된 파일은 자동으로 건너뜁니다.)`}
        variant="destructive"
        confirmLabel="삭제"
        onConfirm={doDelete}
      />
    </div>
  )
}
