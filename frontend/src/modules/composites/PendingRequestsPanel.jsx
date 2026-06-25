import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Inbox } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { toast } from 'sonner'
import { useAsync } from '@/shared/hooks/useAsync'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import {
  acceptItemRequest,
  listItemRequests,
  rejectItemRequest,
} from '@/shared/api/composites'

/** 종합보고 "제출 대기" 패널 — 보고서 쪽에서 올라온 안건 제출(pending)을
 *  작성자가 승인(=안건 추가)/반려한다. pending 이 없으면 렌더 안 함. */
export function PendingRequestsPanel({ compositeId, canDecide, onAfterAccept }) {
  const { all: workspaces } = useWorkspace()
  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])

  const [reloadKey, setReloadKey] = useState(0)
  const { data, loading } = useAsync(
    () => listItemRequests(compositeId, 'pending'),
    [compositeId, reloadKey],
  )
  const requests = data ?? []
  const [open, setOpen] = useState(true)
  const [busyId, setBusyId] = useState(null)

  async function decide(reqId, action) {
    setBusyId(reqId)
    try {
      if (action === 'accept') {
        await acceptItemRequest(compositeId, reqId)
        toast.success('승인 — 안건으로 추가되었습니다.')
        onAfterAccept?.()
      } else {
        await rejectItemRequest(compositeId, reqId)
        toast.success('반려되었습니다.')
      }
      setReloadKey((k) => k + 1)
    } catch (e) {
      toast.error(e?.response?.data?.message || e.message || '처리 실패')
    } finally {
      setBusyId(null)
    }
  }

  // 로딩 중이거나 대기 건이 없으면 패널을 그리지 않는다(빈 영역 방지).
  if (loading && requests.length === 0) return null
  if (requests.length === 0) return null

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-amber-700" />
        ) : (
          <ChevronRight className="h-4 w-4 text-amber-700" />
        )}
        <Inbox className="h-4 w-4 text-amber-700" />
        <span className="text-sm font-semibold text-amber-900">
          제출 대기 {requests.length}건
        </span>
        {!canDecide && (
          <span className="ml-1 text-[11px] text-amber-700/80">
            (승인은 작성자·편집권자·조직 매니저만)
          </span>
        )}
      </button>
      {open && (
        <ul className="divide-y divide-amber-200/70 border-t border-amber-200/70">
          {requests.map((r) => {
            const rep = r.report
            const dept = rep?.owner_dept_slug
              ? workspaceName(rep.owner_dept_slug)
              : null
            return (
              <li
                key={r.id}
                className="flex items-start gap-3 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {rep?.title ?? `report #${r.ref_report_id}`}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                    {dept && (
                      <span>
                        <span className="text-muted-foreground/55">소속 </span>
                        {dept}
                      </span>
                    )}
                    {rep?.owner_name && (
                      <>
                        {dept && <span className="text-muted-foreground/30">·</span>}
                        <span>
                          <span className="text-muted-foreground/55">작성 </span>
                          {rep.owner_name}
                        </span>
                      </>
                    )}
                    <span className="text-muted-foreground/30">·</span>
                    <span>
                      <span className="text-muted-foreground/55">제출 </span>
                      {r.requested_by_name ?? '—'}
                    </span>
                  </div>
                  {r.note && (
                    <div className="mt-1 text-xs italic text-muted-foreground">
                      메모: {r.note}
                    </div>
                  )}
                </div>
                {canDecide && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      className="h-7"
                      onClick={() => decide(r.id, 'accept')}
                      disabled={busyId === r.id}
                    >
                      승인
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-destructive hover:text-destructive"
                      onClick={() => decide(r.id, 'reject')}
                      disabled={busyId === r.id}
                    >
                      반려
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
