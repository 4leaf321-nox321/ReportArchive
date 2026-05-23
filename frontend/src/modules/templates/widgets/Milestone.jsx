import { useMemo } from 'react'
import { ChevronDown, ChevronUp, Circle, CircleCheck, CircleAlert, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  CaptionInput,
  DEFAULT_BODY_FONT_PX,
  EditorOptionBar,
  EditorOptionDate,
  LabelField,
  PreviewLabel,
  TextStyleField,
  captionSkipProps,
  effectiveString,
  pruneOverrideKeys,
  textStyleToClassName,
  textStyleToInlineStyle,
} from './_shared'

// --------------------------------------------------------------------------- //
// Status presets — shared by the editor's row select and the timeline marker. //
// --------------------------------------------------------------------------- //
const STATUSES = [
  {
    value: 'pending',
    label: '예정',
    color: '#64748b', // slate-500
    Icon: Circle,
  },
  {
    value: 'done',
    label: '완료',
    color: '#10b981', // emerald-500
    Icon: CircleCheck,
  },
  {
    value: 'delayed',
    label: '지연',
    color: '#ef4444', // red-500
    Icon: CircleAlert,
  },
]
const STATUS_BY_VALUE = Object.fromEntries(STATUSES.map((s) => [s.value, s]))
function statusOf(item) {
  return STATUS_BY_VALUE[item?.status] ?? STATUS_BY_VALUE.pending
}

// --------------------------------------------------------------------------- //
// PropsPanel — template-time configuration
// --------------------------------------------------------------------------- //
export function MilestonePropsPanel({ props, onChange }) {
  function patch(next) {
    onChange({ ...props, ...next })
  }
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="프로젝트 일정"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">시작일 (선택)</Label>
          <Input
            type="date"
            value={props.start_date ?? ''}
            onChange={(e) =>
              patch({ start_date: e.target.value || undefined })
            }
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">종료일 (선택)</Label>
          <Input
            type="date"
            value={props.end_date ?? ''}
            onChange={(e) =>
              patch({ end_date: e.target.value || undefined })
            }
            className="mt-1 h-9"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-2">
        시작/종료일을 비워두면 데이터의 최소·최대 날짜로 자동 결정됩니다.
      </p>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => patch({ text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview — empty timeline placeholder
// --------------------------------------------------------------------------- //
export function MilestonePreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel>{props.label || '(라벨 없음)'}</PreviewLabel>
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4">
        <MilestoneTimeline items={SAMPLE_ITEMS} startDate={null} endDate={null} />
      </div>
      <p className="text-[10px] text-muted-foreground italic">
        보고서에서 일정·항목을 추가하면 마커가 그려집니다.
      </p>
    </div>
  )
}
const SAMPLE_ITEMS = [
  { date: '2026-01-01', label: '킥오프', status: 'done' },
  { date: '2026-03-15', label: '중간', status: 'done' },
  { date: '2026-06-30', label: '완료', status: 'pending' },
]

// --------------------------------------------------------------------------- //
// Editor — caption + visual timeline + data-entry table
// --------------------------------------------------------------------------- //
export function MilestoneEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const items = Array.isArray(content?.items) ? content.items : []
  // Per-report timeline range — content wins, then props, then auto
  // (the timeline derives bounds from the items themselves).
  const startDate = effectiveString(content, props, 'start_date', '')
  const endDate = effectiveString(content, props, 'end_date', '')
  const textClass = textStyleToClassName(props.text_style)
  const textStyle = textStyleToInlineStyle(props.text_style)

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      ...(caption ? { caption } : {}),
      items,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.items || merged.items.length === 0) delete merged.items
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    pruneOverrideKeys(merged, props, {
      start_date: undefined,
      end_date: undefined,
    })
    onChange(merged)
  }

  function addItem() {
    const today = new Date().toISOString().slice(0, 10)
    patch({ items: [...items, { date: today, label: '', status: 'pending' }] })
  }
  function updateItem(idx, p) {
    patch({ items: items.map((it, i) => (i === idx ? { ...it, ...p } : it)) })
  }
  function removeItem(idx) {
    patch({ items: items.filter((_, i) => i !== idx) })
  }
  function moveItem(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= items.length) return
    const next = [...items]
    const [m] = next.splice(idx, 1)
    next.splice(newIdx, 0, m)
    patch({ items: next })
  }

  if (readOnly) {
    if (!caption && items.length === 0) return null
    return (
      <div className={`space-y-2 ${textClass}`} style={textStyle}>
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
        />
        {items.length > 0 ? (
          <MilestoneTimeline
            items={items}
            startDate={startDate || undefined}
            endDate={endDate || undefined}
          />
        ) : (
          <p className="text-xs text-muted-foreground italic">
            (마일스톤 없음)
          </p>
        )}
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${textClass}`} style={textStyle}>
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
        {...captionSkipProps({ content, patch })}
      />
      <EditorOptionBar title="타임라인 범위">
        <EditorOptionDate
          label="시작"
          value={startDate}
          onChange={(v) => patch({ start_date: v })}
          hint="비워두면 항목들 중 가장 이른 날짜로 자동 설정"
        />
        <EditorOptionDate
          label="끝"
          value={endDate}
          onChange={(v) => patch({ end_date: v })}
          hint="비워두면 항목들 중 가장 늦은 날짜로 자동 설정"
        />
      </EditorOptionBar>
      {/* Live timeline — fed by the table below. Stays visible while
          the writer types so they can sanity-check the date layout. */}
      <div className="rounded-md border bg-card px-3 py-3">
        {items.length > 0 ? (
          <MilestoneTimeline
            items={items}
            startDate={startDate || undefined}
            endDate={endDate || undefined}
          />
        ) : (
          <div className="text-center text-xs text-muted-foreground italic py-6">
            마일스톤을 추가하면 타임라인이 그려집니다.
          </div>
        )}
      </div>

      {/* Data-entry table */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-36">
                일정
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                항목명
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-24">
                상태
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                메모 (선택)
              </th>
              <th className="w-24 border-b" />
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const st = statusOf(it)
              return (
                <tr key={idx} className="border-b last:border-b-0">
                  <td className="px-1 py-1">
                    <Input
                      type="date"
                      value={it.date ?? ''}
                      onChange={(e) =>
                        updateItem(idx, { date: e.target.value || '' })
                      }
                      className="h-8 text-xs"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      value={it.label ?? ''}
                      onChange={(e) => updateItem(idx, { label: e.target.value })}
                      placeholder="항목명"
                      className="h-8 text-xs"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <div className="relative">
                      <select
                        value={it.status ?? 'pending'}
                        onChange={(e) =>
                          updateItem(idx, { status: e.target.value })
                        }
                        className="flex h-8 w-full rounded-md border border-input bg-background pl-6 pr-1 text-xs"
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <span
                        className="absolute left-1.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full pointer-events-none"
                        style={{ backgroundColor: st.color }}
                      />
                    </div>
                  </td>
                  <td className="px-1 py-1">
                    <Input
                      value={it.note ?? ''}
                      onChange={(e) =>
                        updateItem(idx, { note: e.target.value || undefined })
                      }
                      placeholder="메모"
                      className="h-8 text-xs"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => moveItem(idx, -1)}
                        disabled={idx === 0}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => moveItem(idx, 1)}
                        disabled={idx === items.length - 1}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => removeItem(idx)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-2 py-3 text-center text-xs text-muted-foreground italic"
                >
                  아직 마일스톤이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Button variant="outline" size="sm" onClick={addItem}>
        <Plus className="mr-1 h-3 w-3" />
        마일스톤 추가
      </Button>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Timeline visualization — horizontal axis with markers
// --------------------------------------------------------------------------- //
/** Plots `items` along a horizontal axis between `startDate` and `endDate`
 *  (or the data's min/max when those are missing). Each marker shows the
 *  item's status color, its date, and its label. Labels alternate
 *  above/below the axis when packed densely so they don't overlap. */
function MilestoneTimeline({ items, startDate, endDate }) {
  const layout = useMemo(() => {
    const dated = (items ?? [])
      .map((it, i) => ({ ...it, _idx: i, _t: parseDate(it.date) }))
      .filter((it) => it._t != null)
    if (dated.length === 0) return { points: [], spanLabel: '' }
    dated.sort((a, b) => a._t - b._t)
    const dataMin = dated[0]._t
    const dataMax = dated[dated.length - 1]._t
    const propMin = parseDate(startDate)
    const propMax = parseDate(endDate)
    const min = propMin ?? dataMin
    const max = propMax ?? dataMax
    // Avoid 0-width axes when every item is on the same date — give
    // each item its own evenly-spaced slot.
    const sameDay = min === max
    const points = dated.map((it, i) => ({
      ...it,
      pct: sameDay
        ? dated.length === 1
          ? 50
          : (i / (dated.length - 1)) * 100
        : ((it._t - min) / (max - min)) * 100,
      // Alternate above/below to avoid label collisions when timestamps
      // crowd together.
      above: i % 2 === 0,
    }))
    return {
      points,
      spanLabel: sameDay
        ? formatDate(min)
        : `${formatDate(min)} → ${formatDate(max)}`,
      minLabel: formatDate(min),
      maxLabel: formatDate(max),
      // The axis tick labels duplicate the endpoint markers' own dates
      // whenever the axis range comes from the data (no explicit
      // start_date/end_date) — or coincidentally matches them. Flag those
      // cases so the render can drop the redundant tick.
      firstAtStart: dated[0]._t === min,
      lastAtEnd: dated[dated.length - 1]._t === max,
    }
  }, [items, startDate, endDate])

  if (layout.points.length === 0) {
    return (
      <div className="text-center text-xs text-muted-foreground italic py-4">
        (날짜가 없는 항목은 표시되지 않습니다)
      </div>
    )
  }

  // Estimate the vertical room each label needs based on the longest
  // wrapped line — keeps the axis centered while long labels still fit.
  // Each "row" of wrapped text contributes ~14px; we then add the date
  // and an optional note line and clamp to a sensible band.
  const labelBlockHeight = useMemo(() => {
    const longest = layout.points.reduce(
      (m, p) => Math.max(m, (p.label ?? '').length),
      0,
    )
    const hasAnyNote = layout.points.some((p) => p.note)
    // ~10 Korean chars per line at width 120, then date line, then note.
    const lines = Math.max(1, Math.ceil(longest / 10))
    return 16 * lines + 14 + (hasAnyNote ? 14 : 0)
  }, [layout.points])
  // Total component height = label band above + axis line + label band
  // below + a little padding for connectors.
  const trackHeight = labelBlockHeight * 2 + 24

  return (
    <div className="select-none">
      {/* Outer frame reserves a left/right gutter (px-16) so edge
          markers' labels — which extend ±half their own width past
          the marker — never get clipped against the card border.
          Vertical height grows with the longest wrapped label so
          markers stay centered no matter how much text wraps. */}
      <div
        className="relative mx-2 px-16"
        style={{ height: trackHeight }}
      >
        {/* Inner track — the actual axis lives here with markers
            anchored at percent offsets along its width. Sits inside
            the left/right gutters so 0% / 100% markers land flush with
            the visible track start/end. */}
        <div className="absolute left-16 right-16 top-0 bottom-0">
          {/* baseline */}
          <div className="absolute inset-x-0 top-1/2 h-0.5 bg-border -translate-y-1/2" />
          {/* range tick labels — anchored just outside the inner track
              so they sit in the gutter, not on top of the first /
              last marker. Suppressed when the endpoint marker already
              prints the same date under itself, so we don't show it
              twice. */}
          {!layout.firstAtStart && (
            <span className="absolute -left-1 top-1/2 mt-2 text-[10px] text-muted-foreground -translate-x-full whitespace-nowrap">
              {layout.minLabel}
            </span>
          )}
          {!layout.lastAtEnd && (
            <span className="absolute -right-1 top-1/2 mt-2 text-[10px] text-muted-foreground translate-x-full whitespace-nowrap">
              {layout.maxLabel}
            </span>
          )}
          {layout.points.map((p) => {
            const st = statusOf(p)
            const StatusIcon = st.Icon
            return (
              <div
                key={p._idx}
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${p.pct}%` }}
              >
                {/* Connector line from marker to its label */}
                <div
                  className={`absolute left-1/2 -translate-x-1/2 w-px ${
                    p.above ? 'bottom-3' : 'top-3'
                  }`}
                  style={{
                    backgroundColor: `${st.color}66`,
                    height: '1.25rem',
                  }}
                />
                {/* Marker — solid color fill. */}
                <div
                  className="relative rounded-full"
                  style={{
                    width: 14,
                    height: 14,
                    backgroundColor: st.color,
                    border: `2px solid ${st.color}`,
                    boxShadow: `0 0 0 2px hsl(var(--background))`,
                  }}
                >
                  {p.status === 'done' && (
                    <StatusIcon
                      className="absolute inset-0 m-auto"
                      color="#fff"
                      size={10}
                    />
                  )}
                </div>
                {/* Label + date — wraps freely so long titles flow onto
                    multiple lines instead of overflowing. Korean words
                    stay intact via `wordBreak: keep-all`. Width is
                    capped so adjacent markers don't fight for the same
                    horizontal space. */}
                <div
                  className={`absolute left-1/2 -translate-x-1/2 text-center leading-tight ${
                    p.above ? 'bottom-6' : 'top-6'
                  }`}
                  style={{ width: 120 }}
                >
                  <div
                    className="text-xs font-medium"
                    style={{ color: st.color, wordBreak: 'keep-all', overflowWrap: 'anywhere' }}
                    title={p.label}
                  >
                    {p.label || '(이름 없음)'}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {formatDate(p._t)}
                  </div>
                  {p.note && (
                    <div
                      className="text-[10px] text-muted-foreground italic"
                      style={{ wordBreak: 'keep-all', overflowWrap: 'anywhere' }}
                      title={p.note}
                    >
                      {p.note}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
function parseDate(s) {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}
function formatDate(t) {
  if (t == null) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
