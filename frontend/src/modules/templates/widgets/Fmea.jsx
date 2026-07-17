// FMEA 위젯 — 고장형태 영향분석. S·O·D 입력 시 RPN = S×O×D 자동계산·위험 색상.
// 고장모드 셀은 RecordNamePicker(자유텍스트 find-or-create) → 저장 시 백엔드 훅이
// failure_mode 엔티티로 승격·태깅(_materialize_record_widgets). 점수는 위젯 JSON
// (엔티티 속성 아님 — 맥락별 평가). content = { fmea_items: { caption, rows[], ... } }.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, AlertTriangle, Sparkles, X } from 'lucide-react'

import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Button } from '@/shared/components/ui/button'
import { bgTokenClass, colorTokenClass } from '@/shared/text-color'
import { useAsync } from '@/shared/hooks/useAsync'
import { semanticSearchReports } from '@/modules/reports/api'

import { useRecordAxes, RecordNamePicker } from './Record'

const STATUS = [
  { v: 'open', label: '미조치' },
  { v: 'in_progress', label: '조치중' },
  { v: 'closed', label: '완료' },
]
const DEFAULT_THRESHOLD = 100

// 열 정의 — 헤더(이름 + 약자)와 호버 설명(title)을 읽기·편집 표가 공유한다.
// 약자(S·O·D·RPN)만으로는 모르는 사람이 많아 정식 이름을 앞에 쓴다.
const COLS = [
  { label: '고장모드', minW: 'min-w-[180px]',
    desc: '잠재적 고장의 형태 — 부품·기능이 어떻게 고장나는가' },
  { label: '영향', minW: 'min-w-[140px]',
    desc: '고장이 났을 때의 결과(고객·시스템에 미치는 영향)' },
  { label: '원인', minW: 'min-w-[140px]',
    desc: '고장을 일으키는 근본 원인' },
  { label: '현 관리', minW: 'min-w-[120px]',
    desc: '지금 이 고장을 예방하거나 검출하는 관리 방법(설계 검토·검사 등)' },
  { label: '심각도 (S)', minW: '',
    desc: '심각도 Severity — 고장 영향이 얼마나 심각한가(1~10, 클수록 나쁨. 안전·발화는 9~10)' },
  { label: '발생도 (O)', minW: '',
    desc: '발생도 Occurrence — 그 원인이 얼마나 자주 발생하는가(1~10, 클수록 나쁨)' },
  { label: '검출도 (D)', minW: '',
    desc: '검출도 Detection — 현 관리로 얼마나 못 잡아내는가(1~10, 클수록 나쁨=검출이 어려움)' },
  { label: 'RPN', minW: '',
    desc: '위험우선순위 = 심각도 × 발생도 × 검출도(S×O×D, 1~1000). 높을수록 우선 대응. 보통 100 이상이면 중점관리' },
  { label: '권고조치', minW: 'min-w-[140px]',
    desc: '위험을 낮추기 위한 개선 조치' },
  { label: '담당', minW: 'min-w-[90px]',
    desc: '조치 담당자 또는 부서' },
  { label: '상태', minW: '',
    desc: '조치 진행 상태(미조치·조치중·완료)' },
]

function toScore(v) {
  if (v === '' || v == null) return null
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : null
}
function computeRpn(row) {
  const { severity: s, occurrence: o, detection: d } = row
  return s && o && d ? s * o * d : null
}
// RPN 위험 밴드 → rt-c 색 토큰(다크모드 적응). 임계 이상=빨강, 40%~=황색, 그 아래=녹색.
function rpnTokenClass(rpn, threshold) {
  if (rpn == null) return ''
  const t = rpn >= threshold ? 'red' : rpn >= threshold * 0.4 ? 'amber' : 'green'
  return `${bgTokenClass(t)} ${colorTokenClass(t)}`.trim()
}
let _seq = 0
function newRow() {
  _seq += 1
  return {
    id: `f${Date.now()}_${_seq}`,
    failure_mode: { name: '', entity_id: null },
    potential_effect: '', potential_cause: '', current_controls: '',
    severity: null, occurrence: null, detection: null, rpn: null,
    recommended_action: '', responsible: '', due_date: '', status: 'open',
    target_rpn: null,
  }
}

// 템플릿 설계자용 — 라벨 + 중점관리 RPN 임계.
export function FmeaPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">라벨</Label>
        <Input
          value={props?.label ?? ''}
          onChange={(e) => onChange({ ...props, label: e.target.value })}
          placeholder="FMEA"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">중점관리 RPN 임계</Label>
        <Input
          type="number"
          min={1}
          max={1000}
          value={props?.rpn_threshold ?? DEFAULT_THRESHOLD}
          onChange={(e) =>
            onChange({ ...props, rpn_threshold: Number(e.target.value) || DEFAULT_THRESHOLD })
          }
        />
        <p className="text-[11px] text-muted-foreground">
          RPN 이 이 값 이상이면 빨강으로 강조합니다(기본 100).
        </p>
      </div>
    </div>
  )
}

export function FmeaPreview() {
  return (
    <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
      FMEA — 작성 화면에서 고장모드·S·O·D 입력 시 RPN 자동계산
    </div>
  )
}

const TH = 'px-2 py-1 text-left font-medium whitespace-nowrap'
const TD = 'px-1.5 py-1 align-top'

export function FmeaEditor({ props, content, onChange, readOnly }) {
  const fmea = content?.fmea_items || {}
  const rows = Array.isArray(fmea.rows) ? fmea.rows : []
  const threshold = props?.rpn_threshold || DEFAULT_THRESHOLD
  const axes = useRecordAxes()
  const fmAxis = axes.find((a) => a.slug === 'failure_mode') || null

  // 유사 과거사례 추천 — 선택 행의 고장모드+영향으로 시맨틱 검색(임베딩, LLM 생성 아님).
  const [simRowId, setSimRowId] = useState(null)
  const simRow = rows.find((r) => r.id === simRowId) || null
  const simQuery = simRow
    ? `${simRow.failure_mode?.name || ''} ${simRow.potential_effect || ''}`.trim()
    : ''
  const { data: simData, loading: simLoading } = useAsync(
    () =>
      simQuery.length >= 2
        ? semanticSearchReports(simQuery, { mode: 'hybrid', limit: 5 })
        : Promise.resolve(null),
    [simQuery],
  )
  const simResults = simData?.results || []

  function patchFmea(next) {
    onChange({ ...(content || {}), fmea_items: { ...fmea, ...next } })
  }
  function setRows(r) {
    patchFmea({ rows: r })
  }
  function setRow(i, patch) {
    const merged = { ...rows[i], ...patch }
    merged.rpn = computeRpn(merged) // 파생 — 저장값이 S·O·D 와 늘 일치(드리프트 방지)
    setRows(rows.map((r, idx) => (idx === i ? merged : r)))
  }

  if (readOnly) {
    const filled = rows.filter((r) => r.failure_mode?.name || r.rpn != null)
    if (filled.length === 0) {
      return <p className="text-sm text-muted-foreground">(FMEA — 미작성)</p>
    }
    return (
      <div className="space-y-1">
        {fmea.caption && <div className="text-sm font-semibold">{fmea.caption}</div>}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {COLS.map((c) => (
                  <th key={c.label} className={TH} title={c.desc}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className={`${TD} font-medium`}>
                    {row.failure_mode?.entity_id != null ? (
                      <Link
                        to={`/entities/${row.failure_mode.entity_id}`}
                        className="hover:underline"
                      >
                        {row.failure_mode.name}
                      </Link>
                    ) : (
                      row.failure_mode?.name || '—'
                    )}
                  </td>
                  <td className={TD}>{row.potential_effect || '—'}</td>
                  <td className={TD}>{row.potential_cause || '—'}</td>
                  <td className={TD}>{row.current_controls || '—'}</td>
                  <td className={`${TD} text-center tabular-nums`}>{row.severity ?? '—'}</td>
                  <td className={`${TD} text-center tabular-nums`}>{row.occurrence ?? '—'}</td>
                  <td className={`${TD} text-center tabular-nums`}>{row.detection ?? '—'}</td>
                  <td className={`${TD} text-center font-semibold tabular-nums rounded ${rpnTokenClass(row.rpn, threshold)}`}>
                    {row.rpn ?? '—'}
                  </td>
                  <td className={TD}>{row.recommended_action || '—'}</td>
                  <td className={TD}>{row.responsible || '—'}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {STATUS.find((s) => s.v === row.status)?.label || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // 편집 모드
  return (
    <div className="space-y-2">
      <Input
        value={fmea.caption ?? ''}
        onChange={(e) => patchFmea({ caption: e.target.value })}
        placeholder="FMEA 제목(선택)"
        className="h-8 max-w-sm text-sm"
      />
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              {COLS.map((c) => (
                <th key={c.label} className={`${TH} ${c.minW}`} title={c.desc}>
                  {c.label}
                </th>
              ))}
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id} className="border-t align-top">
                <td className={TD}>
                  <RecordNamePicker
                    axisId={fmAxis?.id}
                    name={row.failure_mode?.name || ''}
                    onPick={({ name, entityId }) =>
                      setRow(i, { failure_mode: { name, entity_id: entityId ?? null } })
                    }
                  />
                </td>
                {['potential_effect', 'potential_cause', 'current_controls'].map((k) => (
                  <td key={k} className={TD}>
                    <textarea
                      rows={1}
                      value={row[k] || ''}
                      onChange={(e) => setRow(i, { [k]: e.target.value })}
                      className="w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                  </td>
                ))}
                {['severity', 'occurrence', 'detection'].map((k) => (
                  <td key={k} className={TD}>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={row[k] ?? ''}
                      onChange={(e) => setRow(i, { [k]: toScore(e.target.value) })}
                      className="w-12 rounded-md border border-input bg-background px-1 py-1 text-center text-sm"
                    />
                  </td>
                ))}
                <td className={TD}>
                  <div
                    className={`min-w-[44px] rounded px-1 py-1 text-center font-semibold tabular-nums ${rpnTokenClass(row.rpn, threshold)}`}
                    title="RPN = S × O × D (자동)"
                  >
                    {row.rpn ?? '—'}
                  </div>
                </td>
                <td className={TD}>
                  <textarea
                    rows={1}
                    value={row.recommended_action || ''}
                    onChange={(e) => setRow(i, { recommended_action: e.target.value })}
                    className="w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-sm"
                  />
                </td>
                <td className={TD}>
                  <Input
                    value={row.responsible || ''}
                    onChange={(e) => setRow(i, { responsible: e.target.value })}
                    className="h-8 text-sm"
                  />
                </td>
                <td className={TD}>
                  <select
                    value={row.status || 'open'}
                    onChange={(e) => setRow(i, { status: e.target.value })}
                    className="h-8 rounded-md border border-input bg-background px-1 text-sm"
                  >
                    {STATUS.map((s) => (
                      <option key={s.v} value={s.v}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={TD}>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setSimRowId(simRowId === row.id ? null : row.id)}
                      className={`rounded p-1 hover:bg-muted ${simRowId === row.id ? 'text-primary' : 'text-muted-foreground hover:text-primary'}`}
                      title="유사 과거사례 찾기"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                      title="행 삭제"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-2 py-4 text-center text-sm text-muted-foreground">
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                  고장모드를 추가해 FMEA 를 시작하세요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setRows([...rows, newRow()])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> 행 추가
      </Button>

      {/* 유사 과거사례 패널 — 행의 ✨ 클릭 시. 임베딩 검색(생성 LLM 아님). */}
      {simRow && (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            유사 과거사례
            <span className="font-normal">
              — {simRow.failure_mode?.name || '(고장모드 입력 필요)'}
            </span>
            <button
              type="button"
              onClick={() => setSimRowId(null)}
              className="ml-auto rounded p-0.5 hover:bg-muted"
              title="닫기"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {simQuery.length < 2 ? (
            <p className="text-xs text-muted-foreground">고장모드·영향을 입력하면 추천합니다.</p>
          ) : simLoading ? (
            <p className="text-xs text-muted-foreground">검색 중…</p>
          ) : simResults.length === 0 ? (
            <p className="text-xs text-muted-foreground">유사한 과거 보고서가 없습니다.</p>
          ) : (
            <ul className="space-y-1">
              {simResults.map((r) => (
                <li key={r.report_id} className="flex flex-col">
                  <Link
                    to={`/w/${r.workspace_slug}/reports/${r.report_id}`}
                    className="flex items-baseline gap-2 text-sm hover:underline"
                  >
                    <span className="truncate">{r.title || `보고서 ${r.report_id}`}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {Math.round((r.score ?? r.rrf_score ?? 0) * 100)}%
                    </span>
                  </Link>
                  {r.snippet && (
                    <p className="line-clamp-1 text-[11px] text-muted-foreground">{r.snippet}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
