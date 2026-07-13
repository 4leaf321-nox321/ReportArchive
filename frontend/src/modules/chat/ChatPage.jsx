import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MessageSquare,
  Send,
  Loader2,
  RotateCcw,
  Square,
  Network,
  AlertTriangle,
  ShieldCheck,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Markdown } from '@/shared/components/Markdown'
import {
  askAgentStream,
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
} from '@/shared/api/ai'

// 서버에 보낼 대화 히스토리 상한(서버도 12로 캡). 길면 컨텍스트·비용↑.
const HISTORY_TURNS = 12

function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user')
  const t = (firstUser?.content || '새 대화').trim()
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

/**
 * 대화형 에이전트 검색 (Phase: 대화형 에이전트 검색). 아카이브 근거로 답하는 에이전트와
 * 대화하며 후속 질문으로 좁혀간다. 서버 stateless — 대화는 프론트가 보관해 매 요청에
 * 최근 N턴을 함께 보내고, 매 턴 끝에 서버(ai_conversations)에 자동 저장한다(좌측 목록에서
 * 지난 대화 되살리기). 서버가 후속을 독립형 질문으로 재작성.
 */
export default function ChatPage() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const activeIdRef = useRef(null)
  const abortRef = useRef(null)
  const endRef = useRef(null)

  const setActive = (id) => {
    activeIdRef.current = id
    setActiveId(id)
  }

  const loadList = useCallback(async () => {
    try {
      const d = await listConversations()
      setConversations(d.items || [])
    } catch {
      /* 목록 로드 실패는 조용히(대화 자체엔 영향 없음) */
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  const persist = useCallback(
    async (msgs) => {
      try {
        if (activeIdRef.current) {
          await updateConversation(activeIdRef.current, { messages: msgs })
        } else {
          const created = await createConversation({
            title: deriveTitle(msgs),
            messages: msgs,
          })
          setActive(created.id)
        }
        loadList()
      } catch {
        /* 저장 실패는 조용히 — 대화는 계속 진행 */
      }
    },
    [loadList],
  )

  const send = useCallback(async () => {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    const history = messages
      .map((m) => ({
        role: m.role,
        content: m.role === 'assistant' ? m.result?.answer || '' : m.content,
      }))
      .filter((m) => m.content)
      .slice(-HISTORY_TURNS)
    const afterUser = [...messages, { role: 'user', content: q }]
    // 스트리밍 placeholder — 진행 상황·토큰 이벤트로 실시간 갱신.
    setMessages([
      ...afterUser,
      { role: 'assistant', content: '', result: null, streaming: true, progress: [], rewritten: null },
    ])
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller

    const updateLast = (fn) =>
      setMessages((prev) => {
        if (prev.length === 0) return prev
        const copy = prev.slice()
        copy[copy.length - 1] = fn(copy[copy.length - 1])
        return copy
      })

    let liveContent = ''
    const progress = []
    let doneResult = null
    try {
      await askAgentStream({
        query: q,
        history,
        signal: controller.signal,
        onEvent: (evt) => {
          if (evt.type === 'rewrite') {
            updateLast((m) => ({ ...m, rewritten: evt.query }))
          } else if (evt.type === 'progress') {
            progress.push(evt.summary)
            updateLast((m) => ({ ...m, progress: [...progress] }))
          } else if (evt.type === 'token') {
            liveContent += evt.text || ''
            updateLast((m) => ({ ...m, content: liveContent }))
          } else if (evt.type === 'done') {
            doneResult = evt
            updateLast((m) => ({
              ...m,
              content: evt.answer || liveContent,
              result: evt,
              streaming: false,
            }))
          } else if (evt.type === 'error') {
            updateLast((m) => ({ ...m, content: evt.message || '답변 생성 실패', streaming: false }))
          }
        },
      })
      // 저장 — 스트리밍 플래그 없는 최종 메시지로 정규화.
      const finalMsgs = [
        ...afterUser,
        { role: 'assistant', content: doneResult?.answer || liveContent, result: doneResult },
      ]
      setMessages(finalMsgs)
      if (doneResult) persist(finalMsgs)
    } catch (err) {
      const canceled = err?.name === 'AbortError'
      updateLast((m) => ({
        ...m,
        content: m.content || (canceled ? '(중단됨)' : '답변 생성에 실패했습니다.'),
        streaming: false,
      }))
      if (!canceled) toast.error(err?.message || '답변 생성 실패')
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [input, busy, messages, persist])

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function newChat() {
    if (busy) return
    setMessages([])
    setInput('')
    setActive(null)
  }

  async function openConv(id) {
    if (busy) return
    try {
      const d = await getConversation(id)
      setMessages(d.messages || [])
      setActive(d.id)
    } catch {
      toast.error('대화를 불러오지 못했습니다.')
    }
  }

  async function removeConv(id, e) {
    e.stopPropagation()
    try {
      await deleteConversation(id)
      if (activeIdRef.current === id) newChat()
      loadList()
    } catch {
      toast.error('대화 삭제에 실패했습니다.')
    }
  }

  return (
    <div className="flex h-full">
      {/* 좌측 — 지난 대화 목록 */}
      <aside className="hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="p-3">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={newChat}
            disabled={busy}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> 새 대화
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              저장된 대화가 없습니다.
            </p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => openConv(c.id)}
                className={`group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${
                  c.id === activeId ? 'bg-muted font-medium' : ''
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{c.title || '새 대화'}</span>
                <button
                  type="button"
                  onClick={(e) => removeConv(c.id, e)}
                  className="shrink-0 opacity-0 group-hover:opacity-100"
                  title="대화 삭제"
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* 우측 — 스레드 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-6 py-3">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">대화</h1>
          <span className="hidden text-xs text-muted-foreground lg:inline">
            아카이브 근거로 답하는 에이전트와 대화하며 좁혀가세요.
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto md:hidden"
            onClick={newChat}
            disabled={busy}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />새 대화
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 && !busy && (
            <div className="mx-auto max-w-2xl pt-16 text-center text-sm text-muted-foreground">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-40" />
              질문을 입력하면 에이전트가 온톨로지·보고서를 조사해 답합니다.
              <br />
              이어서 “그 중 2024년만?” 처럼 후속 질문으로 좁혀갈 수 있어요.
            </div>
          )}
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m, i) => (
              <MessageBubble key={i} m={m} navigate={navigate} />
            ))}
            <div ref={endRef} />
          </div>
        </div>

        <div className="border-t px-6 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="질문을 입력하세요 (Enter 전송 · Shift+Enter 줄바꿈)"
              className="max-h-40 min-h-[40px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {busy ? (
              <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                <Square className="mr-1.5 h-3.5 w-3.5" />중단
              </Button>
            ) : (
              <Button onClick={send} disabled={!input.trim()}>
                <Send className="mr-1.5 h-3.5 w-3.5" />전송
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ m, navigate }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
          {m.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl border bg-card px-4 py-3">
        {m.result ? (
          <AssistantAnswer r={m.result} navigate={navigate} />
        ) : (
          <StreamingView m={m} />
        )}
      </div>
    </div>
  )
}

function StreamingView({ m }) {
  return (
    <div>
      {m.rewritten && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          이렇게 이해했어요: <span className="italic">“{m.rewritten}”</span>
        </p>
      )}
      {m.progress?.length > 0 && (
        <div className="mb-2 flex flex-col gap-0.5">
          {m.progress.map((p, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
              {p}
            </span>
          ))}
        </div>
      )}
      {m.content ? (
        <Markdown className="text-sm leading-relaxed">{m.content}</Markdown>
      ) : (
        m.streaming && (
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 조사 중…
          </span>
        )
      )}
    </div>
  )
}

function AssistantAnswer({ r, navigate }) {
  if (r.no_evidence) {
    return (
      <p className="text-sm text-muted-foreground">
        {r.answer || '관련 근거를 찾지 못했습니다.'}
      </p>
    )
  }
  return (
    <div>
      {r.rewritten_query && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          이렇게 이해했어요: <span className="italic">“{r.rewritten_query}”</span>
        </p>
      )}
      {r.objects?.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <Network className="h-3.5 w-3.5" /> 관련 객체
          </span>
          {r.objects.map((o) => (
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

      <Markdown className="text-sm leading-relaxed">{r.answer}</Markdown>

      {r.verification?.claims?.length > 0 && (
        <details className="mt-3 border-t pt-3" open={r.verification.unsupported > 0}>
          <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium">
            {r.verification.unsupported > 0 ? (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="h-3.5 w-3.5" />
                근거 검증 — 근거 불충분 {r.verification.unsupported}건
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <ShieldCheck className="h-3.5 w-3.5" />
                근거 검증 — 모든 주장이 출처로 뒷받침됨
              </span>
            )}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {r.verification.claims.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px]">
                {c.supported ? (
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                )}
                <span className="min-w-0">
                  {c.text}
                  {!c.supported && (
                    <span className="ml-1 text-amber-600">— 출처에서 확인 안 됨</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {r.trace?.length > 0 && (
        <details className="mt-3 border-t pt-3">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
            추론 과정 ({r.trace.length}단계)
          </summary>
          <ol className="mt-1.5 flex flex-col gap-1">
            {r.trace.map((t, i) => (
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

      {r.citations?.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">출처</p>
          <div className="flex flex-col gap-1">
            {r.citations.map((c) => (
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
      )}
    </div>
  )
}
