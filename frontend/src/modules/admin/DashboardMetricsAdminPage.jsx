import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Gauge, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listTemplates } from '@/shared/api/templates'
import {
  listTemplateMetrics,
  getMetricCandidates,
  createTemplateMetric,
  updateTemplateMetric,
  deleteTemplateMetric,
} from '@/shared/api/templateMetrics'

// 보고서 간 집계 방식 — 라벨.
const AGG_OPTIONS = [
  { value: 'avg', label: '평균' },
  { value: 'sum', label: '합계' },
  { value: 'max', label: '최대' },
  { value: 'min', label: '최소' },
  { value: 'last', label: '최근값' },
  { value: 'count', label: '개수' },
]
const AGG_LABEL = Object.fromEntries(AGG_OPTIONS.map((o) => [o.value, o.label]))

/**
 * 시스템 관리 — 대시보드 콘텐츠 수치 지표(TemplateMetric) 정의.
 * 템플릿(패밀리)을 고르면 그 템플릿의 숫자(key_value) 필드 후보를 보여주고,
 * 지표로 등록한다. 등록된 지표는 그 템플릿을 쓰는 모든 부서 대시보드의
 * "콘텐츠 지표"에 동일하게 뜬다(전역). (Phase3_대시보드_설계.md 3B-1)
 */
export default function DashboardMetricsAdminPage() {
  const { me } = useAuth()
  const isAdmin = me?.is_system_admin === true

  const [templateId, setTemplateId] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const bump = () => setReloadKey((k) => k + 1)

  const { data: templates } = useAsync(
    () => (isAdmin ? listTemplates() : Promise.resolve([])),
    [isAdmin],
  )
  const { data: candidates } = useAsync(
    () => (isAdmin && templateId ? getMetricCandidates(templateId) : Promise.resolve(null)),
    [isAdmin, templateId],
  )
  const {
    data: metrics,
    loading: metricsLoading,
    error: metricsError,
    reload: reloadMetrics,
  } = useAsync(
    () => (isAdmin && templateId ? listTemplateMetrics(templateId) : Promise.resolve([])),
    [isAdmin, templateId, reloadKey],
  )

  const blocks = candidates?.blocks ?? []
  const hasCandidates = blocks.length > 0

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="대시보드 지표" description="콘텐츠 수치 지표 정의" />
        <ErrorState
          title="권한 없음"
          description="시스템 관리자만 접근할 수 있습니다."
          action={
            <Button asChild variant="outline">
              <Link to="/">홈으로</Link>
            </Button>
          }
        />
      </div>
    )
  }

  async function handleToggle(m) {
    try {
      await updateTemplateMetric(m.id, { enabled: !m.enabled })
      reloadMetrics()
    } catch (e) {
      toast.error(e?.response?.data?.message || '변경 실패')
    }
  }
  async function handleDelete(m) {
    try {
      await deleteTemplateMetric(m.id)
      toast.success('지표 삭제됨')
      reloadMetrics()
    } catch (e) {
      toast.error(e?.response?.data?.message || '삭제 실패')
    }
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="대시보드 지표"
        description="템플릿의 숫자 필드를 대시보드 '콘텐츠 지표'로 등록합니다. 등록한 지표는 그 템플릿을 쓰는 모든 부서 대시보드에 동일하게 표시됩니다."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">템플릿 선택</CardTitle>
          <CardDescription>지표를 정의할 템플릿(패밀리)을 고르세요.</CardDescription>
        </CardHeader>
        <CardContent>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-[280px]"
          >
            <option value="">— 템플릿 선택 —</option>
            {(templates ?? []).map((t) => (
              <option key={t.template_id} value={t.template_id}>
                {t.name} (v{t.version})
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {templateId && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">지표 추가</CardTitle>
              <CardDescription>
                {hasCandidates
                  ? '이 템플릿의 숫자(key_value) 필드 중 하나를 지표로 등록합니다.'
                  : '이 템플릿에는 숫자(number/integer) 형식의 key_value 필드가 없습니다. 템플릿에 숫자 필드를 추가하면 여기에 나타납니다.'}
              </CardDescription>
            </CardHeader>
            {hasCandidates && (
              <CardContent>
                <AddMetricForm
                  blocks={blocks}
                  onAdded={() => {
                    bump()
                  }}
                  templateId={templateId}
                />
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">등록된 지표</CardTitle>
              <CardDescription>
                {candidates?.template_name} · {(metrics ?? []).length}개
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {metricsError ? (
                <ErrorState description={metricsError.message} onRetry={reloadMetrics} />
              ) : metricsLoading ? (
                <Skeleton className="h-24" />
              ) : (metrics ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">
                  아직 등록된 지표가 없습니다.
                </p>
              ) : (
                (metrics ?? []).map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <Gauge className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {m.label}
                        {m.unit ? (
                          <span className="text-muted-foreground"> ({m.unit})</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {m.block_id}
                        {m.field_key ? ` · ${m.field_key}` : ''} · 집계: {AGG_LABEL[m.agg] ?? m.agg}
                      </div>
                    </div>
                    <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={() => handleToggle(m)}
                        className="h-3.5 w-3.5"
                      />
                      표시
                    </label>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(m)}
                      title="지표 삭제"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function AddMetricForm({ blocks, templateId, onAdded }) {
  // 후보 필드를 평면화 — value = "blockId::fieldKey"
  const options = useMemo(() => {
    const out = []
    for (const b of blocks) {
      for (const f of b.fields) {
        out.push({
          value: `${b.block_id}::${f.key}`,
          blockId: b.block_id,
          fieldKey: f.key,
          label: `${b.block_label} · ${f.label}`,
          fieldLabel: f.label,
        })
      }
    }
    return out
  }, [blocks])

  const [sel, setSel] = useState('')
  const [label, setLabel] = useState('')
  const [agg, setAgg] = useState('avg')
  const [unit, setUnit] = useState('')
  const [busy, setBusy] = useState(false)

  const picked = options.find((o) => o.value === sel) ?? null

  function onPick(v) {
    setSel(v)
    const o = options.find((x) => x.value === v)
    // 라벨 비어있으면 필드 라벨로 기본 채움.
    if (o && !label) setLabel(o.fieldLabel)
  }

  async function submit() {
    if (!picked) {
      toast.error('필드를 선택하세요.')
      return
    }
    setBusy(true)
    try {
      await createTemplateMetric({
        template_id: templateId,
        block_id: picked.blockId,
        field_key: picked.fieldKey,
        agg,
        label: label.trim() || picked.fieldLabel,
        unit: unit.trim(),
      })
      toast.success('지표 추가됨')
      setSel('')
      setLabel('')
      setAgg('avg')
      setUnit('')
      onAdded()
    } catch (e) {
      toast.error(e?.response?.data?.message || '추가 실패')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="필드">
        <select
          value={sel}
          onChange={(e) => onPick(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm min-w-[220px]"
        >
          <option value="">— 숫자 필드 선택 —</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="표시명">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="예: 최대 응력"
          className="h-9 w-[160px]"
        />
      </Field>
      <Field label="집계">
        <select
          value={agg}
          onChange={(e) => setAgg(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {AGG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="단위">
        <Input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="예: MPa"
          className="h-9 w-[100px]"
        />
      </Field>
      <Button onClick={submit} disabled={busy || !picked}>
        {busy ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <Plus className="mr-1.5 h-4 w-4" />
        )}
        추가
      </Button>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
