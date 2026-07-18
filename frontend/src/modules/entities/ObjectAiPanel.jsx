// 객체 AI 패널 — 객체 프로필의 "이 객체에 대해" 섹션. 아카이브 전체가 아니라
// *이 객체를 태깅한 (가시) 보고서*로 스코핑된 요약 + 단발 Q&A. 서버 엔드포인트
// (/api/ai/entities/{id}/summary·/ask)를 얇게 감싼다. 히스토리·영속화 없음(단발).
// rag_qa 권한이 있을 때만 프로필 페이지가 이 패널을 렌더한다.
import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Send, Square, FileText } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Markdown } from '@/shared/components/Markdown'
import { getEntitySummary, askEntity } from '@/shared/api/ai'

/** 섹션 카드 래퍼 — ObjectProfilePage 의 것과 동일 톤(자체 정의로 결합 회피). */
function PanelCard({ children }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">이 객체에 대해 (AI)</h2>
        <span className="text-[11px] text-muted-foreground">
          이 객체를 다룬 보고서만 근거로
        </span>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  )
}

/** 인용 목록 — ChatPage 패턴 재사용(보고서로 이동). */
function Citations({ citations, navigate }) {
  if (!citations?.length) return null
  return (
    <div className="mt-2 border-t pt-2">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">출처</p>
      <div className="flex flex-col gap-1">
        {citations.map((c) => (
          <button
            key={c.n}
            type="button"
            onClick={() => navigate(`/w/${c.workspace_slug}/reports/${c.report_id}`)}
            className="flex items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-muted"
          >
            <span className="mt-0.5 shrink-0 rounded bg-primary/15 px-1.5 text-[10px] font-bold text-primary">
              [{c.n}]
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {c.title || `보고서 ${c.report_id}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function ObjectAiPanel({ entityId }) {
  const navigate = useNavigate()

  // 요약 — 온디맨드(버튼). 캐시 없음.
  const [summary, setSummary] = useState(null) // {summary, report_count, no_evidence} | null
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState('')

  // Q&A — 단발(히스토리 없음). 진행 중 요청은 abort 로 중단(서버 LLM 생성도 멈춤).
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState(null) // {answer, citations, no_evidence} | null
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState('')
  const abortRef = useRef(null)

  async function loadSummary() {
    setSummaryLoading(true)
    setSummaryError('')
    try {
      setSummary(await getEntitySummary(entityId))
    } catch (e) {
      setSummaryError(
        e?.response?.data?.message || e?.message || '요약에 실패했습니다.',
      )
    } finally {
      setSummaryLoading(false)
    }
  }

  async function submit(e) {
    e?.preventDefault?.()
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setAskError('')
    setAnswer(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await askEntity(entityId, { query: q, signal: controller.signal })
      setAnswer(res)
    } catch (e) {
      if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED') {
        // 사용자가 중단 — 조용히.
      } else {
        setAskError(
          e?.response?.data?.message || e?.message || '질문 처리에 실패했습니다.',
        )
      }
    } finally {
      setAsking(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  return (
    <PanelCard>
      {/* 요약 */}
      <div>
        {summary == null ? (
          <Button
            variant="outline"
            size="sm"
            onClick={loadSummary}
            disabled={summaryLoading}
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {summaryLoading ? '요약 생성 중…' : 'AI 요약 생성'}
          </Button>
        ) : (
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">
                AI 요약
                {summary.report_count > 0 && ` · 보고서 ${summary.report_count}건 기반`}
              </span>
              <button
                type="button"
                onClick={loadSummary}
                disabled={summaryLoading}
                className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {summaryLoading ? '…' : '다시 생성'}
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm">{summary.summary}</p>
          </div>
        )}
        {summaryError && (
          <p className="mt-1 text-xs text-destructive">{summaryError}</p>
        )}
      </div>

      {/* Q&A */}
      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="이 객체에 대해 질문… (예: 최근 이슈는?)"
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        {asking ? (
          <Button type="button" variant="outline" size="sm" onClick={stop}>
            <Square className="mr-1 h-3.5 w-3.5" /> 중단
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={!question.trim()}>
            <Send className="mr-1 h-3.5 w-3.5" /> 질문
          </Button>
        )}
      </form>
      {askError && <p className="text-xs text-destructive">{askError}</p>}
      {asking && !answer && (
        <p className="text-sm text-muted-foreground">답변 생성 중…</p>
      )}
      {answer && (
        <div className="rounded-md border p-3">
          {answer.no_evidence ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              {answer.answer || '근거가 될 보고서를 찾지 못했습니다.'}
            </p>
          ) : (
            <>
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <Markdown>{answer.answer}</Markdown>
              </div>
              <Citations citations={answer.citations} navigate={navigate} />
            </>
          )}
        </div>
      )}
    </PanelCard>
  )
}

export default ObjectAiPanel
