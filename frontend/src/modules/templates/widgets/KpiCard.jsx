import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, LabelField, PreviewLabel } from './_shared'

const FORMATS = [
  { value: 'number', label: '숫자' },
  { value: 'percent', label: '퍼센트' },
  { value: 'currency', label: '통화' },
]

export function KpiCardPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="매출"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">단위</Label>
          <Input
            value={props.unit ?? ''}
            onChange={(e) => onChange({ ...props, unit: e.target.value })}
            className="mt-1 h-9"
            placeholder="억원"
          />
        </div>
        <div>
          <Label className="text-xs">표기 형식</Label>
          <select
            value={props.format ?? 'number'}
            onChange={(e) => onChange({ ...props, format: e.target.value })}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label className="text-xs">목표값 (선택)</Label>
        <Input
          type="number"
          value={props.target ?? ''}
          onChange={(e) =>
            onChange({
              ...props,
              target: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
          className="mt-1 h-9"
        />
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={!!props.allow_delta}
            onChange={(e) => onChange({ ...props, allow_delta: e.target.checked })}
          />
          증감(delta) 입력 허용
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={!!props.allow_note}
            onChange={(e) => onChange({ ...props, allow_note: e.target.checked })}
          />
          메모 입력 허용
        </label>
      </div>
    </div>
  )
}

import { Textarea } from '@/shared/components/ui/textarea'

export function KpiCardEditor({ props, content, onChange, readOnly }) {
  const data = content ?? {}

  function update(patch) {
    const next = { ...data, ...patch }
    for (const k of Object.keys(next)) {
      if (next[k] === undefined || next[k] === '') delete next[k]
    }
    onChange(next)
  }

  if (readOnly) {
    const hasValue = data.value !== undefined && data.value !== null
    if (!data.caption && !hasValue) return null
    return (
      <div className="space-y-1">
        <CaptionInput value={data.caption ?? ''} readOnly />
        {hasValue && (
          <div className="space-y-0.5">
            <div className="text-3xl font-semibold">
              {formatValue(data.value, props)}
            </div>
            {(data.delta !== undefined || data.note) && (
              <div className="text-xs text-muted-foreground space-x-2">
                {data.delta !== undefined && (
                  <span className={data.delta >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                    {data.delta >= 0 ? '+' : ''}
                    {data.delta}
                  </span>
                )}
                {data.note && <span>{data.note}</span>}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <CaptionInput
        value={data.caption ?? ''}
        onChange={(v) => update({ caption: v })}
        placeholder={props.label}
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">
            값 <span className="text-destructive">*</span>
            {props.unit && <span className="text-muted-foreground"> ({props.unit})</span>}
          </Label>
          <Input
            type="number"
            value={data.value ?? ''}
            onChange={(e) =>
              update({ value: e.target.value === '' ? undefined : Number(e.target.value) })
            }
            className="mt-1 h-9"
          />
        </div>
        {props.allow_delta && (
          <div>
            <Label className="text-xs">증감 (delta)</Label>
            <Input
              type="number"
              value={data.delta ?? ''}
              onChange={(e) =>
                update({ delta: e.target.value === '' ? undefined : Number(e.target.value) })
              }
              className="mt-1 h-9"
            />
          </div>
        )}
      </div>
      {props.allow_note && (
        <div>
          <Label className="text-xs">메모</Label>
          <Textarea
            value={data.note ?? ''}
            onChange={(e) => update({ note: e.target.value || undefined })}
            rows={2}
            className="mt-1"
          />
        </div>
      )}
      {props.target != null && data.value != null && (
        <p className="text-[11px] text-muted-foreground">
          목표 {formatValue(props.target, props)} 대비 {formatValue(data.value, props)}
          {' '}
          ({((data.value / props.target) * 100).toFixed(1)}%)
        </p>
      )}
    </div>
  )
}

function formatValue(v, props) {
  if (props.format === 'percent') return `${v}%`
  if (props.format === 'currency') return `${v}${props.unit ? ' ' + props.unit : ''}`
  return `${v}${props.unit ? ' ' + props.unit : ''}`
}

export function KpiCardPreview({ props }) {
  const unit = props.unit ? <span className="text-sm text-muted-foreground"> {props.unit}</span> : null
  return (
    <div className="rounded-lg border bg-muted/20 p-4 space-y-1">
      <div className="text-xs text-muted-foreground">{props.label || '(라벨 없음)'}</div>
      <div className="text-2xl font-semibold text-foreground/40 italic">
        000{unit}
      </div>
      {(props.allow_delta || props.allow_note) && (
        <div className="text-[10px] text-muted-foreground italic">
          {props.allow_delta && '+증감'}
          {props.allow_delta && props.allow_note && ' · '}
          {props.allow_note && '메모'}
        </div>
      )}
    </div>
  )
}
