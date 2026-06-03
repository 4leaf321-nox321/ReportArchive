import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  PERIOD_OPTIONS,
  periodOptionFor,
  periodRange,
  pointLabel,
  stepAnchor as stepAnchorFn,
} from '@/shared/lib/period'

/**
 * Stateful hook bundling everything a page needs to drive the period
 * filter: the kind dropdown value, the anchor (for point modes), the
 * resolved range + active option metadata, plus the kind-switch /
 * arrow-step handlers.
 *
 *   const period = usePeriodFilter('month')
 *   <PeriodFilterControls period={period} />
 *   reports.filter((r) => dateInPeriodRange(r.report_date, period.range))
 */
export function usePeriodFilter(initialKind = 'month', initialAnchor = null) {
  const [kind, setKind] = useState(initialKind)
  // initialAnchor(예: 목록으로 돌아갈 때 보던 주차의 날짜)가 있으면 그 날짜로
  // 시작 — 없으면 현재. YYYY-MM-DD 문자열/Date 모두 받는다.
  const [anchor, setAnchor] = useState(() => {
    if (initialAnchor instanceof Date) return initialAnchor
    if (typeof initialAnchor === 'string' && initialAnchor) {
      const d = new Date(initialAnchor)
      if (!Number.isNaN(d.getTime())) return d
    }
    return new Date()
  })

  const meta = periodOptionFor(kind)
  const range = periodRange(kind, anchor)

  function changeKind(next) {
    setKind(next)
    const m = periodOptionFor(next)
    if (m.mode === 'point') {
      // Snap to "this week / this month" rather than carrying over an
      // anchor from a different unit (would point at an arbitrary day).
      setAnchor(new Date())
    }
  }
  function stepAnchorBy(direction) {
    if (meta.mode !== 'point') return
    setAnchor((prev) => stepAnchorFn(kind, prev, direction))
  }

  return { kind, anchor, meta, range, changeKind, stepAnchor: stepAnchorBy }
}

/** Composed control: kind dropdown + (point mode only) anchor navigator.
 *  Use inside any page header that wants the dashboard-style period UX. */
export function PeriodFilterControls({ period }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <PeriodSelect value={period.kind} onChange={period.changeKind} />
      {period.meta.mode === 'point' && (
        <PointNavigator
          label={pointLabel(period.kind, period.anchor)}
          onPrev={() => period.stepAnchor(-1)}
          onNext={() => period.stepAnchor(+1)}
        />
      )}
    </div>
  )
}

function PeriodSelect({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
      aria-label="기간"
    >
      {PERIOD_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function PointNavigator({ label, onPrev, onNext }) {
  return (
    <div className="inline-flex items-center gap-1 h-9 rounded-md border bg-background px-1">
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onPrev} aria-label="이전">
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-sm font-medium min-w-[7rem] text-center tabular-nums">
        {label}
      </span>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNext} aria-label="다음">
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
