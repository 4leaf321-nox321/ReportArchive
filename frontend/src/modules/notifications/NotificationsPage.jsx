/** Full-page inbox — the bell popover only shows the most recent 30
 *  items; this page is where users come to scroll back through the
 *  full history. Cursor pagination keeps the request size flat even
 *  for noisy accounts.
 *
 *  Two filter tabs: 전체 / 안 읽음. Type-filter could come later if
 *  the inbox gets noisy enough to need it.
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bell,
  Check,
  CircleCheck,
  Layers,
  Loader2,
  Lock,
  MessageCircle,
  Send,
  Trash2,
  Unlock,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/shared/components/PageHeader'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { EmptyState } from '@/shared/components/EmptyState'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import {
  deleteAllRead,
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
} from '@/shared/api/notifications'
import { useAuth } from '@/shared/auth/AuthContext'
import { cn } from '@/shared/lib/utils'
import { notifyBadgesChanged } from '@/shared/lib/badgesEvents'

const PAGE_SIZE = 50

const TYPE_META = {
  'comment.new': { icon: MessageCircle, color: 'text-blue-600', label: '새 코멘트' },
  'comment.reply': { icon: MessageCircle, color: 'text-blue-600', label: '답글' },
  'comment.resolved': { icon: CircleCheck, color: 'text-green-600', label: '해결' },
  'comment.mention': { icon: MessageCircle, color: 'text-amber-600', label: '멘션' },
  'mount.new_to_me': { icon: Send, color: 'text-purple-600', label: '내 보고서 게시됨' },
  'mount.new_in_board': { icon: Send, color: 'text-purple-600', label: '새 보고서 게시' },
  'report.locked': { icon: Lock, color: 'text-red-600', label: '수정 잠금' },
  'report.lock_force_unset': { icon: Unlock, color: 'text-red-600', label: '잠금 강제 해제' },
  'report.phase_to_reviewing': { icon: MessageCircle, color: 'text-amber-600', label: '리뷰 단계 진입' },
  'report.phase_to_finalized': { icon: CircleCheck, color: 'text-green-600', label: '발행됨' },
  // Phase 5E — composite event family. All three jump to the composite
  // detail page via deepLinkFor below.
  'composite.included': { icon: Layers, color: 'text-indigo-600', label: '종합에 포함됨' },
  'composite.cited_upward': { icon: Layers, color: 'text-indigo-700', label: '상위 종합 인용' },
  'composite.published': { icon: CircleCheck, color: 'text-blue-600', label: '종합 발행됨' },
}

const TABS = [
  { key: 'all', label: '전체' },
  { key: 'unread', label: '안 읽음' },
]

export default function NotificationsPage() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = React.useState('all')
  const [items, setItems] = React.useState([])
  const [unreadCount, setUnreadCount] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(false)
  const [error, setError] = React.useState(null)

  const userId = me?.user?.id

  // Reload from page 1 whenever the tab changes (or on first mount).
  React.useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setItems([])
    setHasMore(false)
    listNotifications({
      limit: PAGE_SIZE,
      unreadOnly: tab === 'unread',
    })
      .then(({ items, unread_count }) => {
        if (cancelled) return
        setItems(items)
        setUnreadCount(unread_count)
        setHasMore(items.length === PAGE_SIZE)
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
  }, [userId, tab])

  async function loadMore() {
    if (loadingMore || items.length === 0) return
    setLoadingMore(true)
    try {
      const { items: rows } = await listNotifications({
        limit: PAGE_SIZE,
        unreadOnly: tab === 'unread',
        beforeId: items[items.length - 1].id,
      })
      setItems((prev) => [...prev, ...rows])
      setHasMore(rows.length === PAGE_SIZE)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleClick(n) {
    if (!n.read_at) {
      // Mark read fire-and-forget; reflect locally so the row updates
      // immediately without waiting for the round-trip.
      markRead(n.id).catch(() => {})
      setUnreadCount((u) => Math.max(0, u - 1))
      setItems((arr) =>
        arr.map((x) =>
          x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x,
        ),
      )
      // 사이드바 알림 배지 즉시 갱신 — 30초 폴링 주기 안 기다림.
      notifyBadgesChanged()
    }
    const url = deepLinkFor(n)
    if (url) navigate(url)
  }

  async function handleMarkAllRead() {
    await markAllRead()
    setUnreadCount(0)
    setItems((arr) =>
      arr.map((x) => (x.read_at ? x : { ...x, read_at: new Date().toISOString() })),
    )
    // Unread tab: list becomes empty after mark-all-read.
    if (tab === 'unread') setItems([])
    notifyBadgesChanged()
  }

  async function handleDeleteOne(n, evt) {
    // The row is wrapped in a button — without stopping the event the
    // delete also fires the row click (= navigate away). Same reason
    // for `preventDefault`.
    evt?.stopPropagation()
    evt?.preventDefault()
    const prev = items
    setItems((arr) => arr.filter((x) => x.id !== n.id))
    if (!n.read_at) {
      setUnreadCount((u) => Math.max(0, u - 1))
    }
    try {
      await deleteNotification(n.id)
      if (!n.read_at) notifyBadgesChanged()
    } catch (e) {
      // Rollback on failure.
      setItems(prev)
      if (!n.read_at) setUnreadCount((u) => u + 1)
      toast.error(e?.response?.data?.message || '삭제 실패')
    }
  }

  const [confirmDeleteRead, setConfirmDeleteRead] = React.useState(false)

  async function handleDeleteAllRead() {
    try {
      const res = await deleteAllRead()
      const removed = res?.deleted ?? 0
      setItems((arr) => arr.filter((x) => !x.read_at))
      toast.success(`읽은 알림 ${removed}건을 삭제했습니다.`)
      // 읽은 항목만 삭제하므로 unread 카운트는 안 바뀌지만 사이드바
      // 다른 데이터(예: 알림 총수)와 일관성 유지를 위해 가벼운 sync.
      notifyBadgesChanged()
    } catch (e) {
      toast.error(e?.response?.data?.message || '삭제 실패')
    }
  }

  // Bucket by day for separators — same UX as the activity timeline.
  const grouped = React.useMemo(() => groupByDay(items), [items])
  const hasRead = items.some((n) => n.read_at)

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="알림"
        description="이 계정으로 도착한 모든 알림. 클릭하면 해당 보고서로 이동합니다. 최근 1,000건까지 유지됩니다."
        actions={
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Button variant="outline" size="sm" onClick={handleMarkAllRead}>
                <Check className="mr-1 h-3 w-3" />
                모두 읽음
              </Button>
            )}
            {hasRead && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDeleteRead(true)}
                title="이미 읽은 알림을 모두 삭제합니다"
              >
                <Trash2 className="mr-1 h-3 w-3" />
                읽은 알림 삭제
              </Button>
            )}
          </div>
        }
      />
      <ConfirmDialog
        open={confirmDeleteRead}
        onOpenChange={setConfirmDeleteRead}
        title="읽은 알림 삭제"
        description="이미 읽은 알림을 모두 삭제합니다. 안 읽은 알림은 보존됩니다. 되돌릴 수 없습니다."
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={handleDeleteAllRead}
      />

      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.key === 'unread' && unreadCount > 0 && (
              <span className="ml-1.5 text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={tab === 'unread' ? '안 읽은 알림이 없습니다' : '알림이 없습니다'}
          description={
            tab === 'unread'
              ? '다 읽었어요. 새 활동이 생기면 여기에 표시됩니다.'
              : '코멘트, 게시, 잠금 등 활동이 생기면 여기에 모입니다.'
          }
        />
      ) : (
        <Card className="divide-y">
          {grouped.map(({ day, rows }) => (
            <React.Fragment key={day}>
              <div className="px-4 py-2 bg-muted/30 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                {day}
              </div>
              {rows.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  onClick={() => handleClick(n)}
                  onDelete={(e) => handleDeleteOne(n, e)}
                />
              ))}
            </React.Fragment>
          ))}
        </Card>
      )}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            이전 {PAGE_SIZE}개 더 보기
          </Button>
        </div>
      )}

      {!hasMore && items.length >= PAGE_SIZE && (
        <div className="text-center text-xs text-muted-foreground py-2">
          더 이상 알림이 없습니다.
        </div>
      )}
    </div>
  )
}

function NotificationRow({ n, onClick, onDelete }) {
  const meta = TYPE_META[n.type] ?? {
    icon: Bell,
    color: 'text-muted-foreground',
    label: n.type,
  }
  const Icon = meta.icon
  // Row is a div (not a button) so the nested trash button is valid
  // HTML. Keyboard accessibility: role=button + tabIndex + Enter/Space
  // listener gives equivalent affordance.
  function handleKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.()
    }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKey}
      className={cn(
        'group relative w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors cursor-pointer focus:outline-none focus:bg-muted/50',
        !n.read_at && 'bg-blue-50/30',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', meta.color)} />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="text-sm flex items-center gap-2">
          <span className="font-medium">{n.actor?.name ?? '시스템'}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{meta.label}</span>
          {!n.read_at && (
            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
          )}
        </div>
        {n.payload?.report_title && (
          <div className="text-sm text-foreground truncate">
            {n.payload.report_title}
          </div>
        )}
        {n.payload?.excerpt && (
          <div className="text-xs text-muted-foreground italic line-clamp-2">
            "{n.payload.excerpt}"
          </div>
        )}
        {n.workspace_slug && (
          <div className="text-[11px] text-muted-foreground">
            {n.workspace_slug}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="text-[11px] text-muted-foreground whitespace-nowrap">
          {formatRelative(n.created_at)}
        </div>
        <button
          type="button"
          onClick={onDelete}
          title="이 알림 삭제"
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded hover:bg-red-100 hover:text-red-600 transition-opacity"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function deepLinkFor(n) {
  // Mirror the bell's link logic so the user lands on the same place
  // whether they click from the popover or this page.
  if (n.ref_table === 'reports' || n.ref_table === 'comment_threads') {
    const reportId =
      n.ref_table === 'reports' ? n.ref_id : n.payload?.report_id
    if (!reportId) return null
    const ws = n.workspace_slug || 'personal'
    const base = `/w/${ws}/reports/${reportId}`
    if (n.ref_table === 'comment_threads' && n.ref_id) {
      return `${base}#thread=${n.ref_id}`
    }
    return base
  }
  // Phase 5E — composite.* notifications target the composite detail
  // page. ref_id IS the composite id; workspace_slug is stamped at
  // emit time (composite's workspace).
  if (n.ref_table === 'composite_reports' && n.ref_id) {
    const ws = n.workspace_slug
    if (!ws) return null
    return `/w/${ws}/composites/${n.ref_id}`
  }
  return null
}

function groupByDay(items) {
  const out = []
  let current = null
  for (const it of items) {
    const day = formatDay(it.created_at)
    if (!current || current.day !== day) {
      current = { day, rows: [] }
      out.push(current)
    }
    current.rows.push(it)
  }
  return out
}

function formatDay(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = dayKey(new Date().toISOString())
  const yesterdayDate = new Date()
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = dayKey(yesterdayDate.toISOString())
  if (dayKey(iso) === today) return '오늘'
  if (dayKey(iso) === yesterday) return '어제'
  return d.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

function dayKey(iso) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diff = (now - d) / 1000
  if (diff < 60) return '방금'
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}
