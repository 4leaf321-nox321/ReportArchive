/** 받은 코멘트 inbox — "내가 owner 인 보고서에 달린 thread 모두".
 *
 *  알림(/notifications)이 이벤트 스트림(과거에 일어난 일)인 반면, 여기는
 *  현재 상태(아직 응답해야 할 thread) 큐다. 알림은 클릭하면 사라지지만
 *  inbox 항목은 resolve 될 때까지 남아 있다.
 *
 *  MVP 범위 (Phase 4D):
 *   - 탭: 미해결(open) / 전체(all)
 *   - 보고서 owner 인 thread 만. 멘션·답글 등 participant 시각의 row 는
 *     알림 페이지가 이미 잘 잡고 있으므로 중복 안 함.
 *   - 클릭 → 해당 보고서 detail 로 이동 (스크롤 to thread 는 추후 과제).
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Loader2,
  MessageCircle,
  Inbox as InboxIcon,
  ShieldCheck,
} from 'lucide-react'
import { PageHeader } from '@/shared/components/PageHeader'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { EmptyState } from '@/shared/components/EmptyState'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { listCommentsInbox } from '@/shared/api/comments'
import { useAuth } from '@/shared/auth/AuthContext'
import { cn } from '@/shared/lib/utils'

const PAGE_SIZE = 50

const TABS = [
  { key: 'open', label: '미해결' },
  { key: 'all', label: '전체' },
]

export default function InboxPage() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = React.useState('open')
  const [items, setItems] = React.useState([])
  const [openCount, setOpenCount] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(false)
  const [error, setError] = React.useState(null)

  const userId = me?.user?.id

  React.useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setItems([])
    setHasMore(false)
    listCommentsInbox({ status: tab, limit: PAGE_SIZE })
      .then(({ items: rows, openCount: oc }) => {
        if (cancelled) return
        setItems(rows)
        setOpenCount(oc)
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
  }, [userId, tab])

  async function loadMore() {
    if (loadingMore || items.length === 0) return
    setLoadingMore(true)
    try {
      const { items: rows } = await listCommentsInbox({
        status: tab,
        limit: PAGE_SIZE,
        beforeId: items[items.length - 1].thread_id,
      })
      setItems((prev) => [...prev, ...rows])
      setHasMore(rows.length === PAGE_SIZE)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  function handleClick(row) {
    navigate(
      `/w/${row.report_workspace_slug}/reports/${row.report_id}`,
    )
  }

  const grouped = React.useMemo(() => groupByDay(items), [items])

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="받은 코멘트"
        description="내가 작성한 보고서에 달린 코멘트 thread. 미해결은 응답하거나 resolve 할 때까지 여기에 남습니다."
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
            {t.key === 'open' && openCount > 0 && (
              <span className="ml-1.5 text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full">
                {openCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState description={error} />
      ) : loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title={
            tab === 'open'
              ? '미해결 코멘트가 없습니다'
              : '받은 코멘트가 없습니다'
          }
          description={
            tab === 'open'
              ? '깔끔합니다. 새 코멘트가 달리면 여기에 모입니다.'
              : '내 보고서에 누군가 코멘트를 달면 여기에 표시됩니다.'
          }
        />
      ) : (
        <Card className="divide-y">
          {grouped.map(({ day, rows }) => (
            <React.Fragment key={day}>
              <div className="px-4 py-2 bg-muted/30 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                {day}
              </div>
              {rows.map((row) => (
                <InboxRow
                  key={row.thread_id}
                  row={row}
                  onClick={() => handleClick(row)}
                />
              ))}
            </React.Fragment>
          ))}
          {hasMore && (
            <div className="p-3 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : null}
                더 불러오기
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function InboxRow({ row, onClick }) {
  const isResolved = row.status === 'resolved'
  const isLeadComment = row.author_role_at_creation === 'admin'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors',
        isResolved && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-3">
        <MessageCircle
          className={cn(
            'h-4 w-4 mt-0.5 shrink-0',
            isResolved ? 'text-muted-foreground' : 'text-blue-600',
          )}
        />
        <div className="flex-1 min-w-0">
          {/* 첫 줄: 보고서 제목 + 상태 + origin chip */}
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="font-medium text-sm truncate max-w-[40ch]" title={row.report_title}>
              {row.report_title || `보고서 #${row.report_id}`}
            </span>
            {isResolved && (
              <span className="inline-flex items-center gap-0.5 text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                해결됨
              </span>
            )}
            {row.origin_workspace_name && (
              <span className="inline-flex items-center text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                {row.origin_workspace_name}
              </span>
            )}
            {isLeadComment && (
              <span className="inline-flex items-center gap-0.5 text-[10px] bg-red-500/10 text-red-600 px-1.5 py-0.5 rounded font-medium">
                <ShieldCheck className="h-2.5 w-2.5" />
                보직장 의견
              </span>
            )}
            {row.total_comments > 1 && (
              <span className="text-[10px] text-muted-foreground">
                · 코멘트 {row.total_comments}개
              </span>
            )}
          </div>
          {/* 두번째 줄: 마지막 코멘트 미리보기 */}
          <p
            className="text-xs text-foreground/80 line-clamp-2"
            title={row.last_comment_excerpt}
          >
            {row.last_comment_excerpt || '(빈 코멘트)'}
          </p>
          {/* 세번째 줄: 작성자 · 시간 */}
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
            {row.last_comment_author?.name && (
              <span>{row.last_comment_author.name}</span>
            )}
            <span>·</span>
            <span>{formatRelativeTime(row.last_comment_at)}</span>
          </div>
        </div>
      </div>
    </button>
  )
}

/** Bucket items by their last_comment_at day (local time). Same shape
 *  the notifications page uses — keeps the visual rhythm consistent. */
function groupByDay(items) {
  const groups = new Map()
  for (const item of items) {
    const day = formatDay(item.last_comment_at)
    if (!groups.has(day)) groups.set(day, [])
    groups.get(day).push(item)
  }
  return [...groups.entries()].map(([day, rows]) => ({ day, rows }))
}

function formatDay(iso) {
  if (!iso) return '?'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatRelativeTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now - d
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return '방금'
  if (diffMin < 60) return `${diffMin}분 전`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}시간 전`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}일 전`
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
