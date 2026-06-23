import { useEffect, useState } from 'react'
import { Activity, Plug, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Label } from '@/shared/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { getAiDiagConfig, pingAi, chatAiDiag } from '@/shared/api/ai'

/**
 * 연결·진단 탭 — B300(생성 LLM) 연결을 *서버 경유*로 확인한다(브라우저가 직접
 * B300 를 부르지 않는다). 같은 화면이 dev(mock/스텁) 검증 · 운영 실연결 스모크 ·
 * 상시 헬스체크를 겸한다. B300_보조AI_설계.md §T.
 *
 * AiSettingsPage 가 me.is_system_admin 일 때만 이 탭을 노출한다(엔드포인트도
 * require_system_admin 으로 이중 방어).
 */
export function DiagnosticsTab() {
  return (
    <div className="max-w-2xl space-y-4">
      <ConnectionCard />
      <PlaygroundCard />
    </div>
  )
}

function errMsg(err, fallback) {
  return err?.response?.data?.message || err?.message || fallback
}

function ConnectionCard() {
  const [cfg, setCfg] = useState(null)
  const [loading, setLoading] = useState(true)
  const [pinging, setPinging] = useState(false)
  const [ping, setPing] = useState(null) // { ok, latency_ms, ... } | { error }

  useEffect(() => {
    let alive = true
    getAiDiagConfig()
      .then((d) => alive && setCfg(d))
      .catch((err) => alive && toast.error(errMsg(err, '설정을 불러오지 못했습니다.')))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  async function onPing() {
    setPinging(true)
    setPing(null)
    try {
      setPing(await pingAi())
    } catch (err) {
      setPing({ error: errMsg(err, '연결 실패') })
    } finally {
      setPinging(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">생성 LLM 연결 (B300)</CardTitle>
        </div>
        <CardDescription>
          현재 설정된 백엔드로 서버가 직접 모델을 호출해 연결을 확인합니다. <code className="font-mono">mock</code>
          은 네트워크 없이 동작하고, <code className="font-mono">openai</code>(운영 B300)는 앱 서버에서만 닿습니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">설정 불러오는 중...</p>
        ) : cfg ? (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">backend</span>
            <span className="font-mono">
              {cfg.backend}{' '}
              {cfg.backend === 'mock' && (
                <Badge variant="outline" className="ml-1">미연결(mock)</Badge>
              )}
            </span>
            <span className="text-muted-foreground">base_url</span>
            <span className="font-mono break-all">{cfg.base_url}</span>
            <span className="text-muted-foreground">model</span>
            <span className="font-mono">{cfg.model}</span>
            <span className="text-muted-foreground">인증키</span>
            <span className="font-mono">{cfg.has_api_key ? '설정됨' : '(없음)'}</span>
            <span className="text-muted-foreground">reasoning</span>
            <span className="font-mono">{cfg.reasoning_effort || '(기본)'}</span>
          </div>
        ) : (
          <p className="text-sm text-destructive">설정을 불러오지 못했습니다.</p>
        )}

        <Separator />

        <Button type="button" size="sm" onClick={onPing} disabled={pinging}>
          <Activity className="mr-2 h-3.5 w-3.5" />
          {pinging ? '확인 중...' : '연결 테스트'}
        </Button>

        {ping && (
          ping.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              ❌ {ping.error}
            </div>
          ) : (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-1 text-sm">
              <div className="font-medium text-primary">
                ✅ 연결됨 · {ping.latency_ms}ms · 모델 {ping.model_returned}
              </div>
              <div className="text-xs text-muted-foreground">
                reasoning 필드: {ping.has_reasoning ? '있음' : '없음'}
                {Array.isArray(ping.models) && ping.models.length > 0 && (
                  <> · 서빙 모델: {ping.models.join(', ')}</>
                )}
              </div>
              {ping.content_preview && (
                <div className="text-xs font-mono text-muted-foreground break-all">
                  ↳ {ping.content_preview}
                </div>
              )}
            </div>
          )
        )}
      </CardContent>
    </Card>
  )
}

function PlaygroundCard() {
  const [prompt, setPrompt] = useState('한 문장으로 자기소개를 해줘.')
  const [effort, setEffort] = useState('') // '' = 서버 기본값
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [showReasoning, setShowReasoning] = useState(false)

  async function onSend(e) {
    e.preventDefault()
    if (!prompt.trim()) return
    setSending(true)
    setResult(null)
    try {
      const data = await chatAiDiag({
        prompt: prompt.trim(),
        reasoningEffort: effort || null,
      })
      setResult(data)
    } catch (err) {
      toast.error(errMsg(err, 'LLM 호출 실패'))
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">프롬프트 플레이그라운드</CardTitle>
        </div>
        <CardDescription>
          아무 문장이나 보내 모델 응답을 그대로 확인합니다(통화 테스트). 답변 외에 사고
          과정(reasoning)이 따로 오면 접어서 보여줍니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSend} className="space-y-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            maxLength={8000}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="모델에 보낼 프롬프트"
          />
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="diag-effort">reasoning</Label>
              <select
                id="diag-effort"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">기본</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
            <Button type="submit" disabled={sending || !prompt.trim()}>
              {sending ? '전송 중...' : '전송'}
            </Button>
          </div>
        </form>

        {result && (
          <div className="mt-4 space-y-2">
            <div className="text-xs text-muted-foreground">
              {result.backend} · {result.model} · {result.latency_ms}ms
              {result.usage && (
                <> · tokens {result.usage.total_tokens ?? '—'}</>
              )}
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap break-words">
              {result.content || <span className="text-muted-foreground">(빈 응답)</span>}
            </div>
            {result.reasoning && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowReasoning((v) => !v)}
                  className="text-xs text-muted-foreground underline"
                >
                  {showReasoning ? '▾ 사고 과정 숨기기' : '▸ 사고 과정 보기'}
                </button>
                {showReasoning && (
                  <div className="mt-1 rounded-md border border-dashed p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground">
                    {result.reasoning}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
