import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Search, FileText, Loader2 } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { searchReports } from '@/modules/reports/api'

const LIMIT = 30

/** 검색어의 각 단어(공백 분리)를 <mark> 로 강조. 대소문자 무시, 모든 일치. */
function Highlighted({ text, query }) {
  if (!text) return null
  const tokens = (query || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return text
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${tokens.map(esc).join('|')})`, 'gi')
  const tokenSet = new Set(tokens.map((t) => t.toLowerCase()))
  return text.split(re).map((part, i) =>
    part && tokenSet.has(part.toLowerCase()) ? (
      <mark key={i} className="rounded bg-primary/20 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

/**
 * 전용 본문 검색 결과 페이지. 헤더 명령 팔레트에서 "검색 결과 보기"로 진입.
 * `?q=` 를 읽어 큰 카드 그리드로 결과를 펼치고, 더보기로 페이지네이션.
 * 워크스페이스 스코프는 apiClient 의 X-Workspace-Slug(활성 부서)로 자동 적용.
 */
export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const inputRef = useRef(null)

  const urlQ = params.get('q') ?? ''
  const [input, setInput] = useState(urlQ)
  const [debounced, setDebounced] = useState(urlQ.trim())
  const [data, setData] = useState(null) // { results, total }
  const [loading, setLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  // 우리가 마지막으로 URL(?q)에 써넣은 값. 외부(헤더 재검색)로 ?q 가 바뀐 것과
  // 우리 디바운스가 쓴 변경을 구분해, 외부 변경일 때만 입력을 리셋한다(루프 방지).
  const lastPushedRef = useRef(urlQ.trim())

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 외부에서 ?q 가 바뀌면(예: 이미 이 페이지에 있는 채로 헤더 검색으로 재진입)
  // 입력·디바운스를 그 값으로 다시 맞춘다. 안 그러면 이전 검색어가 그대로 남아
  // 새 검색이 안 먹는 것처럼 보인다.
  useEffect(() => {
    const next = urlQ.trim()
    if (next === lastPushedRef.current) return // 우리가 쓴 변경이면 무시
    lastPushedRef.current = next
    setInput(urlQ)
    setDebounced(next)
  }, [urlQ])

  // 입력 → 디바운스.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250)
    return () => clearTimeout(t)
  }, [input])

  // 디바운스된 검색어 → URL(?q) 동기화 + 첫 페이지 조회.
  useEffect(() => {
    if (debounced !== lastPushedRef.current) {
      lastPushedRef.current = debounced
      setParams(debounced ? { q: debounced } : {}, { replace: true })
    }
    setOffset(0)
    if (debounced.length < 2) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    searchReports(debounced, { limit: LIMIT, offset: 0 })
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData({ results: [], total: 0 }))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  const loadMore = useCallback(() => {
    const next = offset + LIMIT
    setLoading(true)
    searchReports(debounced, { limit: LIMIT, offset: next })
      .then((d) =>
        setData((prev) => ({
          ...d,
          results: [...(prev?.results ?? []), ...(d.results ?? [])],
        })),
      )
      .finally(() => {
        setOffset(next)
        setLoading(false)
      })
  }, [debounced, offset])

  const results = data?.results ?? []
  const total = data?.total ?? 0
  const hasMore = results.length < total
  const showEmpty = !loading && debounced.length >= 2 && total === 0

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Search className="h-5 w-5" />
        보고서 검색
      </h1>

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="제목·본문에서 검색 (표·긴 글 등 위젯 내용 포함)"
          className="h-11 pl-9 text-base"
        />
      </div>

      {debounced.length >= 2 && (
        <p className="mb-3 text-xs text-muted-foreground">
          {loading && results.length === 0 ? '검색 중…' : `결과 ${total}건`}
        </p>
      )}

      {debounced.length < 2 && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          두 글자 이상 입력하면 제목과 본문에서 검색합니다.
        </p>
      )}

      {showEmpty && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          “{debounced}”에 대한 결과가 없습니다.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {results.map((hit) => {
          const r = hit.report
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => navigate(`/w/${r.workspace_slug}/reports/${r.id}`)}
              className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <span className="flex items-center gap-1.5 font-medium">
                <FileText className="h-4 w-4 shrink-0 text-sky-500" />
                <span className="truncate">
                  <Highlighted text={r.title} query={debounced} />
                </span>
              </span>
              {hit.snippet && (
                <span className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                  <Highlighted text={hit.snippet} query={debounced} />
                </span>
              )}
              <span className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {[r.report_type?.name || r.template_id, r.owner_name, r.workspace_slug]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          )
        })}
      </div>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : null}
            더보기 ({results.length}/{total})
          </Button>
        </div>
      )}
    </div>
  )
}
