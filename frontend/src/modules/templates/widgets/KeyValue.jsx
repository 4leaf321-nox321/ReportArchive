import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, DEFAULT_BODY_FONT_PX, FieldItemListEditor, LabelField, PreviewLabel, TextStyleField, captionSkipProps, textStyleToClassName, textStyleToInlineStyle } from './_shared'

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
        defaultSizePx={DEFAULT_BODY_FONT_PX}
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
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
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
  const bodyTextStyle = textStyleToInlineStyle(props.text_style)

  if (readOnly) {
    const filledItems = items.filter((item) => isFilled(item, data[item.key]))
    if (!caption && filledItems.length === 0) return null
    return (
      <div className="space-y-2">
        <CaptionInput value={caption} readOnly />
        {filledItems.length > 0 && (
          <div
            className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 items-baseline text-sm ${bodyTextClass}`}
            style={bodyTextStyle}
          >
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
        {...captionSkipProps({ content, patch })}
      />
      <div
        className={`grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 items-center ${bodyTextClass}`}
        style={bodyTextStyle}
      >
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

function isFilled(item, value) {
  if (value === undefined || value === null) return false
  if (item.multi) return Array.isArray(value) && value.some((v) => v !== '' && v != null)
  return value !== ''
}

function formatKvValue(item, value) {
  if (value === undefined || value === '' || value === null) return ''
  if (item.multi && Array.isArray(value)) {
    return value.filter((v) => v !== '' && v != null).map(String).join(', ')
  }
  return String(value)
}

function KvFieldInput({ item, value, onChange }) {
  if (item.multi) {
    return <MultiValueInput item={item} value={value} onChange={onChange} />
  }
  return <SingleValueInput item={item} value={value} onChange={onChange} />
}

/** Repeatable input list for `multi=true` items — defect types, reliability
 *  tests, etc. Always renders at least one input row (so the user can start
 *  typing without clicking anything first). Enter on the last row appends a
 *  fresh empty row and auto-focuses it; Enter on an earlier row just moves
 *  focus to the next one (browser-style Tab). ✕ removes a real entry; if
 *  the last real entry goes away the array is dropped from content so the
 *  read-only render filters the field out cleanly. */
function MultiValueInput({ item, value, onChange }) {
  const list = Array.isArray(value) ? value : []
  // We always render `max(1, list.length)` rows — when list is empty,
  // the first row is a "virtual" entry that becomes index 0 the moment
  // the user types into it (setAt pads the array up to that index).
  const rowCount = Math.max(1, list.length)
  const inputRefs = useRef([])
  const pendingFocusIdx = useRef(null)

  useEffect(() => {
    if (pendingFocusIdx.current != null) {
      const idx = pendingFocusIdx.current
      pendingFocusIdx.current = null
      const el = inputRefs.current[idx]
      if (el && typeof el.focus === 'function') el.focus()
    }
  })

  function setAt(idx, v) {
    const next = list.slice()
    // Pad with empties so the virtual trailing row can receive a value
    // (e.g. typing into the only row when list is []).
    while (next.length <= idx) next.push('')
    next[idx] = v
    onChange(next)
  }

  function removeAt(idx) {
    if (idx >= list.length) return // virtual row — nothing to remove
    const next = list.filter((_, i) => i !== idx)
    onChange(next.length === 0 ? undefined : next)
  }

  function handleEnter(idx) {
    if (idx === rowCount - 1) {
      // Last row: materialize any virtual cells and append a new empty
      // row to focus.
      const next = list.slice()
      while (next.length < rowCount) next.push('')
      next.push('')
      pendingFocusIdx.current = next.length - 1
      onChange(next)
    } else {
      // Mid-list: jump focus to the next row, same as Tab.
      const nextEl = inputRefs.current[idx + 1]
      if (nextEl && typeof nextEl.focus === 'function') nextEl.focus()
    }
  }

  // Keep the refs array tight; drop tails when rows shrink.
  inputRefs.current.length = rowCount

  return (
    <div className="space-y-1.5">
      {Array.from({ length: rowCount }).map((_, idx) => {
        const v = list[idx]
        const hasRealEntry = idx < list.length
        return (
          <div key={idx} className="flex items-center gap-1">
            <div className="flex-1">
              <SingleValueInput
                item={item}
                value={v}
                onChange={(nv) => setAt(idx, nv)}
                inputRef={(el) => {
                  inputRefs.current[idx] = el
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleEnter(idx)
                  }
                }}
              />
            </div>
            {hasRealEntry ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeAt(idx)}
                aria-label="값 제거"
              >
                <X className="h-3 w-3" />
              </Button>
            ) : (
              // Spacer so the virtual row aligns with the ones that do
              // have a remove button (avoids the input shifting width on
              // first keystroke).
              <span className="h-7 w-7 shrink-0" aria-hidden />
            )}
          </div>
        )
      })}
      <p className="text-[10px] text-muted-foreground pl-0.5">
        Enter로 항목 추가 · Tab으로 이동
      </p>
    </div>
  )
}

function SingleValueInput({ item, value, onChange, inputRef, onKeyDown }) {
  const t = item.type
  if (t === 'select') {
    return (
      <select
        ref={inputRef}
        onKeyDown={onKeyDown}
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
        ref={inputRef}
        onKeyDown={onKeyDown}
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
        ref={inputRef}
        onKeyDown={onKeyDown}
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
      ref={inputRef}
      onKeyDown={onKeyDown}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="h-9"
    />
  )
}
