import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Search,
  FileText,
  Loader2,
  Sparkles,
  Type,
  MessageCircleQuestion,
  Network,
} from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { searchReports, semanticSearchReports } from '@/modules/reports/api'
import { ObjectSearch } from '@/modules/entities/ObjectSearch'
import { askAi } from '@/shared/api/ai'
import { useAuth } from '@/shared/auth/AuthContext'
import { EntityFilterControl } from './EntityFilterControl'

const LIMIT = 30

const CURRENT_YEAR = new Date().getFullYear()
// 작성연도(자료연도) 후보 — 올해부터 9년 전까지. 검색은 기본 "전체"(null).
const YEAR_OPTIONS = Array.from({ length: 10 }, (_, i) => CURRENT_YEAR - i)

// 검색 모드. 'keyword' = 기존 pg_trgm 부분일치. 'semantic' = 임베딩 기반 의미 검색
// (서버 mode=hybrid 로 호출 — 벡터+키워드 RRF 융합). 의미 모드는 페이지네이션 없음.
const MODES = [
  { key: 'keyword', label: '키워드', icon: Type, hint: '제목·본문 단어 일치' },
  {
    key: 'semantic',
    label: '의미',
    icon: Sparkles,
    hint: '뜻이 비슷한 보고서까지 (의미 + 키워드 융합)',
  },
]
// RAG Q&A 모드 (B300). ai_features 에 'rag_qa' 가 있는 사용자에게만 노출.
const ASK_MODE = {
  key: 'ask',
  label: '질문하기',
  icon: MessageCircleQuestion,
  hint: '아카이브 보고서를 근거로 답변 (출처 인용)',
}

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
  const [mode, setMode] = useState('keyword')
  // 검색 대상 — 보고서(기존) vs 객체(Phase C 온톨로지 검색).
  const [target, setTarget] = useState('reports')
  // RAG Q&A — 권한(ai_features)이 있을 때만 "질문하기" 모드 노출.
  const { me } = useAuth()
  const hasRagQa = !!me?.ai_features?.includes('rag_qa')
  const isAsk = mode === 'ask'
  const modes = useMemo(
    () => (hasRagQa ? [...MODES, ASK_MODE] : MODES),
    [hasRagQa],
  )
  const [askLoading, setAskLoading] = useState(false)
  const [askResult, setAskResult] = useState(null) // {answer, citations, no_evidence, seeds}
  const [askError, setAskError] = useState(null)
  // GraphRAG — 온톨로지 그래프 근거 블렌드(질문이 다룬 객체→연결 이웃 근거 우선).
  const [graphMode, setGraphMode] = useState(false)
  // 엔티티 태그 필터(D-2) — 본문/의미 검색을 메타데이터로 좁힌다("본문 X AND 모델=A1234").
  // 키워드·의미 두 모드 모두 적용.
  const [entityFilter, setEntityFilter] = useState([])
  const [entityRollup, setEntityRollup] = useState(false)
  // 자료 연도(작성연도, report_date) 필터(p56). 엔티티의 적용연도와 독립 —
  // "언제 작성된 보고서냐". 검색은 기본 전체(null), 사용자가 좁힐 수 있다.
  const [year, setYear] = useState(null)
  const entityIds = useMemo(() => entityFilter.map((e) => e.id), [entityFilter])
  // dep 안정용 문자열 키(배열은 매 렌더 새 참조).
  const entityKey = entityIds.slice().sort((a, b) => a - b).join(',')
  const useEntityFilter = entityIds.length > 0
  // 검색 실행 조건: 검색어(2자+) "또는" 메타 필터(태그/작성연도)만으로도 돈다.
  // 백엔드는 빈 검색어 + 필터(브라우즈)를 지원하므로, 태그만 걸어도 "모델 X
  // 관련 보고서 전부"가 바로 뜬다. (effect 가 deps 로 참조하므로 위에서 선언.)
  const hasQuery = debounced.length >= 2
  const hasFilter = useEntityFilter || year != null
  const canSearch = hasQuery || hasFilter
  // 의미(시맨틱) 모드는 검색어가 있어야만 — 빈 검색어 + 필터는 키워드 브라우즈로.
  const usingSemantic = mode === 'semantic' && hasQuery
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
    // 질문하기 모드는 자동 조회 안 함 — LLM 호출 비용이라 Enter/버튼으로만.
    if (mode === 'ask') return undefined
    if (debounced !== lastPushedRef.current) {
      lastPushedRef.current = debounced
      setParams(debounced ? { q: debounced } : {}, { replace: true })
    }
    setOffset(0)
    if (!canSearch) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const run =
      usingSemantic
        ? semanticSearchReports(debounced, {
            mode: 'hybrid',
            limit: LIMIT,
            entityIds: useEntityFilter ? entityIds : undefined,
            entityRollup: useEntityFilter ? entityRollup : undefined,
            year: year ?? undefined,
          })
        : searchReports(debounced, {
            limit: LIMIT,
            offset: 0,
            entityIds: useEntityFilter ? entityIds : undefined,
            entityRollup: useEntityFilter ? entityRollup : undefined,
            year: year ?? undefined,
          })
    run
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData({ results: [], total: 0 }))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, mode, entityKey, entityRollup, year])

  const loadMore = useCallback(() => {
    const next = offset + LIMIT
    setLoading(true)
    searchReports(debounced, {
      limit: LIMIT,
      offset: next,
      entityIds: useEntityFilter ? entityIds : undefined,
      entityRollup: useEntityFilter ? entityRollup : undefined,
      year: year ?? undefined,
    })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, offset, entityKey, entityRollup, useEntityFilter, year])

  // 진행 중인 질문 요청을 끊기 위한 컨트롤러 — "중단" 시 abort 하면 서버도 LLM 생성 멈춤.
  const askAbortRef = useRef(null)

  const submitAsk = useCallback(async () => {
    const q = input.trim()
    if (q.length < 2 || askLoading) return
    const controller = new AbortController()
    askAbortRef.current = controller
    setAskLoading(true)
    setAskError(null)
    try {
      const res = await askAi({
        query: q,
        graph: graphMode,
        signal: controller.signal,
      })
      setAskResult(res)
    } catch (e) {
      // 사용자가 중단(abort)한 경우는 에러로 표시하지 않는다.
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') {
        setAskError(null)
      } else {
        setAskError(
          e?.response?.data?.message || e?.message || '질문 처리에 실패했습니다.',
        )
        setAskResult(null)
      }
    } finally {
      askAbortRef.current = null
      setAskLoading(false)
    }
  }, [input, askLoading, graphMode])

  const cancelAsk = useCallback(() => {
    askAbortRef.current?.abort()
  }, [])

  const results = data?.results ?? []
  const total = data?.total ?? 0
  // 의미 검색은 오프셋 페이지네이션이 없다(서버가 상위 N개만 RRF로 반환).
  // 키워드/브라우즈(필터 전용) 경로만 더보기.
  const hasMore = !usingSemantic && results.length < total
  const showEmpty = !loading && canSearch && total === 0
  const activeHint = modes.find((m) => m.key === mode)?.hint

  const targetToggle = (
    <div className="mb-3 inline-flex rounded-md border p-0.5">
      {[
        { key: 'reports', label: '보고서' },
        { key: 'objects', label: '객체' },
      ].map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => setTarget(t.key)}
          aria-pressed={target === t.key}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            target === t.key
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )

  if (target === 'objects') {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <h1 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          <Search className="h-5 w-5" /> 검색
        </h1>
        {targetToggle}
        <ObjectSearch />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Search className="h-5 w-5" /> 검색
      </h1>
      {targetToggle}

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (isAsk && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submitAsk()
            }
          }}
          placeholder={
            isAsk
              ? '아카이브에 질문하기 (예: 낙하 시험에서 가장 취약한 부품은?) — Enter'
              : '제목·본문에서 검색 (표·긴 글 등 위젯 내용 포함)'
          }
          className="h-11 pl-9 text-base"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5">
          {modes.map((m) => {
            const Icon = m.icon
            const active = mode === m.key
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                aria-pressed={active}
                className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {m.label}
              </button>
            )
          })}
        </div>
        {isAsk && (
          <label
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
            title="온톨로지 그래프로 답합니다 — 질문이 다룬 객체와 연결된 이웃 객체의 보고서를 근거로 우선합니다"
          >
            <input
              type="checkbox"
              checked={graphMode}
              onChange={(e) => setGraphMode(e.target.checked)}
              className="h-3 w-3"
            />
            <Network className="h-3.5 w-3.5" />
            그래프 근거
          </label>
        )}
        <span className="text-xs text-muted-foreground">{activeHint}</span>
      </div>

      {/* 질문하기(RAG Q&A) 패널 — 답변 카드 + 출처 인용 칩. */}
      {isAsk && (
        <div className="mt-1">
          {askLoading && (
            <div className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 답변 생성 중…
              <Button variant="outline" size="sm" onClick={cancelAsk}>
                중단
              </Button>
            </div>
          )}
          {!askLoading && askError && (
            <p className="py-10 text-center text-sm text-destructive">
              {askError}
            </p>
          )}
          {!askLoading && !askError && !askResult && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              질문을 입력하고 Enter — 아카이브 보고서를 근거로 답하고 출처를
              인용합니다.
            </p>
          )}
          {!askLoading &&
            askResult &&
            (askResult.no_evidence ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {askResult.answer || '관련 보고서를 찾지 못했습니다.'}
              </p>
            ) : (
              <div className="rounded-lg border bg-card p-4">
                {askResult.seeds?.length > 0 && (
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      <Network className="h-3.5 w-3.5" /> 다룬 객체
                    </span>
                    {askResult.seeds.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => navigate(`/entities/${s.id}`)}
                        title={`${s.type_label || s.type_slug} · ${s.value}`}
                        className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] hover:bg-muted"
                      >
                        {s.value}
                      </button>
                    ))}
                  </div>
                )}
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {askResult.answer}
                </div>
                {askResult.citations?.length > 0 && (
                  <div className="mt-3 border-t pt-3">
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                      출처
                    </p>
                    <div className="flex flex-col gap-1">
                      {askResult.citations.map((c) => (
                        <button
                          key={c.n}
                          type="button"
                          onClick={() =>
                            navigate(
                              `/w/${c.workspace_slug}/reports/${c.report_id}`,
                            )
                          }
                          className="flex items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-muted"
                        >
                          <span
                            className={`mt-0.5 shrink-0 rounded px-1.5 text-[10px] font-bold ${
                              c.used
                                ? 'bg-primary/15 text-primary'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            [{c.n}]
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-medium">
                                {c.title || `보고서 ${c.report_id}`}
                              </span>
                              {c.graph && (
                                <span
                                  className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 text-[9px] font-medium text-primary"
                                  title="온톨로지 그래프로 연결된 근거"
                                >
                                  <Network className="h-2.5 w-2.5" /> 그래프
                                </span>
                              )}
                            </span>
                            {(c.author || c.date) && (
                              <span className="block text-[10px] text-muted-foreground">
                                {[c.author, c.date].filter(Boolean).join(' · ')}
                              </span>
                            )}
                            {c.objects?.length > 0 && (
                              <span className="block truncate text-[10px] text-primary/80">
                                연결 객체: {c.objects.join(', ')}
                              </span>
                            )}
                            {c.snippet && (
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {c.snippet}
                              </span>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {!isAsk && (
        <>
      {/* 필터 줄 — 엔티티 태그(D-2, 값의 적용연도는 태그 picker 안에서) +
          자료연도(보고서 작성연도, p56). 둘은 독립적으로 AND 결합. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <EntityFilterControl
          selected={entityFilter}
          onChange={setEntityFilter}
          related={entityRollup}
          onRelatedChange={setEntityRollup}
        />
        <label
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          title="보고서가 작성된 해(report_date)로 좁힙니다 — 태그 값의 적용연도와는 다릅니다"
        >
          작성연도
          <select
            value={year ?? 'all'}
            onChange={(e) =>
              setYear(e.target.value === 'all' ? null : Number(e.target.value))
            }
            className="h-7 rounded-md border bg-background px-2 text-xs"
          >
            <option value="all">전체</option>
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {canSearch && (
        <p className="mb-3 text-xs text-muted-foreground">
          {loading && results.length === 0 ? '검색 중…' : `결과 ${total}건`}
        </p>
      )}

      {!canSearch && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          두 글자 이상 입력하거나, 태그·작성연도 필터를 걸면 검색합니다.
        </p>
      )}

      {showEmpty && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {hasQuery ? `“${debounced}”에 대한 결과가 없습니다.` : '필터에 해당하는 보고서가 없습니다.'}
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
              {mode === 'semantic' && (hit.inSemantic || hit.inKeyword) && (
                <span className="mt-0.5 flex gap-1">
                  {hit.inSemantic && (
                    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
                      의미
                    </span>
                  )}
                  {hit.inKeyword && (
                    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                      키워드
                    </span>
                  )}
                </span>
              )}
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
        </>
      )}
    </div>
  )
}
