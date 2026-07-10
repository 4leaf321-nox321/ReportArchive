import { useEffect, useState } from 'react'
import { Plus, Trash2, Play, Loader2, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import {
  listEvalCases,
  createEvalCase,
  updateEvalCase,
  deleteEvalCase,
  runEval,
  searchReportsForPicker,
} from '@/shared/api/ai'

/**
 * "평가" 탭 — RAG 검색 평가(로드맵 7). 골든셋(질문+정답 보고서)을 관리하고 버튼으로
 * 평가를 돌려 recall/precision/MRR 을 본다. 임계·설정을 바꾼 전후 점수를 비교해
 * 근거 기반 튜닝. (임베딩/생성 AI 가 mock 이면 검색이 비결정적 → 숫자는 참고용.)
 */
export function EvalTab() {
  const [cases, setCases] = useState(null)
  const [result, setResult] = useState(null)
  const [running, setRunning] = useState(false)
  const [cfg, setCfg] = useState({ k: 5, graph: false, rerank: false, hyde: false })

  const load = async () => {
    try {
      setCases((await listEvalCases())?.cases || [])
    } catch {
      setCases([])
    }
  }
  useEffect(() => {
    load()
  }, [])

  const addCase = async () => {
    const c = await createEvalCase({ query: '새 질문', expect_report_ids: [], expect_entities: [], graph: false })
    setCases((cs) => [...(cs || []), c])
  }
  const removeCase = async (id) => {
    await deleteEvalCase(id)
    setCases((cs) => cs.filter((c) => c.id !== id))
    setResult(null)
  }
  const saveCase = async (c) => {
    await updateEvalCase(c.id, {
      query: c.query,
      expect_report_ids: c.expect_report_ids,
      expect_entities: c.expect_entities,
      graph: c.graph,
    })
    toast.success('저장했습니다.')
  }
  const patchCase = (id, patch) =>
    setCases((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  const run = async () => {
    setRunning(true)
    try {
      setResult(await runEval(cfg))
    } catch (e) {
      toast.error(e?.response?.data?.message || '평가 실행에 실패했습니다.')
    } finally {
      setRunning(false)
    }
  }

  if (cases === null) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
      </div>
    )
  }

  const resById = {}
  for (const r of result?.cases || []) resById[r.id] = r
  const agg = result?.aggregate
  const kk = result?.config?.k ?? cfg.k

  return (
    <div className="max-w-4xl space-y-5">
      <p className="text-sm text-muted-foreground">
        대표 질문과 <b>정답 보고서</b>를 등록해두고 <b>평가 실행</b>을 누르면, 현재 검색이
        정답을 얼마나 잘 찾는지 점수(recall/precision/MRR)를 냅니다. 임계·설정(재랭킹·HyDE)을
        바꾼 <b>전후 점수를 비교</b>해 튜닝하세요.
        <br />
        <span className="text-[11px]">
          ※ 임베딩·생성 AI가 mock인 환경에선 검색이 비결정적이라 숫자는 참고용입니다(운영에서 유의미).
        </span>
      </p>

      {/* 실행 패널 */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
        <label className="flex items-center gap-1.5 text-xs">
          k
          <Input
            type="number" min={1} max={20} value={cfg.k}
            onChange={(e) => setCfg((s) => ({ ...s, k: parseInt(e.target.value, 10) || 5 }))}
            className="h-8 w-16"
          />
        </label>
        {['graph', 'rerank', 'hyde'].map((key) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox" checked={cfg[key]}
              onChange={(e) => setCfg((s) => ({ ...s, [key]: e.target.checked }))}
              className="h-3.5 w-3.5"
            />
            {key}
          </label>
        ))}
        <Button size="sm" onClick={run} disabled={running || !cases.length}>
          {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
          평가 실행
        </Button>
        {agg && (
          <span className="ml-auto text-xs">
            <b>평균</b> · recall@{kk} {fmt(agg[`recall@${kk}`])} · precision {fmt(agg[`precision@${kk}`])}
            {' '}· MRR {fmt(agg.mrr)} · seed {fmt(agg.seed_recall)}
          </span>
        )}
      </div>

      {/* 케이스 목록 */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">골든셋 ({cases.length})</h3>
        <Button size="sm" variant="outline" onClick={addCase}>
          <Plus className="mr-1 h-3.5 w-3.5" /> 질문 추가
        </Button>
      </div>
      <div className="space-y-3">
        {cases.map((c) => (
          <CaseRow
            key={c.id}
            c={c}
            score={resById[c.id]}
            kk={kk}
            onPatch={patchCase}
            onSave={saveCase}
            onRemove={removeCase}
          />
        ))}
        {!cases.length && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            아직 케이스가 없습니다. “질문 추가”로 시작하세요.
          </p>
        )}
      </div>
    </div>
  )
}

function CaseRow({ c, score, kk, onPatch, onSave, onRemove }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState([])
  const [searching, setSearching] = useState(false)

  const doSearch = async () => {
    if (q.trim().length < 2) return
    setSearching(true)
    try {
      setHits(await searchReportsForPicker(q.trim()))
    } finally {
      setSearching(false)
    }
  }
  const addReport = (r) => {
    if (!c.expect_report_ids.includes(r.id)) {
      onPatch(c.id, { expect_report_ids: [...c.expect_report_ids, r.id], _titles: { ...(c._titles || {}), [r.id]: r.title } })
    }
  }
  const removeReport = (id) =>
    onPatch(c.id, { expect_report_ids: c.expect_report_ids.filter((x) => x !== id) })

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-2">
        <Input
          value={c.query}
          onChange={(e) => onPatch(c.id, { query: e.target.value })}
          placeholder="질문"
          className="flex-1"
        />
        <label className="mt-2 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={c.graph} onChange={(e) => onPatch(c.id, { graph: e.target.checked })} />
          그래프
        </label>
        <Button size="sm" variant="ghost" onClick={() => onSave(c)}>저장</Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onRemove(c.id)}>
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>

      {/* 정답 보고서 */}
      <div className="mt-2">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">정답 보고서:</span>
          {c.expect_report_ids.length === 0 && (
            <span className="text-[11px] text-muted-foreground/70">없음</span>
          )}
          {c.expect_report_ids.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1">
              {(c._titles && c._titles[id]) || `#${id}`}
              <button type="button" onClick={() => removeReport(id)}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="정답 보고서 검색해서 추가…"
            className="h-8 flex-1"
          />
          <Button size="icon" variant="outline" className="h-8 w-8" onClick={doSearch} disabled={searching}>
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {hits.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5 rounded border bg-muted/30 p-1">
            {hits.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => addReport(r)}
                className="truncate rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-muted"
              >
                #{r.id} · {r.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 엔티티(선택) + 점수 */}
      <div className="mt-2 flex items-center gap-2">
        <Input
          value={(c.expect_entities || []).join(', ')}
          onChange={(e) => onPatch(c.id, { expect_entities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          placeholder="기대 객체(선택, 쉼표로 구분)"
          className="h-8 flex-1 text-xs"
        />
        {score && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            recall@{kk} <b>{fmt(score[`recall@${kk}`])}</b> · mrr {fmt(score.mrr)} · seed {fmt(score.seed_recall)}
          </span>
        )}
      </div>
    </div>
  )
}

function fmt(v) {
  return v === null || v === undefined ? '–' : v.toFixed(2)
}
