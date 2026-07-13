/** Bell icon with unread badge + dropdown of recent notifications.
 *
 *  Polling: 30s. Cheap GET /unread-count. Full list only fetched when
 *  the dropdown opens (avoids loading every payload until needed).
 *
 *  Click handling: each notification → navigate to the source. URL
 *  fragment carries thread_id so the report detail page can scroll
 *  + highlight. Marking-read is fire-and-forget on click.
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bell,
  Check,
  Layers,
  MessageCircle,
  Send,
  Siren,
  Lock,
  Unlock,
  CircleCheck,
  Loader2,
} from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
} from '@/shared/api/notifications'
import { useAuth } from '@/shared/auth/AuthContext'
import { cn } from '@/shared/lib/utils'
import {
  notifyBadgesChanged,
  subscribeBadgesChanged,
} from '@/shared/lib/badgesEvents'

const POLL_MS = 30_000

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
  // Phase 5E — composite event family. Deep-links to /w/{ws}/composites/{id}.
  'composite.included': { icon: Layers, color: 'text-indigo-600', label: '종합에 포함됨' },
  'composite.cited_upward': { icon: Layers, color: 'text-indigo-700', label: '상위 종합 인용' },
  'composite.published': { icon: CircleCheck, color: 'text-blue-600', label: '종합 발행됨' },
  // Phase D 경보 — /admin/alerts?rule={ref_id}.
  'alert.firing': { icon: Siren, color: 'text-red-600', label: '경보' },
}

export function NotificationBell() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const [unread, setUnread] = React.useState(0)
  const [open, setOpen] = React.useState(false)
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(false)

  // Poll unread count every 30s while logged in. Cheap endpoint.
  React.useEffect(() => {
    if (!me?.user?.id) return
    let cancelled = false
    async function tick() {
      try {
        const n = await getUnreadCount()
        if (!cancelled) setUnread(n)
      } catch {
        /* swallow; transient */
      }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    // mutation 후 즉시 동기화 — 사이드바와 동일 패턴.
    const unsubscribe = subscribeBadgesChanged(() => {
      if (!cancelled) tick()
    })
    return () => {
      cancelled = true
      clearInterval(id)
      unsubscribe()
    }
  }, [me?.user?.id])

  async function loadList() {
    setLoading(true)
    try {
      const { items, unread_count } = await listNotifications({ limit: 30 })
      setItems(items)
      setUnread(unread_count)
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    if (open) loadList()
  }, [open])

  async function handleClick(n) {
    // Mark read in the background — don't block navigation.
    if (!n.read_at) {
      markRead(n.id).catch(() => {})
      setUnread((u) => Math.max(0, u - 1))
      setItems((arr) =>
        arr.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)),
      )
      // 사이드바 배지도 즉시 동기화. markRead 가 백그라운드라서
      // 잠깐 동안은 서버 카운트가 아직 옛값이지만, 사이드바도 자체
      // 낙관 업데이트 없이 곧장 fetch 하므로 race 시 한 박자 늦게
      // 맞춰진다 (다음 폴링까지 stale 보단 훨씬 짧음).
      notifyBadgesChanged()
    }
    setOpen(false)
    const url = deepLinkFor(n)
    if (url) navigate(url)
  }

  if (!me?.user?.id) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative p-1.5 hover:bg-muted rounded-md"
          aria-label="알림"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="end">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-medium flex items-center gap-2">
            알림
            {unread > 0 && (
              <span className="text-xs text-muted-foreground">
                미확인 {unread}
              </span>
            )}
          </span>
          {unread > 0 && (
            <button
              type="button"
              onClick={async () => {
                await markAllRead()
                await loadList()
                notifyBadgesChanged()
              }}
              className="text-[11px] text-primary hover:underline flex items-center gap-1"
            >
              <Check className="h-3 w-3" />
              모두 읽음
            </button>
          )}
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">
              알림이 없습니다.
            </div>
          ) : (
            items.map((n) => {
              const meta = TYPE_META[n.type] ?? {
                icon: Bell,
                color: 'text-muted-foreground',
                label: n.type,
              }
              const Icon = meta.icon
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleClick(n)}
                  className={cn(
                    'w-full flex items-start gap-2 px-3 py-2 text-left border-b last:border-b-0 hover:bg-muted/50 transition-colors',
                    !n.read_at && 'bg-blue-50/50',
                  )}
                >
                  <Icon className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', meta.color)} />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="text-xs">
                      <span className="font-medium">{n.actor?.name ?? '시스템'}</span>
                      <span className="text-muted-foreground"> · {meta.label}</span>
                    </div>
                    {n.payload?.report_title && (
                      <div className="text-[11px] text-foreground truncate">
                        {n.payload.report_title}
                      </div>
                    )}
                    {n.payload?.excerpt && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        "{n.payload.excerpt}"
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground">
                      {formatRelative(n.created_at)}
                    </div>
                  </div>
                  {!n.read_at && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0 mt-2" />
                  )}
                </button>
              )
            })
          )}
        </div>
        <div className="border-t px-3 py-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate('/notifications')
            }}
            className="w-full text-xs text-primary hover:underline text-center"
          >
            전체 알림 보기
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function deepLinkFor(n) {
  // ref_table='reports' → /w/{ws or personal}/reports/{ref_id}
  // For comment events, append #thread=<id> so the detail page scrolls.
  if (n.ref_table === 'reports' || n.ref_table === 'comment_threads') {
    const reportId =
      n.ref_table === 'reports'
        ? n.ref_id
        : n.payload?.report_id
    if (!reportId) return null
    const ws = n.workspace_slug || 'personal'
    const base = `/w/${ws}/reports/${reportId}`
    if (n.ref_table === 'comment_threads' && n.ref_id) {
      return `${base}#thread=${n.ref_id}`
    }
    return base
  }
  // Phase 5E — composite.* lands on the composite detail page.
  if (n.ref_table === 'composite_reports' && n.ref_id) {
    const ws = n.workspace_slug
    if (!ws) return null
    return `/w/${ws}/composites/${n.ref_id}`
  }
  // Phase D 경보 — 규칙별 경보 페이지로.
  if (n.ref_table === 'alert_rules' && n.ref_id) {
    return `/admin/alerts?rule=${n.ref_id}`
  }
  return null
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
