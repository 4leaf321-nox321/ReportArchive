import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Siren, Play, RefreshCw, Save, ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Card, CardContent } from '@/shared/components/ui/card'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/shared/components/ui/tabs'
import {
  listAlertRules,
  updateAlertRule,
  runAlertRule,
  listAlertFiring,
} from '@/shared/api/alerts'

const PAGE_SIZE = 50

const PHASE_LABEL = { drafting: '작성중', reviewing: '리뷰중', finalized: '발행완료' }

const INTERVAL_LABEL = { 60: '매시간', 360: '6시간마다', 1440: '매일' }

// 규칙의 스케줄을 사람이 읽는 라벨로.
function scheduleLabel(rule) {
  if (rule.schedule_kind === 'interval')
    return INTERVAL_LABEL[rule.interval_minutes] || `${rule.interval_minutes}분마다`
  if (rule.schedule_kind === 'weekly') return '매주(주초)'
  if (rule.schedule_kind === 'monthly') return '매달(달 초)'
  return '꺼짐(수동만)'
}

// 편집 상태 → 드롭다운 인코딩 값(interval 은 iN).
function scheduleValue(edit) {
  if (edit.schedule_kind === 'interval') return `i${edit.interval_minutes}`
  if (edit.schedule_kind === 'weekly') return 'weekly'
  if (edit.schedule_kind === 'monthly') return 'monthly'
  return 'manual'
}

// 규칙(프로브)별 설명·표시 메타. 대상 날짜 컬럼이 프로브마다 다르다(생성 vs 수정).
const PROBE_META = {
  untagged_reports: {
    desc: '게시판에 게시됐지만 엔티티 태그가 하나도 없는 보고서. 온톨로지에 연결되도록 태깅을 유도합니다.',
    dateLabel: '생성',
    dateKey: 'created_at',
    daysHint: '생성 후 경과 일수',
  },
  stale_unpublished: {
    desc: '발행(finalized)되지 않은 채 오래 방치된 보고서(마지막 편집 후 N일). 발행 또는 정리를 유도합니다. 방치 기준은 실제 편집 시각(없으면 생성일)이라, 재색인 등 자동 갱신에는 리셋되지 않습니다.',
    dateLabel: '방치 기준',
    dateKey: 'stale_since',
    daysHint: '마지막 편집(없으면 생성) 후 경과 일수',
  },
}
const DEFAULT_META = { desc: '', dateLabel: '생성', dateKey: 'created_at', daysHint: '경과 일수' }

function errMsg(err, fallback) {
  return err?.response?.data?.message || err?.message || fallback
}

function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 경보 관리자 페이지 (Phase D) — 규칙별 하위 탭으로 나눠, 각 규칙을 수동/자동
 * 실행하고 현재 감지된 대상(감지 목록)을 페이지네이션으로 본다. 규칙은 프로브
 * 조건 + 스케줄(수동/매시간~매달). 알림·이메일은 후속 단계. 사이드바 '경보'(시스템
 * 관리자 전용)로 진입하고 엔드포인트도 require_system_admin 으로 이중 방어.
 */
export default function AlertsAdminPage() {
  const [rules, setRules] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const loadRules = useCallback(async () => {
    try {
      const d = await listAlertRules()
      setRules(d.items)
    } catch (err) {
      toast.error(errMsg(err, '경보 규칙을 불러오지 못했습니다.'))
    }
  }, [])

  useEffect(() => {
    loadRules()
  }, [loadRules])

  if (!rules) {
    return <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
  }
  if (rules.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        등록된 경보 규칙이 없습니다.
      </div>
    )
  }

  // 활성 하위 탭을 URL(?rule=)에 동기화 — 보고서로 갔다 뒤로 오면 원래 규칙 탭 복원.
  // 바깥 ?tab=alerts 는 그대로 두고 rule 만 갱신(replace 로 히스토리 안 어지럽힘).
  const ruleParam = searchParams.get('rule')
  const activeRule = rules.some((r) => String(r.id) === ruleParam)
    ? ruleParam
    : String(rules[0].id)
  const onRuleChange = (value) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('rule', value)
        return next
      },
      { replace: true },
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <Siren className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">경보</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        온톨로지 상태에 걸리는 대상을 규칙으로 점검합니다. 규칙마다 <b>수동/자동
        실행</b>으로 현재 감지된 대상 목록을 갱신합니다. (자동 알림·이메일은
        후속 단계.)
      </p>
      <Tabs
        value={activeRule}
        onValueChange={onRuleChange}
        className="flex flex-1 min-h-0 flex-col"
      >
        <TabsList className="w-fit">
          {rules.map((r) => (
            <TabsTrigger key={r.id} value={String(r.id)} className="gap-1.5">
              {r.name}
              <Badge
                variant={r.firing_count ? 'destructive' : 'outline'}
                className="px-1.5 py-0 text-[11px]"
              >
                {r.firing_count}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
        {rules.map((r) => (
          <TabsContent key={r.id} value={String(r.id)} className="mt-4">
            <RulePanel rule={r} onRulesChanged={loadRules} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function RulePanel({ rule, onRulesChanged }) {
  const meta = PROBE_META[rule.probe_key] || DEFAULT_META
  const [edit, setEdit] = useState({
    days: rule.params?.days ?? 7,
    mounted_only: rule.params?.mounted_only ?? true,
    enabled: rule.enabled,
    notify_owner: rule.notify_owner ?? false,
    schedule_kind: rule.schedule_kind ?? 'manual',
    interval_minutes: rule.interval_minutes ?? 1440,
  })
  const [firing, setFiring] = useState(null) // { items, total }
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (off) => {
      try {
        const d = await listAlertFiring(rule.id, { limit: PAGE_SIZE, offset: off })
        setFiring(d)
        setOffset(off)
      } catch (err) {
        toast.error(errMsg(err, '감지 목록을 불러오지 못했습니다.'))
      }
    },
    [rule.id],
  )

  useEffect(() => {
    load(0)
  }, [load])

  async function onSave() {
    const days = Math.max(0, parseInt(edit.days, 10) || 0)
    setBusy(true)
    try {
      await updateAlertRule(rule.id, {
        enabled: edit.enabled,
        params: { days, mounted_only: edit.mounted_only },
        notify_owner: edit.notify_owner,
        schedule_kind: edit.schedule_kind,
        interval_minutes: edit.interval_minutes,
      })
      toast.success('저장했습니다.')
      onRulesChanged?.()
    } catch (err) {
      toast.error(errMsg(err, '저장에 실패했습니다.'))
    } finally {
      setBusy(false)
    }
  }

  async function onRun() {
    setBusy(true)
    try {
      const r = await runAlertRule(rule.id)
      toast.success(
        `실행 완료 — 새로 감지 ${r.fired} · 해제 ${r.resolved} · 현재 ${r.firing}건` +
          (r.capped ? ` (상한 ${r.checked}건 초과, 일부만)` : ''),
      )
      await Promise.all([load(0), onRulesChanged?.()])
    } catch (err) {
      toast.error(errMsg(err, '실행에 실패했습니다.'))
    } finally {
      setBusy(false)
    }
  }

  const items = firing?.items ?? []
  const total = firing?.total ?? 0
  const from = total === 0 ? 0 : offset + 1
  const to = offset + items.length

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        {meta.desc && <p className="text-sm text-muted-foreground">{meta.desc}</p>}
        <p className="text-xs text-muted-foreground">
          {`자동 실행: ${scheduleLabel(rule)}`}
          {' · '}
          {rule.last_run_at
            ? `마지막 실행 ${fmtTime(rule.last_run_at)}`
            : '아직 자동 실행된 적 없음'}
        </p>

        {/* 조정 가능한 값 */}
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{meta.daysHint}(N)</span>
            <input
              type="number"
              min={0}
              value={edit.days ?? 7}
              onChange={(ev) => setEdit((s) => ({ ...s, days: ev.target.value }))}
              className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm h-8">
            <input
              type="checkbox"
              checked={Boolean(edit.mounted_only)}
              onChange={(ev) => setEdit((s) => ({ ...s, mounted_only: ev.target.checked }))}
            />
            게시된 보고서만
          </label>
          <label className="flex items-center gap-2 text-sm h-8">
            <input
              type="checkbox"
              checked={Boolean(edit.enabled)}
              onChange={(ev) => setEdit((s) => ({ ...s, enabled: ev.target.checked }))}
            />
            규칙 사용
          </label>
          <label
            className="flex items-center gap-2 text-sm h-8"
            title="새로 걸린 보고서의 작성자에게도 인앱 알림을 보냅니다(기본 꺼짐)."
          >
            <input
              type="checkbox"
              checked={Boolean(edit.notify_owner)}
              onChange={(ev) => setEdit((s) => ({ ...s, notify_owner: ev.target.checked }))}
            />
            작성자에게도 알림
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">자동 실행</span>
            <select
              value={scheduleValue(edit)}
              onChange={(ev) => {
                const v = ev.target.value
                if (v === 'manual') setEdit((s) => ({ ...s, schedule_kind: 'manual' }))
                else if (v === 'weekly') setEdit((s) => ({ ...s, schedule_kind: 'weekly' }))
                else if (v === 'monthly') setEdit((s) => ({ ...s, schedule_kind: 'monthly' }))
                else
                  setEdit((s) => ({
                    ...s,
                    schedule_kind: 'interval',
                    interval_minutes: Number(v.slice(1)),
                  }))
              }}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="manual">끔(수동만)</option>
              <option value="i60">매시간</option>
              <option value="i360">6시간마다</option>
              <option value="i1440">매일</option>
              <option value="weekly">매주(주초)</option>
              <option value="monthly">매달(달 초)</option>
            </select>
          </label>
          <Button size="sm" variant="outline" onClick={onSave} disabled={busy}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            저장
          </Button>
          <Button size="sm" onClick={onRun} disabled={busy}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            지금 실행
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => load(offset)}
            disabled={busy}
            title="감지 목록 새로고침"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* 감지 목록 */}
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">보고서</th>
                <th className="px-3 py-2 text-left font-medium">게시판</th>
                <th className="px-3 py-2 text-left font-medium">상태</th>
                <th className="px-3 py-2 text-left font-medium">{meta.dateLabel}</th>
                <th className="px-3 py-2 text-left font-medium">감지 시각</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    {firing ? '현재 감지된 대상이 없습니다.' : '불러오는 중…'}
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr
                  key={`${it.target_type}:${it.target_id}`}
                  className="border-b last:border-0"
                >
                  <td className="px-3 py-2">
                    {it.target_type === 'report' && it.context?.workspace_slug ? (
                      <Link
                        to={`/w/${it.context.workspace_slug}/reports/${it.target_id}`}
                        className="text-primary hover:underline"
                      >
                        {it.context?.title || `#${it.target_id}`}
                      </Link>
                    ) : (
                      it.context?.title || `${it.target_type} ${it.target_id}`
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {it.context?.boards?.length
                      ? it.context.boards.join(', ')
                      : '미게시(개인)'}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {PHASE_LABEL[it.context?.phase] || '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtTime(it.context?.[meta.dateKey])}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtTime(it.first_fired_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 페이지네이션 */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {total > 0 ? `${from}–${to} / 총 ${total}건` : '0건'}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || offset === 0}
              onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              이전
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || to >= total}
              onClick={() => load(offset + PAGE_SIZE)}
            >
              다음
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
