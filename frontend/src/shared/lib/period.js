/**
 * Period filter helpers shared by the dashboard and the composites list.
 *
 * Two modes:
 *   - "point"  (kind='week' / 'month') — inspect one specific ISO week or
 *     calendar month, navigable with ←/→ arrows. anchor is a Date inside
 *     the selected unit.
 *   - "range"  (kind='last-N-…' / 'all') — sliding window ending at now.
 *
 * Each option carries its own bucket unit so the consumer doesn't need a
 * separate week/month toggle alongside the dropdown.
 */
export const PERIOD_OPTIONS = [
  { value: 'week',           label: '주별',        mode: 'point', unit: 'week'  },
  { value: 'month',          label: '월별',        mode: 'point', unit: 'month' },
  // 연별 — 특정 연도를 골라 ←/→ 로 이동. 그 해를 '월 단위'로 묶어 보여준다
  // (unit='month' → 12개 월 버킷). 그래서 추세 차트가 연중 월별 분포를 그린다.
  { value: 'year',           label: '연별',        mode: 'point', unit: 'month' },
  { value: 'last-4-weeks',   label: '최근 4주',    mode: 'range', unit: 'week'  },
  { value: 'last-12-weeks',  label: '최근 12주',   mode: 'range', unit: 'week'  },
  { value: 'last-6-months',  label: '최근 6개월',  mode: 'range', unit: 'month' },
  { value: 'last-12-months', label: '최근 12개월', mode: 'range', unit: 'month' },
  { value: 'all',            label: '전체 기간',   mode: 'range', unit: 'month' },
]

export function periodOptionFor(kind) {
  return PERIOD_OPTIONS.find((o) => o.value === kind) ?? PERIOD_OPTIONS[1]
}

/** Resolve [from, to] for the active period. point modes return the
 *  boundaries of the selected week/month; range modes return N units
 *  ending at "now". `from` is null for 'all'. */
export function periodRange(kind, anchor) {
  const now = new Date()
  const to = endOfDay(now)
  switch (kind) {
    case 'week': {
      const monday = startOfIsoWeek(anchor)
      return { from: monday, to: endOfDay(addDays(monday, 6)) }
    }
    case 'month': {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 0, 0, 0, 0)
      const last = endOfDay(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))
      return { from: first, to: last }
    }
    case 'year': {
      const first = new Date(anchor.getFullYear(), 0, 1, 0, 0, 0, 0)
      const last = endOfDay(new Date(anchor.getFullYear(), 11, 31))
      return { from: first, to: last }
    }
    case 'last-4-weeks':   return { from: startOfDay(daysAgo(now, 28)), to }
    case 'last-12-weeks':  return { from: startOfDay(daysAgo(now, 84)), to }
    case 'last-6-months':  return { from: startOfDay(monthsAgo(now, 6)), to }
    case 'last-12-months': return { from: startOfDay(monthsAgo(now, 12)), to }
    case 'all':
    default:               return { from: null, to }
  }
}

/** Human label for the currently-anchored point period — empty for range
 *  modes. Used as the centerpiece of the ← anchor → navigator. */
export function pointLabel(kind, anchor) {
  if (kind === 'week') {
    const monday = startOfIsoWeek(anchor)
    return `${isoWeekKey(monday)} (${formatShortDate(monday)} – ${formatShortDate(addDays(monday, 6))})`
  }
  if (kind === 'month') {
    return `${anchor.getFullYear()}년 ${anchor.getMonth() + 1}월`
  }
  if (kind === 'year') {
    return `${anchor.getFullYear()}년`
  }
  return ''
}

/** Step the anchor of a point period one unit forward / back. No-op for
 *  range modes — caller should hide the navigator there. */
export function stepAnchor(kind, anchor, direction) {
  const next = new Date(anchor)
  if (kind === 'week') next.setDate(next.getDate() + direction * 7)
  else if (kind === 'month') next.setMonth(next.getMonth() + direction)
  else if (kind === 'year') next.setFullYear(next.getFullYear() + direction)
  return next
}

/** True when `value` (a YYYY-MM-DD string or a Date) falls inside the
 *  given range. Strings are compared as plain dates against the range's
 *  ISO date string to avoid timezone drift. */
export function dateInPeriodRange(value, range) {
  if (!range || !range.from) return value != null
  if (value == null) return false
  const v = typeof value === 'string' ? value : toIsoDate(value)
  return v >= toIsoDate(range.from) && v <= toIsoDate(range.to)
}

/** Backend emits naive UTC ISO datetimes ("…T07:28:26"). JS reads those
 *  as local time, throwing week/month bucketing off by the local TZ
 *  offset. Force-anchor to UTC. */
export function parseUtcIso(iso) {
  if (!iso) return null
  const s = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

export function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ── date primitives ─────────────────────────────────────────────────────
export function startOfIsoWeek(d) {
  const out = new Date(d)
  const day = out.getDay() || 7
  out.setDate(out.getDate() - day + 1)
  out.setHours(0, 0, 0, 0)
  return out
}
export function addDays(d, n) {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}
function daysAgo(d, n) { return addDays(d, -n) }
function monthsAgo(d, n) {
  const out = new Date(d)
  out.setMonth(out.getMonth() - n)
  return out
}
function startOfDay(d) {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}
function endOfDay(d) {
  const out = new Date(d)
  out.setHours(23, 59, 59, 999)
  return out
}
function toIsoDate(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function formatShortDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function formatRangeLabel(range) {
  if (!range?.from) return '전체 기간'
  return `${toIsoDate(range.from)} – ${toIsoDate(range.to)}`
}
