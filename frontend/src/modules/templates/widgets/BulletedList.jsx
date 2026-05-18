import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, LabelField, PreviewLabel, TextStyleField, textStyleToClassName } from './_shared'

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
      />
    </div>
  )
}

import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'

export function BulletedListEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const items = content?.items ?? []
  const bodyTextClass = textStyleToClassName(props.text_style)

  function patch(next) {
    const merged = { caption, items, ...next }
    if (!merged.caption) delete merged.caption
    onChange(merged)
  }
  function update(idx, value) {
    patch({ items: items.map((it, i) => (i === idx ? value : it)) })
  }
  function remove(idx) {
    patch({ items: items.filter((_, i) => i !== idx) })
  }
  function move(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= items.length) return
    const next = [...items]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patch({ items: next })
  }
  function add() {
    patch({ items: [...items, ''] })
  }

  if (readOnly) {
    const filled = items.filter((it) => it && it.trim().length > 0)
    if (!caption && filled.length === 0) return null
    return (
      <div className="space-y-2">
        <CaptionInput value={caption} readOnly />
        {filled.length > 0 && (
          <ul className={`text-sm list-disc pl-5 space-y-1 ${bodyTextClass}`}>
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
      />
      {items.length === 0 && (
        <p className="text-xs text-muted-foreground italic">아직 항목이 없습니다.</p>
      )}
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <span className="text-muted-foreground text-sm w-3">·</span>
          <Input
            value={item ?? ''}
            onChange={(e) => update(idx, e.target.value)}
            placeholder={props.placeholder || '항목 입력'}
            className={`h-8 flex-1 ${bodyTextClass}`}
          />
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
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={add}
        disabled={props.max_items != null && items.length >= props.max_items}
      >
        <Plus className="mr-1 h-3 w-3" />
        항목 추가
      </Button>
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
