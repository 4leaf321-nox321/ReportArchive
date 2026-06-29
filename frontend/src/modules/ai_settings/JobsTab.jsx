import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RefreshCw,
  RotateCcw,
  XCircle,
  Trash2,
  Cpu,
  Server,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import {
  getJobStats,
  getJobsHealth,
  listJobs,
  retryJob,
  retryJobs,
  cancelJob,
  purgeJobs,
} from '@/shared/api/jobsAdmin'

// 통계는 싸다(DB 카운트) → 자주. 헬스는 LLM 네트워크 프로브(끊겼을 때 최대 5s)
// 가 끼어 비싸다 → 드물게.
const STATS_POLL_MS = 5000
const HEALTH_POLL_MS = 15000

const STATUS_FILTERS = [
  { value: '', label: '전체' },
  { value: 'pending', label: '대기' },
  { value: 'running', label: '처리중' },
  { value: 'failed', label: '실패' },
  { value: 'done', label: '완료' },
  { value: 'canceled', label: '취소' },
]

const STATUS_BADGE = {
  pending: { variant: 'secondary', label: '대기' },
  running: { variant: 'default', label: '처리중' },
  failed: { variant: 'destructive', label: '실패' },
  done: { variant: 'outline', label: '완료' },
  canceled: { variant: 'outline', label: '취소' },
}

function errMsg(err, fallback) {
  return err?.response?.data?.message || err?.message || fallback
}

function fmtAge(seconds) {
  if (seconds == null) return '—'
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분`
  if (s < 86400) return `${Math.floor(s / 3600)}시간`
  return `${Math.floor(s / 86400)}일`
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 작업 큐 운영 탭 — 백그라운드 잡 큐를 한눈에 보고(통계·헬스), 실패한 잡을
 * 재시도/취소/정리한다. AiSettingsPage 가 is_system_admin 일 때만 노출하고,
 * 엔드포인트도 require_system_admin 으로 이중 방어. 상단 헬스 배지로 LLM/워커가
 * 죽었을 때 "조용한 실패"를 즉시 알아챈다.
 */
export function JobsTab() {
  const [stats, setStats] = useState(null)
  const [health, setHealth] = useState(null)
  const [jobs, setJobs] = useState(null)
  const [statusFilter, setStatusFilter] = useState('failed')
  const [typeFilter, setTypeFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(null) // 펼친 last_error 의 job id
  const filtersRef = useRef({ statusFilter, typeFilter })
  filtersRef.current = { statusFilter, typeFilter }

  const loadJobs = useCallback(async () => {
    const { statusFilter: s, typeFilter: t } = filtersRef.current
    try {
      const d = await listJobs({ status: s || undefined, type: t || undefined })
      setJobs(d)
    } catch (err) {
      toast.error(errMsg(err, '작업 목록을 불러오지 못했습니다.'))
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      setStats(await getJobStats())
    } catch (err) {
      // 폴링 중 일시 실패는 조용히(토스트 폭주 방지).
      console.warn('jobs stats poll failed', err)
    }
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await getJobsHealth())
    } catch (err) {
      console.warn('jobs health poll failed', err)
    }
  }, [])

  // 마운트 시 1회 + 주기 폴링(통계 자주, 헬스 드물게). 잡 목록은 필터 변경/액션 시 갱신.
  useEffect(() => {
    loadStats()
    const id = setInterval(loadStats, STATS_POLL_MS)
    return () => clearInterval(id)
  }, [loadStats])

  useEffect(() => {
    loadHealth()
    const id = setInterval(loadHealth, HEALTH_POLL_MS)
    return () => clearInterval(id)
  }, [loadHealth])

  useEffect(() => {
    loadJobs()
  }, [loadJobs, statusFilter, typeFilter])

  async function refreshAll() {
    await Promise.all([loadStats(), loadHealth(), loadJobs()])
  }

  async function withBusy(fn, okMsg) {
    setBusy(true)
    try {
      await fn()
      if (okMsg) toast.success(okMsg)
      await refreshAll()
    } catch (err) {
      toast.error(errMsg(err, '처리에 실패했습니다.'))
    } finally {
      setBusy(false)
    }
  }

  const onRetryAll = () =>
    withBusy(async () => {
      const { requeued } = await retryJobs({ status: 'failed' })
      toast.success(`실패한 잡 ${requeued}건을 재시도 큐에 넣었습니다.`)
    })

  const onPurgeDone = () =>
    withBusy(async () => {
      const { purged } = await purgeJobs({ status: 'done', olderThanDays: 7 })
      toast.success(`완료된 오래된 잡 ${purged}건을 정리했습니다.`)
    })

  const onRetryOne = (id) => withBusy(() => retryJob(id), '재시도 큐에 넣었습니다.')
  const onCancelOne = (id) => withBusy(() => cancelJob(id), '취소했습니다.')

  const typeOptions = stats ? Object.keys(stats.by_type || {}) : []
  const items = jobs?.items ?? []

  return (
    <div className="space-y-4">
      <HealthBar health={health} stats={stats} />

      <StatCards stats={stats} />

      {/* 액션 바 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={onRetryAll}
          disabled={busy || !stats?.failed}
          title="실패한 모든 잡을 재시도 큐로 되돌립니다(LLM 복구 후 한 번에 복구)."
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          실패 전체 재시도{stats?.failed ? ` (${stats.failed})` : ''}
        </Button>
        <Button size="sm" variant="outline" onClick={onPurgeDone} disabled={busy}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          완료 7일+ 정리
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                상태: {s.label}
              </option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">종류: 전체</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" onClick={refreshAll} disabled={busy}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 잡 테이블 */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">종류</th>
                  <th className="px-3 py-2 text-left font-medium">상태</th>
                  <th className="px-3 py-2 text-left font-medium">시도</th>
                  <th className="px-3 py-2 text-left font-medium">갱신</th>
                  <th className="px-3 py-2 text-left font-medium">오류</th>
                  <th className="px-3 py-2 text-right font-medium">조치</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-10 text-center text-muted-foreground"
                    >
                      {jobs ? '해당하는 작업이 없습니다.' : '불러오는 중…'}
                    </td>
                  </tr>
                )}
                {items.map((j) => {
                  const badge = STATUS_BADGE[j.status] || {
                    variant: 'outline',
                    label: j.status,
                  }
                  const isOpen = expanded === j.id
                  return (
                    <tr key={j.id} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {j.id}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{j.type}</td>
                      <td className="px-3 py-2">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {j.attempts}/{j.max_attempts}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {fmtTime(j.updated_at)}
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[28rem]">
                        {j.last_error ? (
                          <button
                            type="button"
                            onClick={() => setExpanded(isOpen ? null : j.id)}
                            className="text-left text-destructive/90 hover:underline"
                            title="클릭하여 전체 오류 보기"
                          >
                            {isOpen ? (
                              <span className="block whitespace-pre-wrap break-words font-mono">
                                {j.last_error}
                              </span>
                            ) : (
                              <span className="line-clamp-1 break-all">
                                {j.last_error.split('\n').slice(-1)[0]}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {(j.status === 'failed' || j.status === 'canceled') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => onRetryOne(j.id)}
                            title="재시도"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {j.status === 'pending' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => onCancelOne(j.id)}
                            title="취소"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      {jobs && jobs.total > items.length && (
        <p className="text-center text-xs text-muted-foreground">
          최근 {items.length}건 표시 · 총 {jobs.total}건
        </p>
      )}
    </div>
  )
}

function HealthBar({ health, stats }) {
  const worker = health?.worker
  const llm = health?.llm
  const workerOk = worker?.alive
  const llmOk = llm?.reachable
  const failedSpike = (stats?.recent_failed ?? 0) > 0

  return (
    <div className="flex flex-wrap items-center gap-2">
      <HealthBadge
        ok={workerOk}
        icon={Server}
        okLabel={`워커 정상 (${worker?.count ?? 0})`}
        badLabel="워커 정지"
        loading={!health}
      />
      <HealthBadge
        ok={llmOk}
        icon={Cpu}
        okLabel={`LLM 연결됨${llm?.backend ? ` · ${llm.backend}` : ''}`}
        badLabel={`LLM 끊김${llm?.backend ? ` · ${llm.backend}` : ''}`}
        loading={!health}
      />
      {failedSpike && (
        <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5" />
          최근 {stats.recent_failed_hours}시간 실패 {stats.recent_failed}건
        </span>
      )}
    </div>
  )
}

function HealthBadge({ ok, icon: Icon, okLabel, badLabel, loading }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> 확인 중…
      </span>
    )
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
        ok
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-destructive/40 bg-destructive/5 text-destructive'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {ok ? okLabel : badLabel}
    </span>
  )
}

function StatCards({ stats }) {
  const cards = [
    { key: 'pending', label: '대기', value: stats?.pending },
    { key: 'running', label: '처리중', value: stats?.running },
    { key: 'failed', label: '실패', value: stats?.failed, danger: true },
    { key: 'done', label: '완료', value: stats?.done },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.key}>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {c.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-semibold ${
                c.danger && c.value > 0 ? 'text-destructive' : ''
              }`}
            >
              {c.value ?? '—'}
            </div>
            {c.key === 'pending' && stats?.oldest_pending_age_s != null && (
              <div className="text-xs text-muted-foreground">
                최장 대기 {fmtAge(stats.oldest_pending_age_s)}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export default JobsTab
