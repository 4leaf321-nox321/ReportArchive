import { useEffect, useRef } from 'react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, DEFAULT_BODY_FONT_PX, LabelField, PreviewLabel, TextStyleField, captionSkipProps, textStyleToClassName, textStyleToInlineStyle } from './_shared'

export function BulletedListPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="이번 주 한 일"
      />
      <LabelField
        label="플레이스홀더"
        value={props.placeholder}
        onChange={(v) => onChange({ ...props, placeholder: v })}
        placeholder="한 항목씩 입력"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">최소 항목 수</Label>
          <Input
            type="number"
            min={0}
            value={props.min_items ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                min_items: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">최대 항목 수</Label>
          <Input
            type="number"
            min={1}
            value={props.max_items ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                max_items: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
      </div>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => onChange({ ...props, text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
    </div>
  )
}

import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'

export function BulletedListEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const items = content?.items ?? []
  const bodyTextClass = textStyleToClassName(props.text_style)
  const bodyTextStyle = textStyleToInlineStyle(props.text_style)
  const maxItems = props.max_items
  // Same "always at least one row, last row is virtual when array is empty"
  // pattern that key_value's multi-value input uses. Enter on the last row
  // appends + focuses a fresh empty entry; Enter mid-list jumps focus
  // forward (browser-style Tab also works since we render native inputs).
  const rowCount = Math.max(1, items.length)
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
  inputRefs.current.length = rowCount

  function patch(next) {
    // Spread `content` so unknown fields (e.g. caption_skip_autofill,
    // future per-block metadata) survive across patches that only
    // touch caption/items.
    const merged = { ...(content ?? {}), caption, items, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    onChange(merged)
  }
  function setAt(idx, value) {
    const next = items.slice()
    while (next.length <= idx) next.push('')
    next[idx] = value
    patch({ items: next })
  }
  function remove(idx) {
    if (idx >= items.length) return // virtual row
    patch({ items: items.filter((_, i) => i !== idx) })
  }
  function move(idx, dir) {
    if (idx >= items.length) return // virtual row can't move
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= items.length) return
    const next = [...items]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patch({ items: next })
  }
  function handleEnter(idx) {
    if (idx === rowCount - 1) {
      // Append + focus a new empty row — unless max_items would be exceeded.
      if (maxItems != null && items.length >= maxItems) return
      const next = items.slice()
      while (next.length < rowCount) next.push('')
      next.push('')
      pendingFocusIdx.current = next.length - 1
      patch({ items: next })
    } else {
      const nextEl = inputRefs.current[idx + 1]
      if (nextEl && typeof nextEl.focus === 'function') nextEl.focus()
    }
  }

  if (readOnly) {
    const filled = items.filter((it) => it && it.trim().length > 0)
    if (!caption && filled.length === 0) return null
    return (
      <div className="space-y-2">
        <CaptionInput value={caption} readOnly />
        {filled.length > 0 && (
          <ul
            className={`text-sm list-disc pl-5 space-y-1 ${bodyTextClass}`}
            style={bodyTextStyle}
          >
            {filled.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
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
      {Array.from({ length: rowCount }).map((_, idx) => {
        const hasRealEntry = idx < items.length
        const value = items[idx]
        const atMax = maxItems != null && items.length >= maxItems
        return (
          <div key={idx} className="flex items-center gap-1">
            <span className="text-muted-foreground text-sm w-3">·</span>
            <Input
              ref={(el) => {
                inputRefs.current[idx] = el
              }}
              value={value ?? ''}
              onChange={(e) => setAt(idx, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleEnter(idx)
                }
              }}
              placeholder={props.placeholder || '항목 입력'}
              className={`h-8 flex-1 ${bodyTextClass}`}
              style={bodyTextStyle}
            />
            {hasRealEntry ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={idx === 0}
                  onClick={() => move(idx, -1)}
                >
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={idx === items.length - 1}
                  onClick={() => move(idx, 1)}
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  onClick={() => remove(idx)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </>
            ) : (
              // Spacers so the virtual row's width matches real rows
              // (avoids the input shifting on first keystroke).
              <span className="h-7 w-[5.25rem] shrink-0" aria-hidden />
            )}
            {idx === rowCount - 1 && atMax && hasRealEntry && (
              <span className="text-[10px] text-muted-foreground pl-2">
                최대 {maxItems}개
              </span>
            )}
          </div>
        )
      })}
      <p className="text-[10px] text-muted-foreground pl-4">
        Enter로 항목 추가 · Tab으로 이동
      </p>
    </div>
  )
}

export function BulletedListPreview({ props }) {
  const minItems = props.min_items ?? 0
  const previewCount = Math.max(2, Math.min(minItems || 2, 4))
  return (
    <div className="space-y-2">
      <PreviewLabel
        hint={
          minItems > 0 || props.max_items
            ? `${minItems}-${props.max_items ?? '∞'}개`
            : null
        }
      >
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <ul className="text-sm space-y-1 text-foreground/50">
        {Array.from({ length: previewCount }).map((_, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="h-1 w-1 rounded-full bg-muted-foreground" />
            <span className="italic">{props.placeholder || '항목'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
