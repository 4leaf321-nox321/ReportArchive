import { useEffect, useState } from 'react'
import { History, RotateCcw, Loader2, Pin, Columns2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { InlineReportView } from '@/modules/composites/InlineReportView'
import {
  listReportVersions,
  getReportVersion,
  restoreReportVersion,
} from '@/modules/reports/api'
import { useReportTabs } from '@/shared/reports/ReportTabsContext'

// 'mcp'(AI 수정)·'baseline'(버전 기능 이전 보고서의 최초 스냅샷, p93)이
// 빠져 있어 원문 그대로 노출됐다. baseline 은 가지치기에서 제외돼 영구 보존된다.
const SOURCE_LABEL = {
  save: '저장',
  restore: '되돌림',
  publish: '게시',
  mcp: 'AI 수정',
  baseline: '최초',
}

function human(n) {
  let f = Number(n) || 0
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (f < 1024 || u === 'GB') return u === 'B' ? `${Math.round(f)} B` : `${f.toFixed(1)} ${u}`
    f /= 1024
  }
  return `${f.toFixed(1)} GB`
}
function fmt(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(ts)
  }
}

/**
 * 보고서 수정 이력 — 좌측 버전 타임라인 + 우측 선택 버전 미리보기(InlineReportView)
 * + "이 버전으로 되돌리기"(비파괴). 보기 모드의 더보기(⋯) 메뉴에서 연다.
 */
export function ReportVersionHistoryDialog({
  reportId,
  open,
  onOpenChange,
  onRestored,
  canEdit = true,
}) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)
  const [body, setBody] = useState(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const { setCompareVersion } = useReportTabs()

  // 선택한 버전을 우측 분할 패널에 띄워 현재 편집본과 나란히 비교한다(읽기전용).
  function openCompare() {
    if (!selected || !body) return
    setCompareVersion({
      reportId: String(reportId),
      versionId: selected.id,
      seq: selected.seq,
      source: selected.source,
      createdAt: selected.created_at,
      body,
    })
    onOpenChange(false)
  }

  useEffect(() => {
    if (!open || !reportId) return
    let cancelled = false
    setLoading(true)
    setSelected(null)
    setBody(null)
    listReportVersions(reportId, { limit: 100 })
      .then((d) => !cancelled && setVersions(Array.isArray(d) ? d : []))
      .catch(() => !cancelled && setVersions([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, reportId])

  function selectVersion(v) {
    setSelected(v)
    setBody(null)
    setBodyLoading(true)
    getReportVersion(reportId, v.id)
      .then((d) => setBody(d.body))
      .catch(() => toast.error('버전을 불러오지 못했습니다.'))
      .finally(() => setBodyLoading(false))
  }

  async function doRestore() {
    if (!selected) return
    setRestoring(true)
    try {
      await restoreReportVersion(reportId, selected.id)
      toast.success('이 버전으로 되돌렸습니다.')
      onOpenChange(false)
      onRestored?.()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '되돌리기에 실패했습니다.',
      )
    } finally {
      setRestoring(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl w-[80vw] h-[80vh] p-0 gap-0 flex flex-col overflow-hidden">
          <DialogHeader className="px-4 py-3 border-b">
            <DialogTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" /> 수정 이력
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-1 min-h-0">
            {/* 좌측 — 버전 타임라인 */}
            <div className="w-72 shrink-0 border-r overflow-y-auto">
              {loading ? (
                <div className="p-3 space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : versions.length === 0 ? (
                <p className="p-6 text-center text-xs text-muted-foreground">
                  아직 저장된 버전이 없습니다. 이후 저장부터 이력이 쌓입니다.
                </p>
              ) : (
                <ul className="divide-y">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => selectVersion(v)}
                        className={`w-full px-3 py-2 text-left transition-colors hover:bg-muted/50 ${
                          selected?.id === v.id ? 'bg-primary/10' : ''
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium tabular-nums">
                            #{v.seq}
                          </span>
                          <span
                            className={`rounded px-1 text-[10px] ${
                              v.source === 'restore'
                                ? 'bg-amber-500/15 text-amber-600'
                                : v.source === 'publish'
                                  ? 'bg-sky-500/15 text-sky-600'
                                  : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {SOURCE_LABEL[v.source] || v.source}
                          </span>
                          {v.is_pinned && <Pin className="h-3 w-3 text-primary" />}
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {human(v.body_bytes)}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {fmt(v.created_at)} · {v.author_name || '—'}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 우측 — 선택 버전 미리보기 */}
            <div className="flex flex-1 min-w-0 flex-col">
              {!selected ? (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  왼쪽에서 버전을 선택하면 그 시점의 내용을 미리봅니다.
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                    <div className="truncate text-xs text-muted-foreground">
                      #{selected.seq} · {fmt(selected.created_at)} ·{' '}
                      {SOURCE_LABEL[selected.source] || selected.source}
                      {selected.author_name ? ` · ${selected.author_name}` : ''}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={bodyLoading || !body}
                        onClick={openCompare}
                        title="이 버전을 우측 분할 화면에 띄워 현재 편집본과 비교"
                      >
                        <Columns2 className="mr-1 h-3.5 w-3.5" />
                        분할로 비교
                      </Button>
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={restoring || bodyLoading}
                          onClick={() => setConfirm(true)}
                        >
                          {restoring ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                          )}
                          이 버전으로 되돌리기
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto bg-muted/20 p-4">
                    {bodyLoading ? (
                      <Skeleton className="h-40 w-full" />
                    ) : body ? (
                      <InlineReportView snapshot={body} />
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="이 버전으로 되돌리기"
        description={`현재 내용을 이 버전(#${selected?.seq})으로 되돌립니다. 비파괴적이라 현재 상태도 이력에 남아 언제든 다시 되돌릴 수 있습니다.`}
        confirmLabel="되돌리기"
        onConfirm={doRestore}
      />
    </>
  )
}
