/** Activity timeline — chronological event log for a single report.
 *
 *  Opened as a modal Dialog (large) from the report detail header.
 *  Cursor-paginated: backend exposes `before_id` so we can keep loading
 *  older activity in batches without the "offset gets larger every
 *  scroll" problem.
 *
 *  Fetched on open (not on report load) — most users won't look until
 *  there's a reason, so don't pay the round trip until clicked.
 */
import * as React from 'react'
import {
  Activity,
  CircleCheck,
  Edit3,
  Folder,
  Loader2,
  Lock,
  MessageCircle,
  Send,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { listActivities } from '@/shared/api/activities'
import { cn } from '@/shared/lib/utils'

const PAGE_SIZE = 50

const TYPE_META = {
  created: { icon: Sparkles, color: 'text-blue-600', label: '보고서 생성' },
  edited: { icon: Edit3, color: 'text-foreground', label: '편집' },
  comment_added: { icon: MessageCircle, color: 'text-blue-600', label: '코멘트 추가' },
  comment_replied: { icon: MessageCircle, color: 'text-blue-600', label: '답글' },
  thread_resolved: { icon: CircleCheck, color: 'text-green-600', label: '스레드 해결' },
  thread_reopened: { icon: MessageCircle, color: 'text-amber-600', label: '스레드 재오픈' },
  phase_to_reviewing: { icon: Activity, color: 'text-amber-600', label: '리뷰 단계 진입' },
  phase_to_finalized: { icon: CircleCheck, color: 'text-green-600', label: '발행' },
  phase_to_drafting: { icon: Activity, color: 'text-muted-foreground', label: '작성 모드 복귀' },
  mounted: { icon: Send, color: 'text-purple-600', label: '게시판에 게시' },
  unmounted: { icon: Send, color: 'text-muted-foreground', label: '게시 해제' },
  mount_folder_changed: { icon: Folder, color: 'text-amber-600', label: '게시판 폴더 이동' },
  folder_changed: { icon: Folder, color: 'text-amber-600', label: '폴더 이동' },
  locked: { icon: Lock, color: 'text-red-600', label: '수정 잠금' },
  unlocked: { icon: Unlock, color: 'text-green-600', label: '잠금 해제' },
  lock_force_unset: { icon: Unlock, color: 'text-red-600', label: '잠금 강제 해제 (admin)' },
}

export function ActivityTimelineButton({ reportId }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        title="활동 이력"
        onClick={() => setOpen(true)}
      >
        <Activity className="mr-1 h-3 w-3" />
        활동
      </Button>
      <ActivityTimelineDialog
        reportId={reportId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}

function ActivityTimelineDialog({ reportId, open, onOpenChange }) {
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState(null)
  // `hasMore` tracks whether the last batch came back full (=> probably
  // more pages); false means we hit the end and the "더 보기" button
  // disappears.
  const [hasMore, setHasMore] = React.useState(false)

  // Initial load — runs on first open. Reset state each time the
  // dialog opens so a stale list from a previous report isn't shown.
  React.useEffect(() => {
    if (!open || !reportId) return
    let cancelled = false
    setItems([])
    setError(null)
    setHasMore(false)
    setLoading(true)
    listActivities(reportId, { limit: PAGE_SIZE })
      .then((rows) => {
        if (cancelled) return
        setItems(rows)
        setHasMore(rows.length === PAGE_SIZE)
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, reportId])

  async function loadMore() {
    if (loadingMore || items.length === 0) return
    setLoadingMore(true)
    const beforeId = items[items.length - 1].id
    try {
      const rows = await listActivities(reportId, {
        limit: PAGE_SIZE,
        beforeId,
      })
      setItems((prev) => [...prev, ...rows])
      setHasMore(rows.length === PAGE_SIZE)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            활동 이력
          </DialogTitle>
          <DialogDescription className="text-xs">
            이 보고서에서 일어난 모든 변경 — 코멘트, phase 전환, 게시,
            폴더 이동, 잠금 등. 최신이 위.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-sm text-destructive p-3">{error}</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center">
              아직 활동이 없습니다.
            </div>
          ) : (
            <ul className="space-y-0">
              {items.map((it, idx) => {
                const meta = TYPE_META[it.type] ?? {
                  icon: Activity,
                  color: 'text-muted-foreground',
                  label: it.type,
                }
                const Icon = meta.icon
                // Day separator — when the date part of consecutive
                // items differs, drop in a small heading.
                const showDate =
                  idx === 0 || dayKey(items[idx - 1].created_at) !== dayKey(it.created_at)
                return (
                  <React.Fragment key={it.id}>
                    {showDate && (
                      <li className="sticky top-0 z-10 bg-background py-1.5 mt-2 first:mt-0">
                        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          {formatDay(it.created_at)}
                        </div>
                      </li>
                    )}
                    <li className="flex items-start gap-3 py-2 border-l-2 border-muted pl-3 ml-1 hover:bg-muted/30 -mx-2 px-3 rounded-r">
                      <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', meta.color)} />
                      <div className="flex-1 min-w-0 text-sm">
                        <div>
                          <span className="font-medium">
                            {it.actor?.name ?? '시스템'}
                          </span>
                          <span className="text-muted-foreground">
                            {' '}· {meta.label}
                          </span>
                        </div>
                        {renderPayloadHint(it)}
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {formatTime(it.created_at)}
                        </div>
                      </div>
                    </li>
                  </React.Fragment>
                )
              })}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {items.length}건 표시
            {hasMore && ' · 더 있음'}
          </span>
          <div className="flex items-center gap-2">
            {hasMore && (
              <Button
                size="sm"
                variant="outline"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : null}
                이전 {PAGE_SIZE}개 더 보기
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              <X className="h-3 w-3 mr-1" />
              닫기
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function renderPayloadHint(it) {
  const p = it.payload || {}
  if (it.type === 'comment_added' || it.type === 'comment_replied') {
    if (p.excerpt) {
      return (
        <div className="text-xs text-muted-foreground italic mt-0.5 line-clamp-2">
          "{p.excerpt}"
        </div>
      )
    }
  }
  if (it.type === 'mounted' || it.type === 'unmounted') {
    if (p.workspace_slug) {
      return (
        <div className="text-xs text-muted-foreground mt-0.5">
          {p.workspace_slug}
        </div>
      )
    }
  }
  if (it.type === 'locked' && p.reason) {
    return (
      <div className="text-xs text-muted-foreground italic mt-0.5">
        사유: {p.reason}
      </div>
    )
  }
  if (it.type === 'phase_to_reviewing' && p.trigger) {
    return (
      <div className="text-xs text-muted-foreground mt-0.5">
        ({p.trigger === 'comment' ? '첫 외부 코멘트' : p.trigger})
      </div>
    )
  }
  return null
}

function dayKey(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatDay(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (dayKey(iso) === dayKey(today.toISOString())) return '오늘'
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return '어제'
  return d.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}
