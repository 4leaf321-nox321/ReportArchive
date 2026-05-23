import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Settings2, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { cn } from '@/shared/lib/utils'
import {
  CaptionInput,
  DEFAULT_BODY_FONT_PX,
  LabelField,
  PreviewLabel,
  TextStyleField,
  captionSkipProps,
  textStyleToClassName,
  textStyleToInlineStyle,
} from './_shared'

// --------------------------------------------------------------------------- //
// key_value — writer-owned arbitrary key/value pairs                          //
//                                                                              //
// Field shape (key / label / type / options? / multi?) used to live entirely  //
// in `props.items`, so the template designer locked down which keys a writer  //
// could fill in. That model is now optional: a fresh widget ships with no     //
// items, and the writer adds whichever pairs the report needs from inside     //
// the widget editor. `content.items` holds the writer's definition;          //
// `props.items` (if a template seeds anything) is the fallback.               //
// --------------------------------------------------------------------------- //

const FIELD_TYPES = [
  { value: 'text', label: '텍스트' },
  { value: 'number', label: '숫자' },
  { value: 'integer', label: '정수' },
  { value: 'date', label: '날짜' },
  { value: 'select', label: '선택지' },
]

function effectiveItems(content, props) {
  if (Array.isArray(content?.items)) return content.items
  if (Array.isArray(props?.items)) return props.items
  return []
}

function nextItemKey(items) {
  const existing = new Set((items ?? []).map((it) => it.key))
  let n = 1
  while (existing.has(`field_${n}`)) n += 1
  return `field_${n}`
}

function sanitizeKey(raw, otherKeys, fallbackIdx) {
  // Slug rules: lowercase, [a-z0-9_], must start with [a-z]. Empty or
  // invalid input falls back to "field_<idx+1>" so the writer can keep
  // typing without losing the row.
  let cleaned = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[^a-z]+/, '')
  if (!cleaned) cleaned = `field_${fallbackIdx + 1}`
  // De-dupe against the other keys.
  if (otherKeys.has(cleaned)) {
    let n = 2
    while (otherKeys.has(`${cleaned}_${n}`)) n += 1
    cleaned = `${cleaned}_${n}`
  }
  return cleaned
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

// --------------------------------------------------------------------------- //
// PropsPanel — label + text style only.                                       //
//                                                                              //
// All field definition has moved into the editor's "필드 정의" popover. The   //
// designer can still seed a starter set per template by exposing `items`      //
// through the underlying schema (used via JSON template import), but the UI   //
// here intentionally hides that knob to keep the surface honest: writers      //
// define their own keys.                                                       //
// --------------------------------------------------------------------------- //
export function KeyValuePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨 (선택)"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="메모"
      />
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        이 위젯의 key/value 항목은 보고서마다 작성자가 직접 정의합니다.
        템플릿에서 강제할 필드는 없습니다.
      </p>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => onChange({ ...props, text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //
export function KeyValuePreview({ props }) {
  const items = props.items ?? []
  return (
    <div className="space-y-2">
      {props.label && <PreviewLabel>{props.label}</PreviewLabel>}
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          보고서에서 작성자가 key / value 항목을 자유롭게 추가합니다.
        </p>
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

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //
export function KeyValueEditor({ props, content, onChange, readOnly }) {
  const data = content ?? {}
  const caption = data.caption ?? ''
  const items = effectiveItems(content, props)
  const bodyTextClass = textStyleToClassName(props.text_style)
  const bodyTextStyle = textStyleToInlineStyle(props.text_style)

  function patch(next) {
    const merged = { ...data, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    // content.items mirrors the template default when the writer hasn't
    // diverged. Strip it in that case so a later template-side items
    // change still flows through.
    if (Array.isArray(merged.items)) {
      const templateItems = props?.items
      if (
        Array.isArray(templateItems) &&
        JSON.stringify(merged.items) === JSON.stringify(templateItems)
      ) {
        delete merged.items
      } else if (merged.items.length === 0 && !Array.isArray(templateItems)) {
        // No template seed and writer also cleared everything — drop
        // the empty array so the content stays minimal.
        delete merged.items
      }
    }
    onChange(merged)
  }

  // ─── Item (field definition) handlers ──────────────────────────────
  function setItems(nextItems) {
    patch({ items: nextItems })
  }
  function addItem(template = {}) {
    const key = nextItemKey(items)
    setItems([...items, { key, label: '', type: 'text', ...template }])
  }
  function updateItem(idx, partial) {
    const current = items[idx]
    let next = { ...current, ...partial }
    let nextData = data
    // Key renames must move the stored value over to the new key, and
    // de-duplicate against other items.
    if (partial.key !== undefined && partial.key !== current.key) {
      const others = new Set(
        items.filter((_, i) => i !== idx).map((it) => it.key),
      )
      const cleanedKey = sanitizeKey(partial.key, others, idx)
      if (cleanedKey !== current.key) {
        const v = data[current.key]
        const { [current.key]: _drop, ...rest } = data
        nextData = v === undefined ? rest : { ...rest, [cleanedKey]: v }
      }
      next = { ...next, key: cleanedKey }
    }
    // Switching multi off when the stored value is an array — flatten
    // to the first non-empty entry so the single-value input renders
    // something sensible.
    if (partial.multi === false && Array.isArray(nextData[next.key])) {
      const arr = nextData[next.key]
      const firstReal = arr.find((v) => v !== '' && v != null)
      nextData = { ...nextData, [next.key]: firstReal ?? undefined }
      if (nextData[next.key] === undefined) delete nextData[next.key]
    }
    // Switching multi on — wrap the existing scalar so the multi
    // editor has somewhere to land.
    if (partial.multi === true && nextData[next.key] != null && !Array.isArray(nextData[next.key])) {
      nextData = { ...nextData, [next.key]: [nextData[next.key]] }
    }
    const nextItems = items.map((it, i) => (i === idx ? next : it))
    onChange({
      ...nextData,
      items: nextItems,
      ...(caption ? { caption } : {}),
    })
  }
  function removeItem(idx) {
    const removed = items[idx]
    const { [removed.key]: _drop, ...rest } = data
    onChange({
      ...rest,
      items: items.filter((_, i) => i !== idx),
      ...(caption ? { caption } : {}),
    })
  }
  function moveItem(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= items.length) return
    const next = [...items]
    const [m] = next.splice(idx, 1)
    next.splice(newIdx, 0, m)
    setItems(next)
  }

  // ─── Value handlers ────────────────────────────────────────────────
  function updateValue(key, value) {
    if (value === undefined || value === '') {
      const { [key]: _drop, ...rest } = data
      patch({ ...rest })
    } else {
      patch({ [key]: value })
    }
  }

  // ─── Read-only render ──────────────────────────────────────────────
  if (readOnly) {
    const filledItems = items.filter((item) => isFilled(item, data[item.key]))
    if (!caption && filledItems.length === 0) return null
    return (
      <div className="space-y-2">
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
        />
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

  // ─── Edit render ───────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
        {...captionSkipProps({ content, patch })}
      />
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          아직 항목이 없습니다.
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => addItem()}
            className="ml-2 h-7 text-xs"
          >
            <Plus className="mr-1 h-3 w-3" />첫 항목 추가
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            'grid grid-cols-[max-content_1fr_max-content] gap-x-2 gap-y-2 items-start',
            bodyTextClass,
          )}
          style={bodyTextStyle}
        >
          {items.map((item, idx) => (
            <KvRow
              key={idx}
              item={item}
              value={data[item.key]}
              isFirst={idx === 0}
              isLast={idx === items.length - 1}
              onChangeValue={(v) => updateValue(item.key, v)}
              onChangeItem={(partial) => updateItem(idx, partial)}
              onRemove={() => removeItem(idx)}
              onMove={(dir) => moveItem(idx, dir)}
            />
          ))}
        </div>
      )}
      {items.length > 0 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => addItem()}
          className="h-7 text-xs"
        >
          <Plus className="mr-1 h-3 w-3" />항목 추가
        </Button>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// One row = label + value + small overflow menu (rename, type, multi, ↑↓×)    //
// --------------------------------------------------------------------------- //
function KvRow({
  item,
  value,
  isFirst,
  isLast,
  onChangeValue,
  onChangeItem,
  onRemove,
  onMove,
}) {
  const [open, setOpen] = useState(false)

  // Click-outside dismissal for the inline settings drawer. Tied to the
  // wrapper element so clicks inside the drawer (rename, type select,
  // etc.) don't close it mid-edit.
  const drawerRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    function onDown(e) {
      if (!drawerRef.current) return
      if (drawerRef.current.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <>
      {/* Column 1 — label (editable inline) */}
      <div className="flex items-center gap-1 self-start py-1.5">
        <input
          type="text"
          value={item.label ?? ''}
          onChange={(e) => onChangeItem({ label: e.target.value })}
          placeholder={item.key}
          className={cn(
            'min-w-0 max-w-[10rem] bg-transparent border-0 outline-none',
            'focus:ring-1 focus:ring-ring rounded px-1 py-0.5',
            'text-sm text-muted-foreground placeholder:text-muted-foreground/50',
          )}
        />
        {item.required && <span className="text-destructive">*</span>}
      </div>

      {/* Column 2 — value input(s) */}
      <div className="min-w-0">
        <KvFieldInput
          item={item}
          value={value}
          onChange={onChangeValue}
        />
      </div>

      {/* Column 3 — settings trigger */}
      <div ref={drawerRef} className="relative self-start">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8',
            open && 'bg-muted',
          )}
          onClick={() => setOpen((o) => !o)}
          title="항목 설정"
          aria-label="항목 설정"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
        {open && (
          <div className="absolute z-20 right-0 mt-1 w-72 rounded-md border bg-popover p-3 shadow-md space-y-2 text-xs">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              항목 설정
            </div>

            <div className="space-y-1">
              <div>키 (영문 슬러그)</div>
              <Input
                value={item.key ?? ''}
                onChange={(e) => onChangeItem({ key: e.target.value })}
                placeholder="field_1"
                maxLength={64}
                className="h-7 text-xs font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                값을 저장하는 영문 식별자. 영문 소문자/숫자/언더스코어만.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <div>타입</div>
                <select
                  value={item.type ?? 'text'}
                  onChange={(e) => onChangeItem({ type: e.target.value })}
                  className="h-7 w-full rounded-md border bg-background px-1.5 text-xs"
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 pt-4">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!item.multi}
                    onChange={(e) => onChangeItem({ multi: e.target.checked || undefined })}
                  />
                  <span>다중값</span>
                </label>
              </div>
            </div>

            {item.type === 'select' && (
              <div className="space-y-1">
                <div>선택지 (쉼표 구분)</div>
                <Input
                  value={(item.options ?? []).join(', ')}
                  onChange={(e) =>
                    onChangeItem({
                      options: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="A, B, C"
                  className="h-7 text-xs"
                />
              </div>
            )}

            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={!!item.required}
                onChange={(e) =>
                  onChangeItem({ required: e.target.checked || undefined })
                }
              />
              <span>필수 입력 (UI 힌트)</span>
            </label>

            <div className="flex items-center justify-between gap-1 pt-1 border-t">
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={isFirst}
                  onClick={() => onMove(-1)}
                  title="위로"
                >
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={isLast}
                  onClick={() => onMove(1)}
                  title="아래로"
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive hover:text-destructive"
                onClick={() => {
                  onRemove()
                  setOpen(false)
                }}
              >
                <X className="mr-1 h-3 w-3" />항목 삭제
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
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

/** Repeatable input list for `multi=true` items. Same UX as before the
 *  refactor: one virtual empty row at the end, Enter materializes the
 *  next row, ✕ removes a real entry. */
function MultiValueInput({ item, value, onChange }) {
  const list = Array.isArray(value) ? value : []
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
    while (next.length <= idx) next.push('')
    next[idx] = v
    onChange(next)
  }

  function removeAt(idx) {
    if (idx >= list.length) return
    const next = list.filter((_, i) => i !== idx)
    onChange(next.length === 0 ? undefined : next)
  }

  function handleEnter(idx) {
    if (idx === rowCount - 1) {
      const next = list.slice()
      while (next.length < rowCount) next.push('')
      next.push('')
      pendingFocusIdx.current = next.length - 1
      onChange(next)
    } else {
      const nextEl = inputRefs.current[idx + 1]
      if (nextEl && typeof nextEl.focus === 'function') nextEl.focus()
    }
  }

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
