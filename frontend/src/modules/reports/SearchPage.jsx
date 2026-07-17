import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Search,
  FileText,
  FilePlus2,
  Loader2,
  Sparkles,
  Type,
  MessageCircleQuestion,
  Network,
  SlidersHorizontal,
  Wand2,
  ShieldCheck,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  Bookmark,
  BookmarkPlus,
  Bell,
  BellOff,
  X,
} from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { Markdown } from '@/shared/components/Markdown'
import {
  searchReports,
  semanticSearchReports,
  createReportFromAnswer,
} from '@/modules/reports/api'
import { ObjectSearch } from '@/modules/entities/ObjectSearch'
import { askAi, getAskOptions, submitFeedback } from '@/shared/api/ai'
import { useAuth } from '@/shared/auth/AuthContext'
import { listReportTypes } from '@/shared/api/reportTypes'
import { searchUsers } from '@/shared/api/members'
import {
  listSavedSearches,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch,
} from '@/shared/api/savedSearches'
import { EntityFilterControl } from './EntityFilterControl'

const LIMIT = 30

const CURRENT_YEAR = new Date().getFullYear()
// 작성연도(자료연도) 후보 — 올해부터 9년 전까지. 검색은 기본 "전체"(null).
const YEAR_OPTIONS = Array.from({ length: 10 }, (_, i) => CURRENT_YEAR - i)

// (B) 날짜 범위 프리셋 — 서버 상대날짜(last_days/period)로 매핑. '직접'은 date_from/to.
const DATE_PRESETS = [
  { key: 'all', label: '전체' },
  { key: 'last7', label: '최근 7일' },
  { key: 'last30', label: '최근 30일' },
  { key: 'this_week', label: '이번 주' },
  { key: 'this_month', label: '이번 달' },
  { key: 'this_year', label: '올해' },
  { key: 'custom', label: '직접 지정' },
]
// 협업 단계 필터 칩. 서버 phase enum 과 1:1.
const PHASE_OPTIONS = [
  { key: 'drafting', label: '작성중' },
  { key: 'reviewing', label: '리뷰중' },
  { key: 'finalized', label: '발행완료' },
]

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
// 질문(RAG/에이전트)은 이제 별도 모드가 아니다 — 검색창에 자연어로 쓰고 Enter 를
// 치면 /api/ai/ask 가 답한다(복합 질문은 서버가 에이전트로 자동 라우팅). 모드는 검색
// 방식(키워드/의미)만 고른다. 'rag_qa' 권한이 있어야 Enter 로 질문할 수 있다.

// 입력이 '질문형'인지 가벼운 휴리스틱 — 맞으면 "Enter 로 묻기" 힌트만 띄운다(발견성
// 보조). 틀려도 Enter 는 항상 질문으로 처리되므로 무해하다.
const _QUESTION_WORDS = [
  // 의문사
  '?', '？', '뭐', '무엇', '무슨', '어떤', '어느', '왜', '어디', '언제', '누가',
  '누구', '얼마', '몇', '어떻게', '인가', '일까', '있나', '있는지',
  // 요청·명령형(검색 의도) — "찾아줘·보여줘·알려줘·추천·정리·요약·비교·분석" 등
  '알려', '해줘', '찾아', '보여', '추천', '설명', '정리', '요약', '비교', '분석', '줘',
]
function looksLikeQuestion(s) {
  const q = (s || '').trim()
  if (q.length < 4) return false
  const lower = q.toLowerCase()
  if (_QUESTION_WORDS.some((w) => lower.includes(w))) return true
  // 3어절 이상의 자연어 문장은 질문 의도로 본다 — 키워드 검색은 보통 짧다.
  return q.split(/\s+/).filter(Boolean).length >= 3
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

/** 활성 필터 요약 칩 — × 로 개별 제거. (#3) */
function FilterChip({ children, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs text-foreground">
      {children}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full text-muted-foreground hover:text-foreground"
        title="제거"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
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
  // 답변을 보고서로 저장(2차 LLM 패스) — report_authoring 권한이 있을 때만 노출.
  const canAuthorReport = !!me?.ai_features?.includes('report_authoring')
  const [savingReport, setSavingReport] = useState(false)
  const [saveError, setSaveError] = useState(null)
  // 모드 = 검색 방식(키워드/의미)만. 질문은 Enter 로 별도(askResult).
  const modes = MODES
  const [askLoading, setAskLoading] = useState(false)
  const [askResult, setAskResult] = useState(null) // {answer, citations, no_evidence, seeds}
  const [askError, setAskError] = useState(null)
  // GraphRAG — 온톨로지 그래프 근거 블렌드(질문이 다룬 객체→연결 이웃 근거 우선).
  const [graphMode, setGraphMode] = useState(false)
  // rerank/hyde 요청별 토글 — 서버 기본값으로 초기화(안 만지면 기본대로).
  const [rerankMode, setRerankMode] = useState(false)
  const [hydeMode, setHydeMode] = useState(false)
  const [verifyMode, setVerifyMode] = useState(false)
  const [askOpts, setAskOpts] = useState(null) // {rerank_available, hyde_available, verify_available}
  const [askedQuery, setAskedQuery] = useState('') // 피드백에 붙일 마지막 질문
  const [feedbackSent, setFeedbackSent] = useState(null) // 1 | -1 | null
  // 엔티티 태그 필터(D-2) — 본문/의미 검색을 메타데이터로 좁힌다("본문 X AND 모델=A1234").
  // 키워드·의미 두 모드 모두 적용.
  const [entityFilter, setEntityFilter] = useState([])
  const [entityRollup, setEntityRollup] = useState(false)
  // 자료 연도(작성연도, report_date) 필터(p56). 엔티티의 적용연도와 독립 —
  // "언제 작성된 보고서냐". 검색은 기본 전체(null), 사용자가 좁힐 수 있다.
  const [year, setYear] = useState(null)
  // (B) 컬럼 필터 — 날짜범위(프리셋/직접)·기준필드·종류·단계·"내가 작성".
  const [datePreset, setDatePreset] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateField, setDateField] = useState('report_date')
  const [typeId, setTypeId] = useState(null) // 보고서 종류 단일 선택
  const [phaseFilter, setPhaseFilter] = useState([]) // 단계(멀티)
  const [authorFilter, setAuthorFilter] = useState([]) // 작성자(멀티) [{id,name}]
  const [tagFilter, setTagFilter] = useState([]) // 자유 태그(멀티) [str]
  const [sort, setSort] = useState('relevance') // relevance|recent|oldest
  const [typeOptions, setTypeOptions] = useState([]) // {id,name}
  // 작성자 검색 picker 상태.
  const [authorQuery, setAuthorQuery] = useState('')
  const [authorResults, setAuthorResults] = useState([])
  const [authorOpen, setAuthorOpen] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const entityIds = useMemo(() => entityFilter.map((e) => e.id), [entityFilter])
  // dep 안정용 문자열 키(배열은 매 렌더 새 참조).
  const entityKey = entityIds.slice().sort((a, b) => a - b).join(',')
  const useEntityFilter = entityIds.length > 0

  // (B) 서버로 보낼 필터 객체 — appendReportFilters 모양. 값 있는 것만.
  const hasDateFilter =
    datePreset !== 'all' && (datePreset !== 'custom' || !!dateFrom || !!dateTo)
  const authorIds = useMemo(() => authorFilter.map((a) => a.id), [authorFilter])
  const filters = useMemo(() => {
    const f = { dateField }
    if (datePreset === 'last7') f.lastDays = 7
    else if (datePreset === 'last30') f.lastDays = 30
    else if (['this_week', 'this_month', 'this_year'].includes(datePreset))
      f.period = datePreset
    else if (datePreset === 'custom') {
      if (dateFrom) f.dateFrom = dateFrom
      if (dateTo) f.dateTo = dateTo
    }
    if (typeId != null) f.reportTypeIds = [typeId]
    if (phaseFilter.length) f.phases = phaseFilter
    if (authorIds.length) f.authorIds = authorIds
    if (tagFilter.length) f.tags = tagFilter
    return f
  }, [datePreset, dateFrom, dateTo, dateField, typeId, phaseFilter, authorIds, tagFilter])
  const useColumnFilter =
    hasDateFilter ||
    typeId != null ||
    phaseFilter.length > 0 ||
    authorIds.length > 0 ||
    tagFilter.length > 0
  // dep 안정용 키 — filters 객체는 매 렌더 새 참조라 직렬화해서 비교. 정렬도 포함
  // (결과 순서가 바뀌므로 재조회 트리거).
  const filtersKey = (useColumnFilter ? JSON.stringify(filters) : '') + `|${sort}`

  // 보고서 종류 목록 로드(종류 필터 드롭다운). 실패해도 무해(빈 목록 → 필터 숨김 안 함).
  useEffect(() => {
    let alive = true
    listReportTypes({ limit: 200 })
      .then((rows) => alive && setTypeOptions(rows ?? []))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 작성자 검색(디바운스) — 이름/이메일 부분일치. 이미 고른 사람은 제외.
  useEffect(() => {
    const q = authorQuery.trim()
    if (!q) {
      setAuthorResults([])
      return undefined
    }
    let alive = true
    const t = setTimeout(() => {
      searchUsers({ search: q, limit: 8 })
        .then((rows) => {
          if (!alive) return
          const picked = new Set(authorFilter.map((a) => a.id))
          setAuthorResults((rows ?? []).filter((u) => !picked.has(u.id)))
        })
        .catch(() => {})
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [authorQuery, authorFilter])

  // ── 저장된 검색(스마트 폴더) ────────────────────────────────────────
  const [saved, setSaved] = useState([]) // [{id,name,query,mode,filters,...}]
  const [savedOpen, setSavedOpen] = useState(false)
  const [savingSearch, setSavingSearch] = useState(false)
  // 저장에 담을 resolved 필터(서버 모양) + 연도 + 정렬 + 작성자 칩(복원용).
  const saveableFilters = useMemo(() => {
    const f = { ...filters }
    if (year != null) f.year = year
    if (sort && sort !== 'relevance') f.sort = sort
    if (authorFilter.length) f.authors = authorFilter
    return f
  }, [filters, year, sort, authorFilter])

  useEffect(() => {
    let alive = true
    listSavedSearches()
      .then((rows) => alive && setSaved(rows ?? []))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const saveCurrentSearch = useCallback(async () => {
    const name = window.prompt('저장할 이름', debounced || '새 검색')
    if (!name || !name.trim()) return
    setSavingSearch(true)
    try {
      await createSavedSearch({
        name: name.trim(),
        query: debounced,
        mode: mode === 'semantic' ? 'semantic' : 'keyword',
        filters: saveableFilters,
      })
      const rows = await listSavedSearches()
      setSaved(rows ?? [])
      setSavedOpen(true)
    } finally {
      setSavingSearch(false)
    }
  }, [debounced, mode, saveableFilters])

  // 저장검색 적용 — 검색어·모드 복원 + resolved 필터를 UI 상태로 역매핑.
  const applySaved = useCallback(
    (s) => {
      const f = s.filters || {}
      setInput(s.query || '')
      setDebounced((s.query || '').trim())
      if (s.mode === 'semantic' || s.mode === 'keyword') setMode(s.mode)
      // 날짜
      if (f.lastDays === 7) setDatePreset('last7')
      else if (f.lastDays === 30) setDatePreset('last30')
      else if (['this_week', 'this_month', 'this_year'].includes(f.period))
        setDatePreset(f.period)
      else if (f.dateFrom || f.dateTo) {
        setDatePreset('custom')
        setDateFrom(f.dateFrom || '')
        setDateTo(f.dateTo || '')
      } else setDatePreset('all')
      setDateField(f.dateField === 'created_at' ? 'created_at' : 'report_date')
      setTypeId(
        Array.isArray(f.reportTypeIds) && f.reportTypeIds.length
          ? f.reportTypeIds[0]
          : null,
      )
      setPhaseFilter(Array.isArray(f.phases) ? f.phases : [])
      // 작성자 칩 복원 — authors({id,name}) 우선, 없으면 id 만(라벨 fallback).
      if (Array.isArray(f.authors) && f.authors.length) {
        setAuthorFilter(f.authors)
      } else if (Array.isArray(f.authorIds) && f.authorIds.length) {
        setAuthorFilter(f.authorIds.map((id) => ({ id, name: `사용자 ${id}` })))
      } else {
        setAuthorFilter([])
      }
      setTagFilter(Array.isArray(f.tags) ? f.tags : [])
      setSort(['recent', 'oldest'].includes(f.sort) ? f.sort : 'relevance')
      setYear(f.year != null ? f.year : null)
      setSavedOpen(false)
    },
    [],
  )

  const removeSaved = useCallback(async (id, e) => {
    e?.stopPropagation?.()
    if (!window.confirm('이 저장검색을 삭제할까요?')) return
    await deleteSavedSearch(id).catch(() => {})
    setSaved((prev) => prev.filter((x) => x.id !== id))
  }, [])

  // 작성자/태그 필터 조작.
  const addAuthor = useCallback((u) => {
    setAuthorFilter((p) => (p.some((a) => a.id === u.id) ? p : [...p, u]))
    setAuthorQuery('')
    setAuthorResults([])
    setAuthorOpen(false)
  }, [])
  const removeAuthor = useCallback(
    (id) => setAuthorFilter((p) => p.filter((a) => a.id !== id)),
    [],
  )
  const toggleMeAuthor = useCallback(() => {
    if (me?.id == null) return
    setAuthorFilter((p) =>
      p.some((a) => a.id === me.id)
        ? p.filter((a) => a.id !== me.id)
        : [...p, { id: me.id, name: me.name || '나' }],
    )
  }, [me?.id, me?.name])
  const addTag = useCallback((raw) => {
    const v = (raw || '').trim()
    if (!v) return
    setTagFilter((p) => (p.includes(v) ? p : [...p, v]))
    setTagInput('')
  }, [])
  const removeTag = useCallback(
    (t) => setTagFilter((p) => p.filter((x) => x !== t)),
    [],
  )
  // 모든 필터 초기화(검색어는 유지).
  const clearAllFilters = useCallback(() => {
    setDatePreset('all')
    setDateFrom('')
    setDateTo('')
    setDateField('report_date')
    setTypeId(null)
    setPhaseFilter([])
    setAuthorFilter([])
    setTagFilter([])
    setYear(null)
    setEntityFilter([])
    setEntityRollup(false)
    setSort('relevance')
  }, [])
  const meIsAuthor = me?.id != null && authorFilter.some((a) => a.id === me.id)
  const anyFilterActive =
    useColumnFilter || useEntityFilter || year != null || sort !== 'relevance'

  // 구독 토글 — 켜면 이 조건에 새 보고서가 뜰 때 인앱 알림(+이메일 opt-in).
  const toggleSubscribe = useCallback(async (s, e) => {
    e?.stopPropagation?.()
    const next = !s.subscribed
    // 낙관적 반영.
    setSaved((prev) =>
      prev.map((x) => (x.id === s.id ? { ...x, subscribed: next } : x)),
    )
    try {
      const updated = await updateSavedSearch(s.id, { subscribed: next })
      setSaved((prev) => prev.map((x) => (x.id === s.id ? updated : x)))
    } catch {
      // 실패 시 롤백.
      setSaved((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, subscribed: s.subscribed } : x)),
      )
    }
  }, [])

  // 검색 실행 조건: 검색어(2자+) "또는" 메타 필터(태그/작성연도/날짜·종류·단계)만으로도.
  // 백엔드는 빈 검색어 + 필터(브라우즈)를 지원하므로, 필터만 걸어도 바로 뜬다.
  const hasQuery = debounced.length >= 2
  const hasFilter = useEntityFilter || year != null || useColumnFilter
  const canSearch = hasQuery || hasFilter
  // 의미(시맨틱) 모드는 검색어가 있어야만 — 빈 검색어 + 필터는 키워드 브라우즈로.
  const usingSemantic = mode === 'semantic' && hasQuery
  // 우리가 마지막으로 URL(?q)에 써넣은 값. 외부(헤더 재검색)로 ?q 가 바뀐 것과
  // 우리 디바운스가 쓴 변경을 구분해, 외부 변경일 때만 입력을 리셋한다(루프 방지).
  const lastPushedRef = useRef(urlQ.trim())

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Q&A 검색 옵션 기본값 로드 → rerank/hyde 토글 초기값. 실패해도 무해(기본 off).
  useEffect(() => {
    let alive = true
    getAskOptions()
      .then((o) => {
        if (!alive || !o) return
        setAskOpts(o)
        setRerankMode(!!o.rerank)
        setHydeMode(!!o.hyde)
        setVerifyMode(!!o.verify)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
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
  // ★ 속도 보존: 타이핑은 항상 키워드 검색(즉시·무료). LLM 은 Enter(submitAsk)로만.
  useEffect(() => {
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
            filters: useColumnFilter ? filters : undefined,
          })
        : searchReports(debounced, {
            limit: LIMIT,
            offset: 0,
            entityIds: useEntityFilter ? entityIds : undefined,
            entityRollup: useEntityFilter ? entityRollup : undefined,
            year: year ?? undefined,
            filters: useColumnFilter ? filters : undefined,
            sort,
          })
    run
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData({ results: [], total: 0 }))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, mode, entityKey, entityRollup, year, filtersKey])

  const loadMore = useCallback(() => {
    const next = offset + LIMIT
    setLoading(true)
    searchReports(debounced, {
      limit: LIMIT,
      offset: next,
      entityIds: useEntityFilter ? entityIds : undefined,
      entityRollup: useEntityFilter ? entityRollup : undefined,
      year: year ?? undefined,
      filters: useColumnFilter ? filters : undefined,
      sort,
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
  }, [debounced, offset, entityKey, entityRollup, useEntityFilter, year, filtersKey])

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
      // 항상 /ask — 복합(다홉) 질문은 서버가 에이전트로 자동 라우팅한다.
      const res = await askAi({
        query: q, graph: graphMode,
        rerank: rerankMode, hyde: hydeMode, verify: verifyMode,
        signal: controller.signal,
      })
      setAskResult(res)
      setAskedQuery(q)
      setFeedbackSent(null)
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
  }, [input, askLoading, graphMode, rerankMode, hydeMode, verifyMode])

  const sendFeedback = async (rating) => {
    if (!askResult || feedbackSent) return
    setFeedbackSent(rating)
    try {
      await submitFeedback({
        query: askedQuery,
        rating,
        reportIds: (askResult.citations || []).map((c) => c.report_id),
      })
    } catch {
      setFeedbackSent(null)
    }
  }

  const cancelAsk = useCallback(() => {
    askAbortRef.current?.abort()
  }, [])

  // 현재 답변을 구조화 보고서 초안으로 저장 → 생성된 초안으로 이동.
  const saveAsReport = useCallback(async () => {
    if (!askResult?.answer || savingReport) return
    setSavingReport(true)
    setSaveError(null)
    try {
      const draft = await createReportFromAnswer({
        question: input.trim(),
        answer: askResult.answer,
        citations: askResult.citations || [],
        objects: askResult.objects || [],
      })
      if (draft?.url) navigate(draft.url)
      else setSaveError('보고서는 생성됐지만 이동 주소를 받지 못했습니다.')
    } catch (e) {
      setSaveError(
        e?.response?.data?.message || e?.message || '보고서 저장에 실패했습니다.',
      )
    } finally {
      setSavingReport(false)
    }
  }, [askResult, savingReport, input, navigate])

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

      <div className="relative mb-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter = 이 입력을 '질문'으로 보고 AI 답변(권한 있을 때만). 타이핑은
            // 그대로 즉시 키워드 검색 — LLM 은 이 Enter 로만 발동한다(속도 보존).
            if (hasRagQa && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submitAsk()
            }
          }}
          placeholder={
            hasRagQa
              ? '제목·본문 검색 — Enter 로 AI 에게 질문 (예: 낙하시험에서 취약한 부품은?)'
              : '제목·본문에서 검색 (표·긴 글 등 위젯 내용 포함)'
          }
          className="h-11 pl-9 text-base"
        />
      </div>

      {/* 질문형 입력이면 Enter 로 AI 에게 물으라는 힌트(발견성 보조). 이미 답변이
          떠 있으면 감춤. 감지가 틀려도 Enter 는 항상 질문으로 처리된다. */}
      {hasRagQa && !askResult && !askLoading && looksLikeQuestion(input) && (
        <button
          type="button"
          onClick={() => submitAsk()}
          className="mb-3 inline-flex items-center gap-1.5 rounded-full border bg-primary/5 px-3 py-1 text-xs text-primary hover:bg-primary/10"
        >
          <MessageCircleQuestion className="h-3.5 w-3.5" />
          <b>Enter</b> 로 AI 에게 물어보기
        </button>
      )}

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
        <span className="text-xs text-muted-foreground">{activeHint}</span>
        {/* AI 답변 옵션 — 「고급」으로 접어 평소엔 감춘다("그냥 물어보기" 인상). */}
        {hasRagQa && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              AI 답변 옵션
            </summary>
            <div className="mt-2 flex flex-wrap gap-2">
              <label
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1"
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
              {askOpts?.rerank_available && (
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1"
                  title="검색된 후보 문단을 AI가 질문 적합도로 다시 채점해 상위만 인용합니다 — 정밀도↑, 응답이 조금 느려집니다"
                >
                  <input
                    type="checkbox"
                    checked={rerankMode}
                    onChange={(e) => setRerankMode(e.target.checked)}
                    className="h-3 w-3"
                  />
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  정밀 재랭킹
                </label>
              )}
              {askOpts?.hyde_available && (
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1"
                  title="모호한 질문을 '가상 답변 문단'으로 바꿔 검색합니다 — 짧고 애매한 질문의 적중률↑"
                >
                  <input
                    type="checkbox"
                    checked={hydeMode}
                    onChange={(e) => setHydeMode(e.target.checked)}
                    className="h-3 w-3"
                  />
                  <Wand2 className="h-3.5 w-3.5" />
                  가상답변 검색
                </label>
              )}
              {askOpts?.verify_available && (
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1"
                  title="답변의 각 주장이 인용 출처에 실제로 뒷받침되는지 AI가 검증합니다 — 환각 차단, 응답이 조금 느려집니다"
                >
                  <input
                    type="checkbox"
                    checked={verifyMode}
                    onChange={(e) => setVerifyMode(e.target.checked)}
                    className="h-3 w-3"
                  />
                  <ShieldCheck className="h-3.5 w-3.5" />
                  근거 검증
                </label>
              )}
            </div>
          </details>
        )}
      </div>

      {/* AI 답변 카드 — Enter 로 질문했을 때만. 키워드 결과 위에 공존. */}
      {(askResult || askLoading || askError) && (
        <div className="mt-1">
          {!askLoading && (askResult || askError) && (
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setAskResult(null)
                  setAskError(null)
                }}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" /> 검색으로 돌아가기
              </button>
            </div>
          )}
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
          {!askLoading &&
            askResult &&
            (askResult.no_evidence ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {askResult.answer || '관련 보고서를 찾지 못했습니다.'}
              </p>
            ) : (
              <div className="rounded-lg border bg-card p-4">
                {canAuthorReport && (
                  <div className="mb-3 flex items-center justify-end gap-2">
                    {saveError && (
                      <span className="text-[11px] text-destructive">{saveError}</span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={saveAsReport}
                      disabled={savingReport}
                      title="이 답변을 표·차트 등 위젯 보고서 초안으로 저장합니다"
                    >
                      {savingReport ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          보고서 생성 중…
                        </>
                      ) : (
                        <>
                          <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
                          보고서로 저장
                        </>
                      )}
                    </Button>
                  </div>
                )}
                {askResult.structured && (
                  <div className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[11px] text-primary">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    온톨로지 집계 — 개수는 계산된 값입니다(볼 수 있는 보고서 기준)
                  </div>
                )}
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
                {askResult.objects?.length > 0 && (
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      <Network className="h-3.5 w-3.5" /> 관련 객체
                    </span>
                    {askResult.objects.map((o) => (
                      <button
                        key={`${o.type}:${o.id}`}
                        type="button"
                        onClick={() => navigate(`/objects/${o.type}/${o.id}`)}
                        title={`${o.type} · ${o.label}`}
                        className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] hover:bg-muted"
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
                <Markdown className="text-sm leading-relaxed">
                  {askResult.answer}
                </Markdown>
                {askResult.aggregate?.groups?.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t pt-3">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {askResult.aggregate.group_label}별 {askResult.aggregate.target_label}
                    </p>
                    {(() => {
                      const gs = askResult.aggregate.groups
                      const max = Math.max(1, ...gs.map((g) => g.count))
                      return gs.map((g) => (
                        <div key={g.label} className="flex items-center gap-2 text-xs">
                          <span className="w-24 shrink-0 truncate text-right text-muted-foreground" title={g.label}>
                            {g.label}
                          </span>
                          <span
                            className="h-4 rounded bg-primary/70"
                            style={{ width: `${(g.count / max) * 100}%`, minWidth: g.count ? '4px' : 0 }}
                          />
                          <span className="shrink-0 tabular-nums font-medium">
                            {g.count}
                            {askResult.aggregate.unit}
                          </span>
                        </div>
                      ))
                    })()}
                  </div>
                )}
                {!askResult.aggregate?.groups &&
                  askResult.aggregate?.values?.length > 0 && (
                    <div className="mt-3 space-y-1.5 border-t pt-3">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {askResult.aggregate.target_label} 목록 (총{' '}
                        {askResult.aggregate.values_total}
                        {askResult.aggregate.unit})
                      </p>
                      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {askResult.aggregate.values.slice(0, 30).map((v, i) => (
                          <li key={i} className="max-w-[240px] truncate">
                            · {v}
                          </li>
                        ))}
                      </ul>
                      {askResult.aggregate.values.length > 30 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-primary">
                            나머지 {askResult.aggregate.values.length - 30}개 더 보기
                          </summary>
                          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                            {askResult.aggregate.values.slice(30).map((v, i) => (
                              <li key={i} className="max-w-[240px] truncate">
                                · {v}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {askResult.aggregate.values_total >
                        askResult.aggregate.values.length && (
                        <p className="text-[10px] text-muted-foreground">
                          (상위 {askResult.aggregate.values.length}개 표시 / 총{' '}
                          {askResult.aggregate.values_total}개)
                        </p>
                      )}
                    </div>
                  )}
                {askResult.verification?.claims?.length > 0 && (
                  <details className="mt-3 border-t pt-3" open={askResult.verification.unsupported > 0}>
                    <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium">
                      {askResult.verification.unsupported > 0 ? (
                        <span className="inline-flex items-center gap-1 text-amber-600">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          근거 검증 — 근거 불충분 {askResult.verification.unsupported}건
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-emerald-600">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          근거 검증 — 모든 주장이 출처로 뒷받침됨
                        </span>
                      )}
                    </summary>
                    <ul className="mt-1.5 flex flex-col gap-1.5">
                      {askResult.verification.claims.map((c, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px]">
                          {c.supported ? (
                            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                          ) : (
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                          )}
                          <span className="min-w-0">
                            <span className={c.supported ? '' : 'text-amber-700'}>
                              {c.text}
                            </span>
                            {c.supported && c.source != null && (
                              <span className="ml-1 text-muted-foreground">[{c.source}]</span>
                            )}
                            {c.supported && c.quote && (
                              <span className="mt-0.5 block border-l-2 pl-2 text-muted-foreground">
                                “{c.quote}”
                              </span>
                            )}
                            {!c.supported && (
                              <span className="ml-1 text-amber-600">— 출처에서 확인 안 됨</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {askResult.trace?.length > 0 && (
                  <details className="mt-3 border-t pt-3">
                    <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                      추론 과정 ({askResult.trace.length}단계)
                    </summary>
                    <ol className="mt-1.5 flex flex-col gap-1">
                      {askResult.trace.map((t, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 text-[11px] text-muted-foreground"
                        >
                          <span className="mt-0.5 shrink-0 rounded bg-muted px-1 font-mono text-[10px]">
                            {i + 1}
                          </span>
                          <span className="min-w-0">{t.summary}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {askResult.answer && !askResult.no_evidence && (
                  <div className="mt-3 flex items-center gap-2 border-t pt-2 text-[11px] text-muted-foreground">
                    {feedbackSent ? (
                      <span>피드백 감사합니다 {feedbackSent > 0 ? '👍' : '👎'}</span>
                    ) : (
                      <>
                        <span>이 답변이 도움이 되었나요?</span>
                        <button
                          type="button"
                          onClick={() => sendFeedback(1)}
                          className="rounded p-1 hover:bg-muted hover:text-emerald-600"
                          title="도움이 됨"
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => sendFeedback(-1)}
                          className="rounded p-1 hover:bg-muted hover:text-amber-600"
                          title="도움 안 됨"
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                )}
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

      {/* 키워드/의미 검색 결과 — 타이핑 시 항상 표시(AI 답변과 공존). */}
      <>
      {/* 저장된 검색(스마트 폴더) — 현재 필터 조합 저장 + 저장분 적용. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setSavedOpen((v) => !v)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs text-muted-foreground hover:bg-muted"
          >
            <Bookmark className="h-3.5 w-3.5" />
            저장된 검색
            {saved.length > 0 && (
              <span className="rounded bg-muted px-1 text-[10px]">{saved.length}</span>
            )}
          </button>
          {savedOpen && (
            <div className="absolute z-20 mt-1 max-h-80 w-72 overflow-auto rounded-md border bg-popover p-1 shadow-md">
              {saved.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  저장된 검색이 없습니다. 조건을 걸고 “현재 조건 저장”을 눌러 보세요.
                </p>
              ) : (
                saved.map((s) => (
                  <div
                    key={s.id}
                    className="group flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted"
                  >
                    <button
                      type="button"
                      onClick={() => applySaved(s)}
                      className="flex min-w-0 flex-1 flex-col items-start text-left"
                    >
                      <span className="w-full truncate font-medium text-foreground">
                        {s.name}
                      </span>
                      <span className="w-full truncate text-[11px] text-muted-foreground">
                        {s.query ? `“${s.query}”` : '조건 검색'}
                        {s.mode === 'semantic' ? ' · 의미' : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => toggleSubscribe(s, e)}
                      className={`shrink-0 rounded p-1 hover:bg-background ${
                        s.subscribed
                          ? 'text-primary'
                          : 'text-muted-foreground opacity-0 group-hover:opacity-100'
                      }`}
                      title={
                        s.subscribed
                          ? '구독 중 — 새 보고서가 뜨면 알림. 끄기'
                          : '구독 — 이 조건에 새 보고서가 뜨면 알림'
                      }
                    >
                      {s.subscribed ? (
                        <Bell className="h-3.5 w-3.5" />
                      ) : (
                        <BellOff className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => removeSaved(s.id, e)}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100"
                      title="삭제"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={saveCurrentSearch}
          disabled={!canSearch || savingSearch}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
          title={canSearch ? '현재 검색어·필터 조합을 저장' : '검색어나 필터를 먼저 거세요'}
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
          현재 조건 저장
        </button>
      </div>

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

        {/* (B) 날짜 범위 — 프리셋(최근 N일·이번 달 등) 또는 직접 지정. */}
        <label
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          title="작성일자(또는 등록일자) 범위로 좁힙니다"
        >
          기간
          <select
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value)}
            className="h-7 rounded-md border bg-background px-2 text-xs"
          >
            {DATE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {datePreset === 'custom' && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-7 rounded-md border bg-background px-1.5 text-xs"
            />
            <span>~</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-7 rounded-md border bg-background px-1.5 text-xs"
            />
          </span>
        )}
        {hasDateFilter && (
          <label
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            title="report_date=보고서에 적힌 작성일자 / created_at=시스템 등록 시각"
          >
            기준
            <select
              value={dateField}
              onChange={(e) => setDateField(e.target.value)}
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value="report_date">작성일자</option>
              <option value="created_at">등록일자</option>
            </select>
          </label>
        )}

        {/* (B) 보고서 종류(단일). 목록 있을 때만 노출. */}
        {typeOptions.length > 0 && (
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            종류
            <select
              value={typeId ?? 'all'}
              onChange={(e) =>
                setTypeId(e.target.value === 'all' ? null : Number(e.target.value))
              }
              className="h-7 rounded-md border bg-background px-2 text-xs"
            >
              <option value="all">전체</option>
              {typeOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* (B) 협업 단계(멀티 토글). */}
        <span className="inline-flex items-center gap-1">
          {PHASE_OPTIONS.map((p) => {
            const on = phaseFilter.includes(p.key)
            return (
              <button
                key={p.key}
                type="button"
                onClick={() =>
                  setPhaseFilter((prev) =>
                    on ? prev.filter((x) => x !== p.key) : [...prev, p.key],
                  )
                }
                className={`h-7 rounded-md border px-2 text-xs transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                {p.label}
              </button>
            )
          })}
        </span>

        {/* (#4) 작성자 멀티 피커 — 이름/이메일 검색 + "내가 작성" 빠른 토글. */}
        <div className="relative">
          <div className="flex items-center gap-1">
            {me?.id != null && (
              <button
                type="button"
                onClick={toggleMeAuthor}
                className={`h-7 rounded-md border px-2 text-xs transition-colors ${
                  meIsAuthor
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted'
                }`}
                title="내가 작성(소유)한 보고서"
              >
                내가 작성
              </button>
            )}
            <input
              value={authorQuery}
              onChange={(e) => {
                setAuthorQuery(e.target.value)
                setAuthorOpen(true)
              }}
              onFocus={() => setAuthorOpen(true)}
              placeholder="작성자…"
              className="h-7 w-24 rounded-md border bg-background px-2 text-xs"
            />
          </div>
          {authorOpen && authorResults.length > 0 && (
            <div className="absolute z-20 mt-1 w-56 overflow-hidden rounded-md border bg-popover p-1 shadow-md">
              {authorResults.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => addAuthor({ id: u.id, name: u.name })}
                  className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted"
                >
                  {u.name}
                  {u.email && (
                    <span className="ml-1 text-[11px] text-muted-foreground">
                      {u.email}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* (#4) 자유 태그 필터 — Enter 로 칩 추가. */}
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addTag(tagInput)
            }
          }}
          placeholder="#태그"
          className="h-7 w-20 rounded-md border bg-background px-2 text-xs"
        />

        {/* (#3) 정렬. */}
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          정렬
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-7 rounded-md border bg-background px-2 text-xs"
          >
            <option value="relevance">관련도</option>
            <option value="recent">작성일 최신</option>
            <option value="oldest">작성일 오래된</option>
          </select>
        </label>
      </div>

      {/* (#3) 활성 필터 요약 칩 + 초기화 — 무엇이 걸렸는지 한눈에. */}
      {anyFilterActive && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {authorFilter.map((a) => (
            <FilterChip key={`au-${a.id}`} onRemove={() => removeAuthor(a.id)}>
              작성자: {a.name}
            </FilterChip>
          ))}
          {tagFilter.map((t) => (
            <FilterChip key={`tag-${t}`} onRemove={() => removeTag(t)}>
              #{t}
            </FilterChip>
          ))}
          <button
            type="button"
            onClick={clearAllFilters}
            className="ml-1 inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
            필터 초기화
          </button>
        </div>
      )}

      {canSearch && (
        <p className="mb-3 text-xs text-muted-foreground">
          {loading && results.length === 0 ? '검색 중…' : `결과 ${total}건`}
        </p>
      )}

      {!canSearch && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          두 글자 이상 입력하거나, 태그·연도·기간·종류·단계 필터를 걸면 검색합니다.
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
    </div>
  )
}
