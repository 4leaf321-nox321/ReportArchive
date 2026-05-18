import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, FieldItemListEditor, LabelField, PreviewLabel, TextStyleField, textStyleToClassName } from './_shared'

export function KeyValuePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨 (선택)"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="보고 정보"
      />
      <div>
        <Label className="text-xs">필드 항목</Label>
        <p className="text-[10px] text-muted-foreground mt-0.5 mb-2">
          작성자가 채울 라벨–값 쌍. 키는 영문 소문자/숫자/언더스코어.
        </p>
        <FieldItemListEditor
          items={props.items ?? []}
          onChange={(items) => onChange({ ...props, items })}
          addLabel="항목 추가"
        />
      </div>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => onChange({ ...props, text_style })}
      />
    </div>
  )
}

export function KeyValuePreview({ props }) {
  const items = props.items ?? []
  return (
    <div className="space-y-2">
      {props.label && <PreviewLabel>{props.label}</PreviewLabel>}
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">필드 없음</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
          {items.map((item, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">
                {item.label || item.key || '(라벨 없음)'}
                {item.required && <span className="text-destructive ml-0.5">*</span>}
              </dt>
              <dd className="text-foreground/60 italic">
                {item.type === 'select' && (item.options?.length || 0) > 0
                  ? `(${item.options.join(' / ')})`
                  : `(${typeLabel(item.type)})`}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function typeLabel(t) {
  return (
    {
      text: '텍스트',
      number: '숫자',
      integer: '정수',
      date: '날짜',
      select: '선택지',
    }[t] ?? t
  )
}

export function KeyValueEditor({ props, content, onChange, readOnly }) {
  const items = props.items ?? []
  const data = content ?? {}
  const caption = data.caption ?? ''

  function patch(next) {
    const merged = { ...data, ...next }
    if (!merged.caption) delete merged.caption
    onChange(merged)
  }

  function update(key, value) {
    if (value === undefined || value === '') {
      const { [key]: _drop, ...rest } = data
      patch({ ...rest })
    } else {
      patch({ [key]: value })
    }
  }

  // Designer-supplied typography for both keys and values.
  const bodyTextClass = textStyleToClassName(props.text_style)

  if (readOnly) {
    const filledItems = items.filter((item) => data[item.key] !== undefined && data[item.key] !== '')
    if (!caption && filledItems.length === 0) return null
    return (
      <div className="space-y-2">
        <CaptionInput value={caption} readOnly />
        {filledItems.length > 0 && (
          <div className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 items-baseline text-sm ${bodyTextClass}`}>
            {filledItems.map((item, i) => (
              <div key={i} className="contents">
                <span className="text-muted-foreground">
                  {item.label || item.key}
                </span>
                <span>{formatKvValue(item, data[item.key])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
      />
      <div className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 items-center ${bodyTextClass}`}>
        {items.map((item, i) => (
          <div key={i} className="contents">
            <Label className="text-sm text-muted-foreground">
              {item.label || item.key}
              {item.required && <span className="text-destructive ml-0.5">*</span>}
            </Label>
            <KvFieldInput
              item={item}
              value={data[item.key]}
              onChange={(v) => update(item.key, v)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function formatKvValue(item, value) {
  if (value === undefined || value === '' || value === null) return ''
  return String(value)
}

function KvFieldInput({ item, value, onChange }) {
  const t = item.type
  if (t === 'select') {
    return (
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
      >
        <option value="">선택…</option>
        {(item.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (t === 'date') {
    return (
      <Input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-9"
      />
    )
  }
  if (t === 'number' || t === 'integer') {
    return (
      <Input
        type="number"
        step={t === 'integer' ? 1 : 'any'}
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
        className="h-9"
      />
    )
  }
  return (
    <Input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="h-9"
    />
  )
}
