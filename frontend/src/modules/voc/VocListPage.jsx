import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Megaphone,
  MessageSquare,
  Paperclip,
  Plus,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Input } from '@/shared/components/ui/input'
import { Card, CardContent } from '@/shared/components/ui/card'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { useAuth } from '@/shared/auth/AuthContext'
import { listVocPosts } from '@/shared/api/voc'
import {
  VOC_CATEGORIES,
  VOC_CATEGORY_BY,
  VOC_PRIORITY_BY,
  VOC_STATUS_BY,
  vocMonthDay,
} from './constants'
import { VocNewDialog } from './VocNewDialog'

// 한 페이지에 보여줄 글 수 — 일반적인 게시판 감각에 맞춘 20행.
// 페이지 단위가 작아서 가상 스크롤 불필요, 사용자도 페이지 클릭
// mental model 그대로 사용 가능.
const PAGE_SIZE = 20

// 상태 탭 선택을 화면 재진입 시에도 유지하기 위한 localStorage 키.
const VOC_STATUS_TAB_KEY = 'voc.statusTab'

/** VOC board list — 페이지 단위 네비게이션 + 컬럼 헤더 + 필터 칩 +
 *  내 글 토글. 필터·페이지·검색이 바뀌면 한 페이지 분량만 fetch (offset
 *  계산). 가상 스크롤은 빼고 page-by-page 로 단순화 — 게시판 사용자가
 *  기대하는 「이전 / 다음 / 페이지 번호」 패턴 그대로. */
export default function VocListPage() {
  const { me } = useAuth()
  const navigate = useNavigate()
  // 상태 탭(열림/진행중/…/전체) 선택은 화면을 떠났다 돌아와도 유지되게
  // localStorage 에 보존 — 매번 '열림'으로 리셋되면 진행 중인 글을 추적하기 번거롭다.
  const [statusTab, setStatusTab] = useState(
    () => localStorage.getItem(VOC_STATUS_TAB_KEY) || 'open',
  )
  const [category, setCategory] = useState('')
  const [mine, setMine] = useState(false)
  const [query, setQuery] = useState('')
  const [newOpen, setNewOpen] = useState(false)

  const [page, setPage] = useState(1) // 1-indexed
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // 필터가 바뀌면 1페이지로 자동 리셋 — 5페이지 보다가 카테고리 바꾸면
  // 새 결과의 5페이지가 비어 있을 가능성이 크니까.
  const filterKey = `${statusTab}|${category}|${mine ? 1 : 0}`
  useEffect(() => {
    setPage(1)
  }, [filterKey])

  // 페이지 / 필터 변경 → fetch.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listVocPosts({
      ...(statusTab === 'all' ? {} : { status: statusTab }),
      ...(category ? { category } : {}),
      ...(mine ? { mine: true } : {}),
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
  }, [page, statusTab, category, mine])

  // 게시판 번호 부여 — 가장 최근 글이 total, 오래된 글로 갈수록 감소.
  // 페이지·필터에 따라 컨텍스트별로 다시 매겨짐. (예: '열림' 탭에서 N건
  // 이면 그 안에서 1~N. '전체' 탭에서는 더 큰 N 기준으로 매겨짐.)
  // post.id 를 그대로 쓰면 삭제로 번호가 듬성듬성해져서 "5번 다음이 8번"
  // 같이 어색해진다 — sequential 번호가 게시판 감각에 맞음.
  const numbered = items.map((p, i) => ({
    ...p,
    _number: Math.max(0, total - (page - 1) * PAGE_SIZE - i),
  }))

  // 페이지 안에서만 적용되는 텍스트 필터. 전체 검색은 서버 endpoint
  // 따로 필요. 빈 검색어면 그대로 패스.
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
        title="VOC"
        description="도구에 대한 버그·기능 요청·질문 게시판"
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            새 글
          </Button>
        }
      />

      <Tabs
        value={statusTab}
        onValueChange={(v) => {
          setStatusTab(v)
          localStorage.setItem(VOC_STATUS_TAB_KEY, v)
        }}
      >
        <TabsList>
          <TabsTrigger value="open">
            <Megaphone className="mr-1.5 h-3.5 w-3.5" />
            열림
          </TabsTrigger>
          <TabsTrigger value="in_progress">진행 중</TabsTrigger>
          <TabsTrigger value="resolved">해결됨</TabsTrigger>
          <TabsTrigger value="wontfix">보류</TabsTrigger>
          <TabsTrigger value="all">전체</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="현재 페이지 안에서 검색"
          className="h-9 max-w-xs"
        />
        <div className="flex items-center gap-1 text-xs flex-wrap">
          <span className="text-muted-foreground mr-1">분류:</span>
          <CategoryChip active={category === ''} onClick={() => setCategory('')} label="전체" />
          {VOC_CATEGORIES.map((c) => (
            <CategoryChip
              key={c.value}
              active={category === c.value}
              onClick={() => setCategory(category === c.value ? '' : c.value)}
              label={c.label}
            />
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
          />
          내 글만
        </label>
      </div>

      {error ? (
        <ErrorState description={error.message} onRetry={() => setPage((p) => p)} />
      ) : (
        <div className="border rounded-md overflow-hidden">
          {/* 컬럼 헤더 — 어떤 정보가 어디 있는지 한눈에 안내. 행의
              grid 와 동일한 12-col 구조를 그대로 사용해서 정렬 어긋남
              없음. sticky 까지는 불필요 (페이지 하나가 짧음). */}
          <ColumnHeader />
          {loading ? (
            <div className="p-6">
              <Skeleton className="h-48" />
            </div>
          ) : filtered.length === 0 ? (
            <Card className="border-0 rounded-none shadow-none">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                <MessageSquare className="mx-auto mb-2 h-6 w-6 opacity-50" />
                {total === 0
                  ? '조건에 맞는 VOC가 없습니다.'
                  : query.trim()
                    ? '현재 페이지 안에서 매칭되는 글이 없습니다. 검색어를 비우거나 다른 페이지를 보세요.'
                    : '현재 페이지에 표시할 글이 없습니다.'}
              </CardContent>
            </Card>
          ) : (
            <div>
              {filtered.map((p) => (
                <PostRow
                  key={p.id}
                  post={p}
                  onClick={() => navigate(`/voc/${p.id}`)}
                  currentUserId={me?.user?.id}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 글이 한 건도 없어도 페이지 1/1 로 표시 — 사용자가 "지금 어떤
          상태인지" 항상 확인할 수 있도록 항상 노출. */}
      <Pagination
        page={page}
        totalPages={totalPages}
        onChange={setPage}
        firstIdx={firstIdx}
        lastIdx={lastIdx}
        total={total}
      />

      <VocNewDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(created) => {
          setNewOpen(false)
          navigate(`/voc/${created.id}`)
        }}
      />
    </div>
  )
}

function ColumnHeader() {
  return (
    <div className="grid grid-cols-12 gap-3 px-3 py-2 bg-muted/40 border-b text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <div className="col-span-1 text-right">번호</div>
      <div className="col-span-1">분류</div>
      <div className="col-span-5">제목</div>
      <div className="col-span-1">상태</div>
      <div className="col-span-1">우선순위</div>
      <div className="col-span-2">작성자</div>
      <div className="col-span-1 text-right">작성일</div>
    </div>
  )
}

function CategoryChip({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background hover:bg-muted'
      }`}
    >
      {label}
    </button>
  )
}

function PostRow({ post, onClick, currentUserId }) {
  const cat = VOC_CATEGORY_BY[post.category]
  const stat = VOC_STATUS_BY[post.status]
  const prio = VOC_PRIORITY_BY[post.priority]
  const isMine = post.author?.id === currentUserId
  const hasAttachments = Array.isArray(post.attachments) && post.attachments.length > 0
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left grid grid-cols-12 gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors border-b last:border-b-0"
    >
      <div className="col-span-1 text-[11px] text-muted-foreground tabular-nums text-right pt-0.5">
        {post._number}
      </div>
      <div className="col-span-1 flex items-start gap-1">
        {cat && (
          <Badge variant={cat.variant} className="text-[9px] h-4 px-1">
            {cat.label}
          </Badge>
        )}
      </div>
      <div className="col-span-5 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-sm truncate">{post.title}</span>
          {post.comment_count > 0 && (
            <span className="text-[11px] text-muted-foreground">
              💬 {post.comment_count}
            </span>
          )}
          {hasAttachments && (
            <Paperclip className="h-3 w-3 text-muted-foreground" />
          )}
          {isMine && (
            <span className="text-[9px] px-1 rounded bg-primary/10 text-primary">
              내 글
            </span>
          )}
        </div>
        {post.body && (
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
            {post.body.slice(0, 120)}
          </div>
        )}
      </div>
      <div className="col-span-1 flex items-start">
        {stat && (
          <Badge variant={stat.variant} className="text-[9px] h-4 px-1">
            {stat.label}
          </Badge>
        )}
      </div>
      <div className="col-span-1 flex items-start">
        {prio && prio.value !== 'normal' && (
          <Badge variant={prio.variant} className="text-[9px] h-4 px-1">
            {prio.label}
          </Badge>
        )}
      </div>
      <div className="col-span-2 text-[11px] text-muted-foreground truncate">
        {post.author?.name ?? '—'}
      </div>
      <div className="col-span-1 text-[11px] text-muted-foreground whitespace-nowrap tabular-nums text-right">
        {vocMonthDay(post.created_at)}
      </div>
    </button>
  )
}

/** 페이지 네비게이션 — 처음/이전 + 페이지 번호(현재 기준 ±2, 끝 노출)
 *  + 다음/마지막 + 현재 위치 안내. 페이지가 1개일 때도 항상 렌더 →
 *  사용자가 「총 N건, 1페이지」 같은 상태를 항상 확인 가능. */
function Pagination({ page, totalPages, onChange, firstIdx, lastIdx, total }) {
  const pages = pageWindow(page, totalPages)
  return (
    <div className="flex items-center justify-between gap-3 text-xs flex-wrap">
      <div className="text-muted-foreground">
        {total > 0 ? (
          <>
            총 {total}건 중{' '}
            <span className="font-mono tabular-nums">{firstIdx}–{lastIdx}</span>
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

/** 현재 페이지 ±2 + 첫/마지막 페이지를 노출, 그 사이가 떨어지면 「…」
 *  삽입. 1..N 이 7페이지 이하면 그냥 전부 노출.
 *  예: total=50, page=10  →  [1, '…', 8, 9, 10, 11, 12, '…', 50] */
function pageWindow(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const out = new Set([1, total, current, current - 1, current + 1])
  // current ±1 까지만 — 8개 이하로 유지
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
