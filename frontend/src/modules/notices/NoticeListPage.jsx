import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Megaphone,
  Paperclip,
  Pin,
  Plus,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Card, CardContent } from '@/shared/components/ui/card'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAuth } from '@/shared/auth/AuthContext'
import { listNotices } from '@/shared/api/notices'
import { noticeMonthDay } from './constants'
import { NoticeNewDialog } from './NoticeNewDialog'

// 한 페이지에 보여줄 공지 수 — 일반적인 게시판 감각에 맞춘 20행.
const PAGE_SIZE = 20

/** 공지 게시판 목록 — 페이지 단위 네비게이션 + 컬럼 헤더 + 페이지 내 검색.
 *  상단 고정(pinned) 공지가 맨 위로, 그 다음 최신순(서버 정렬). 작성은
 *  시스템 관리자만 가능하므로 '새 공지' 버튼도 관리자에게만 노출한다. */
export default function NoticeListPage() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const isAdmin = me?.is_system_admin === true

  const [query, setQuery] = useState('')
  const [newOpen, setNewOpen] = useState(false)

  const [page, setPage] = useState(1) // 1-indexed
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listNotices({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then((res) => {
        if (cancelled) return
        setItems(res.items ?? [])
        setTotal(res.total ?? 0)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [page])

  // 게시판 번호 부여 — 가장 최근(위쪽) 항목이 total, 아래로 갈수록 감소.
  const numbered = items.map((p, i) => ({
    ...p,
    _number: Math.max(0, total - (page - 1) * PAGE_SIZE - i),
  }))

  // 페이지 안에서만 적용되는 텍스트 필터.
  const filtered = query.trim()
    ? numbered.filter((p) => {
        const q = query.toLowerCase()
        return (
          p.title.toLowerCase().includes(q) ||
          (p.body ?? '').toLowerCase().includes(q) ||
          (p.author?.name ?? '').toLowerCase().includes(q)
        )
      })
    : numbered

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const firstIdx = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const lastIdx = Math.min(page * PAGE_SIZE, total)

  return (
    <div className="p-6 space-y-4 max-w-[1500px] mx-auto w-full">
      <PageHeader
        title="공지"
        description="전체 사용자에게 전달되는 공지사항"
        actions={
          isAdmin ? (
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              새 공지
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="현재 페이지 안에서 검색"
          className="h-9 max-w-xs"
        />
      </div>

      {error ? (
        <ErrorState description={error.message} onRetry={() => setPage((p) => p)} />
      ) : (
        <div className="border rounded-md overflow-hidden">
          <ColumnHeader />
          {loading ? (
            <div className="p-6">
              <Skeleton className="h-48" />
            </div>
          ) : filtered.length === 0 ? (
            <Card className="border-0 rounded-none shadow-none">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                <Megaphone className="mx-auto mb-2 h-6 w-6 opacity-50" />
                {total === 0
                  ? '등록된 공지가 없습니다.'
                  : query.trim()
                    ? '현재 페이지 안에서 매칭되는 공지가 없습니다.'
                    : '현재 페이지에 표시할 공지가 없습니다.'}
              </CardContent>
            </Card>
          ) : (
            <div>
              {filtered.map((p) => (
                <NoticeRow
                  key={p.id}
                  notice={p}
                  onClick={() => navigate(`/notices/${p.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        onChange={setPage}
        firstIdx={firstIdx}
        lastIdx={lastIdx}
        total={total}
      />

      <NoticeNewDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(created) => {
          setNewOpen(false)
          navigate(`/notices/${created.id}`)
        }}
      />
    </div>
  )
}

function ColumnHeader() {
  return (
    <div className="grid grid-cols-12 gap-3 px-3 py-2 bg-muted/40 border-b text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <div className="col-span-1 text-right">번호</div>
      <div className="col-span-8">제목</div>
      <div className="col-span-2">작성자</div>
      <div className="col-span-1 text-right">작성일</div>
    </div>
  )
}

function NoticeRow({ notice, onClick }) {
  const hasAttachments =
    Array.isArray(notice.attachments) && notice.attachments.length > 0
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left grid grid-cols-12 gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors border-b last:border-b-0"
    >
      <div className="col-span-1 text-[11px] text-muted-foreground tabular-nums text-right pt-0.5">
        {notice.pinned ? (
          <Pin className="inline h-3 w-3 text-primary" />
        ) : (
          notice._number
        )}
      </div>
      <div className="col-span-8 min-w-0">
        <div className="flex items-center gap-1.5">
          {notice.pinned && (
            <span className="text-[9px] px-1 rounded bg-primary/10 text-primary shrink-0">
              고정
            </span>
          )}
          <span className="font-medium text-sm truncate">{notice.title}</span>
          {hasAttachments && (
            <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
        </div>
        {notice.body && (
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
            {notice.body.slice(0, 120)}
          </div>
        )}
      </div>
      <div className="col-span-2 text-[11px] text-muted-foreground truncate">
        {notice.author?.name ?? '—'}
      </div>
      <div className="col-span-1 text-[11px] text-muted-foreground whitespace-nowrap tabular-nums text-right">
        {noticeMonthDay(notice.created_at)}
      </div>
    </button>
  )
}

/** 페이지 네비게이션 — VOC 목록과 동일 패턴(처음/이전 + 번호 + 다음/마지막). */
function Pagination({ page, totalPages, onChange, firstIdx, lastIdx, total }) {
  const pages = pageWindow(page, totalPages)
  return (
    <div className="flex items-center justify-between gap-3 text-xs flex-wrap">
      <div className="text-muted-foreground">
        {total > 0 ? (
          <>
            총 {total}건 중{' '}
            <span className="font-mono tabular-nums">
              {firstIdx}–{lastIdx}
            </span>
          </>
        ) : (
          '0건'
        )}
      </div>
      <div className="flex items-center gap-1">
        <PaginationButton
          onClick={() => onChange(1)}
          disabled={page <= 1}
          aria-label="처음 페이지"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </PaginationButton>
        <PaginationButton
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          aria-label="이전 페이지"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </PaginationButton>
        {pages.map((p, i) =>
          p === '…' ? (
            <span
              key={`gap-${i}`}
              className="px-1.5 text-muted-foreground select-none"
            >
              …
            </span>
          ) : (
            <PaginationButton
              key={p}
              onClick={() => onChange(p)}
              active={p === page}
            >
              {p}
            </PaginationButton>
          ),
        )}
        <PaginationButton
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="다음 페이지"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </PaginationButton>
        <PaginationButton
          onClick={() => onChange(totalPages)}
          disabled={page >= totalPages}
          aria-label="마지막 페이지"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </PaginationButton>
      </div>
    </div>
  )
}

function PaginationButton({ children, onClick, disabled, active, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-7 min-w-[28px] px-2 rounded text-xs border tabular-nums transition-colors ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background hover:bg-muted border-input disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-background'
      }`}
      {...rest}
    >
      {children}
    </button>
  )
}

/** 현재 페이지 ±1 + 첫/마지막 페이지 노출, 사이가 떨어지면 「…」 삽입. */
function pageWindow(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const out = new Set([1, total, current, current - 1, current + 1])
  const list = [...out].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)
  const withGaps = []
  for (let i = 0; i < list.length; i += 1) {
    withGaps.push(list[i])
    if (i < list.length - 1 && list[i + 1] - list[i] > 1) {
      withGaps.push('…')
    }
  }
  return withGaps
}
