import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { useWidgetRelations } from '@/shared/hooks/useWidgetRelations'
import { CaptionInput, LabelField, PreviewLabel } from './_shared'

// --------------------------------------------------------------------------- //
// PropsPanel — template-time configuration
// --------------------------------------------------------------------------- //
export function RichTextPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="주간 요약"
      />
      <LabelField
        label="플레이스홀더"
        value={props.placeholder}
        onChange={(v) => onChange({ ...props, placeholder: v })}
        placeholder="이번 주 핵심 내용을 3-5줄로"
        hint="첫 줄에 보여줄 힌트"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">최소 글자 수</Label>
          <Input
            type="number"
            min={0}
            value={props.min_length ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                min_length: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">최대 글자 수</Label>
          <Input
            type="number"
            min={1}
            value={props.max_length ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                max_length: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!props.required}
          onChange={(e) => onChange({ ...props, required: e.target.checked })}
        />
        필수 입력
      </label>
      <p className="text-[10px] text-muted-foreground">
        이 위젯은 줄 단위 아웃라인 입력입니다. Tab으로 깊이를 늘리고 Shift+Tab으로 줄이세요.
        자식 줄(들여쓰기된 줄)의 <strong>맨 앞</strong>에서{' '}
        <span className="font-mono">//</span>를 입력하면 관계(원인/결과/예시 등)를
        키보드로 선택할 수 있습니다 (← → 이동, Enter 적용, Esc 취소). 문장 중간에는
        동작하지 않으며 일반 텍스트로 입력됩니다.
      </p>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview — placeholder shown in the template editor canvas
// --------------------------------------------------------------------------- //
export function RichTextPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint={props.required ? '필수' : null}>
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-sm text-muted-foreground">
        <div>□ {props.placeholder || '대표 문장'}</div>
        <div className="pl-6">– 상세 / 근거 / 예시</div>
        <div className="pl-12">· 더 깊은 설명</div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Constants — depth prefixes, indent, relation enum fallbacks
// --------------------------------------------------------------------------- //
const MAX_DEPTH = 5
const WARN_DEPTH = 4
const DEPTH_PREFIX = ['□', '–', '·', '·', '·', '·']
const INDENT_PX_PER_DEPTH = 24
const DEFAULT_RELATION = 'detail'
// Keyboard combo trigger — typed at the very start of a line to open the
// relation picker. Picked deliberately as a sequence that's rare in body
// text (a single "/" is too common — URL paths, dates, etc.).
const COMBO_TRIGGER = '//'

// Symbols typed at the start of a line that auto-convert to a depth.
// Order matters only for documentation — we match the first character.
const PREFIX_TO_DEPTH = {
  '□': 0,
  '■': 0,
  '◇': 0,
  '◆': 0,
  '-': 1,
  '*': 1,
  '–': 1,
  '·': 2,
  '◦': 2,
  '▪': 2,
}

// --------------------------------------------------------------------------- //
// Helpers — content shape coercion and parsers
// --------------------------------------------------------------------------- //
/**
 * Coerce whatever the report `content` has into our working `items` array.
 *   - new shape: { items: [...] }            → use as-is
 *   - legacy:    { markdown: "..." }         → parse line by line
 *   - missing/empty                          → single empty depth-0 item
 */
function coerceRichTextItems(content) {
  if (Array.isArray(content?.items) && content.items.length > 0) {
    return content.items.map(normalizeItem)
  }
  if (typeof content?.markdown === 'string' && content.markdown.length > 0) {
    return parseMarkdownToItems(content.markdown)
  }
  return [{ depth: 0, text: '' }]
}

function normalizeItem(it) {
  const depth = clamp(Math.floor(Number(it?.depth) || 0), 0, MAX_DEPTH)
  const text = typeof it?.text === 'string' ? it.text : ''
  const out = { depth, text }
  if (typeof it?.relation === 'string' && it.relation && it.relation !== DEFAULT_RELATION) {
    out.relation = it.relation
  }
  return out
}

/**
 * Parse the legacy markdown blob into outline items. Each non-empty line
 * becomes one item; depth is inferred from the prefix character (□/-/·).
 * If no recognized prefix, fall back to indent-by-two-spaces or depth 0.
 */
function parseMarkdownToItems(md) {
  const lines = md.split(/\r?\n/)
  const items = []
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const m = line.match(/^(\s*)(\S)\s+(.*)$/)
    if (m) {
      const indent = m[1] ?? ''
      const marker = m[2]
      const rest = m[3]
      if (PREFIX_TO_DEPTH[marker] !== undefined) {
        items.push({ depth: PREFIX_TO_DEPTH[marker], text: rest })
        continue
      }
      // No recognised marker — fall back to "every 2 spaces of indent = depth".
      const guessed = Math.min(3, Math.floor(indent.length / 2))
      items.push({ depth: guessed, text: line.trim() })
    } else {
      items.push({ depth: 0, text: line.trim() })
    }
  }
  return items.length > 0 ? items : [{ depth: 0, text: '' }]
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

// --------------------------------------------------------------------------- //
// Editor entrypoint — branches into the outline editor (write) or viewer
// --------------------------------------------------------------------------- //
export function RichTextEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const items = useMemo(() => coerceRichTextItems(content), [content])
  const totalChars = useMemo(
    () => items.reduce((sum, it) => sum + (it.text?.length ?? 0), 0),
    [items]
  )
  const min = props.min_length
  const max = props.max_length

  function patchItems(nextItems) {
    const merged = { caption, items: nextItems }
    if (!merged.caption) delete merged.caption
    if (!merged.items || merged.items.length === 0) delete merged.items
    onChange(merged)
  }

  function patchCaption(nextCaption) {
    const merged = { caption: nextCaption, items }
    if (!merged.caption) delete merged.caption
    if (!merged.items || merged.items.length === 0) delete merged.items
    onChange(merged)
  }

  if (readOnly) {
    const hasBody = items.some((it) => (it.text ?? '').trim() !== '')
    return (
      <div className="space-y-2">
        <CaptionInput value={caption} readOnly />
        {hasBody && <OutlineView items={items} />}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <CaptionInput
        value={caption}
        onChange={patchCaption}
        placeholder={props.label}
      />
      <OutlineEditor
        items={items}
        onChange={patchItems}
        placeholder={props.placeholder || '대표 문장을 입력하고 Tab으로 상세를 들여쓰세요.'}
      />
      {(min || max) && (
        <p className="text-[10px] text-muted-foreground text-right">
          {totalChars}자 {min ? `(최소 ${min})` : ''} {max ? `(최대 ${max})` : ''}
        </p>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// View mode — read-only structured render
// --------------------------------------------------------------------------- //
function OutlineView({ items }) {
  return (
    <div className="space-y-0.5 text-sm">
      {items.map((it, i) => {
        if (!(it.text ?? '').trim()) return null
        const depth = clamp(it.depth ?? 0, 0, MAX_DEPTH)
        return (
          <div
            key={i}
            className="flex items-start gap-2"
            style={{ paddingLeft: `${depth * INDENT_PX_PER_DEPTH}px` }}
          >
            <span className="select-none text-muted-foreground shrink-0 leading-6 w-4 text-center">
              {DEPTH_PREFIX[depth]}
            </span>
            <span className="flex-1 min-w-0 leading-6 whitespace-pre-wrap break-words">
              {it.text}
            </span>
            <RelationChipStatic relation={it.relation} />
          </div>
        )
      })}
    </div>
  )
}

function RelationChipStatic({ relation }) {
  const { byKey } = useWidgetRelations()
  if (!relation || relation === DEFAULT_RELATION) return null
  const rel = byKey[relation]
  const label = rel?.name ?? relation
  return (
    <span className="shrink-0 inline-flex items-center rounded bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200 text-[10px] px-1.5 py-0.5 leading-none mt-1">
      {label}
    </span>
  )
}

// --------------------------------------------------------------------------- //
// Edit mode — outline with Tab depth, auto-prefix, inline relation picker
// --------------------------------------------------------------------------- //
function OutlineEditor({ items, onChange, placeholder }) {
  // Each input row gets a stable ref slot. Map<index, HTMLInputElement>.
  const inputRefs = useRef(new Map())
  // After an edit operation we may want to refocus a particular row at a
  // particular caret position. Recorded here and applied in a layout effect.
  const pendingFocus = useRef(null)
  // The row that currently has focus. Drives the inline relation picker
  // strip below the input — only the focused, indented row shows it.
  const [focusedIndex, setFocusedIndex] = useState(null)

  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    const el = inputRefs.current.get(target.index)
    if (!el) return
    el.focus()
    if (typeof target.caret === 'number') {
      try {
        el.setSelectionRange(target.caret, target.caret)
      } catch {
        /* setSelectionRange not supported on some types — ignore */
      }
    }
  }, [items])

  const setInputRef = useCallback((index, el) => {
    if (el) inputRefs.current.set(index, el)
    else inputRefs.current.delete(index)
  }, [])

  function replace(nextItems, focus) {
    if (focus) pendingFocus.current = focus
    onChange(nextItems)
  }

  function updateText(idx, text) {
    const next = items.map((it, i) => (i === idx ? { ...it, text } : it))
    onChange(next)
  }

  function setDepth(idx, depth) {
    const prev = items[idx - 1]
    const maxAllowed = prev ? Math.min(MAX_DEPTH, prev.depth + 1) : 0
    const clamped = clamp(depth, 0, maxAllowed)
    if (clamped === items[idx].depth) return
    const next = items.map((it, i) => (i === idx ? { ...it, depth: clamped } : it))
    replace(next, { index: idx, caret: inputRefs.current.get(idx)?.selectionStart })
  }

  function setRelation(idx, relation) {
    const next = items.map((it, i) => {
      if (i !== idx) return it
      const copy = { ...it }
      if (relation && relation !== DEFAULT_RELATION) copy.relation = relation
      else delete copy.relation
      return copy
    })
    onChange(next)
  }

  /**
   * Atomic multi-field patch for a row. Required for any path that needs
   * to change text + relation (or depth + text) simultaneously — separate
   * callbacks would close over the same stale `items` snapshot and the
   * second call would silently overwrite the first.
   *
   * Use `relation: null` to clear the field. Omit a key to leave it alone.
   */
  function patchRow(idx, patch) {
    const next = items.map((it, i) => {
      if (i !== idx) return it
      const copy = { ...it, ...patch }
      if (
        Object.prototype.hasOwnProperty.call(patch, 'relation') &&
        (patch.relation === null || patch.relation === undefined)
      ) {
        delete copy.relation
      }
      if (typeof copy.depth === 'number') {
        copy.depth = clamp(copy.depth, 0, MAX_DEPTH)
      }
      return copy
    })
    onChange(next)
  }

  function insertAfter(idx, depth) {
    const newItem = { depth: clamp(depth, 0, MAX_DEPTH), text: '' }
    const next = [...items.slice(0, idx + 1), newItem, ...items.slice(idx + 1)]
    replace(next, { index: idx + 1, caret: 0 })
  }

  function removeAt(idx) {
    if (items.length === 1) {
      // Never go below one row; just clear it.
      replace([{ depth: 0, text: '' }], { index: 0, caret: 0 })
      return
    }
    const next = items.filter((_, i) => i !== idx)
    const focusIdx = Math.max(0, idx - 1)
    const caret = next[focusIdx]?.text?.length ?? 0
    replace(next, { index: focusIdx, caret })
  }

  function mergeWithPrevious(idx) {
    if (idx === 0) return
    const prev = items[idx - 1]
    const cur = items[idx]
    const mergedText = (prev.text ?? '') + (cur.text ?? '')
    const merged = { ...prev, text: mergedText }
    const next = [...items.slice(0, idx - 1), merged, ...items.slice(idx + 1)]
    replace(next, { index: idx - 1, caret: prev.text?.length ?? 0 })
  }

  return (
    <div className="rounded-md border bg-background p-2 space-y-0.5">
      {items.map((it, i) => (
        <OutlineRow
          key={i}
          index={i}
          item={it}
          isFirst={i === 0}
          parentDepth={items[i - 1]?.depth}
          placeholder={i === 0 && !it.text ? placeholder : ''}
          isFocused={focusedIndex === i}
          setInputRef={setInputRef}
          onFocus={() => setFocusedIndex(i)}
          onBlur={() => {
            // Defer so a click landing on the picker strip below the row
            // has time to reapply focus to the same input before we hide
            // the strip. Without this, clicking the picker would dismiss
            // it before the click handler ran.
            setTimeout(() => {
              setFocusedIndex((cur) => (cur === i ? null : cur))
            }, 0)
          }}
          onTextChange={(text) => updateText(i, text)}
          onDepthChange={(d) => setDepth(i, d)}
          onRelationChange={(r) => setRelation(i, r)}
          onPatch={(p) => patchRow(i, p)}
          onNewLine={() => insertAfter(i, it.depth)}
          onDeleteEmpty={() => removeAt(i)}
          onMergeWithPrev={() => mergeWithPrevious(i)}
          onFocusPrev={(caret) => {
            const prev = i - 1
            if (prev < 0) return
            const el = inputRefs.current.get(prev)
            if (!el) return
            el.focus()
            const target = clamp(caret ?? prev.text?.length ?? 0, 0, el.value.length)
            try {
              el.setSelectionRange(target, target)
            } catch {
              /* ignore */
            }
          }}
          onFocusNext={(caret) => {
            const nxt = i + 1
            if (nxt >= items.length) return
            const el = inputRefs.current.get(nxt)
            if (!el) return
            el.focus()
            const target = clamp(caret ?? 0, 0, el.value.length)
            try {
              el.setSelectionRange(target, target)
            } catch {
              /* ignore */
            }
          }}
        />
      ))}
    </div>
  )
}

function OutlineRow({
  index,
  item,
  isFirst,
  parentDepth,
  placeholder,
  isFocused,
  setInputRef,
  onFocus,
  onBlur,
  onTextChange,
  onDepthChange,
  onRelationChange,
  onPatch,
  onNewLine,
  onDeleteEmpty,
  onMergeWithPrev,
  onFocusPrev,
  onFocusNext,
}) {
  const depth = clamp(item.depth ?? 0, 0, MAX_DEPTH)
  const showWarning = depth >= WARN_DEPTH
  const relation = item.relation && item.relation !== DEFAULT_RELATION ? item.relation : null
  const rowText = item.text ?? ''
  // Picker strip appears only on indented rows — depth 0 has no parent, so
  // a "child role relative to parent" relation makes no sense there.
  const showPicker = isFocused && depth >= 1

  // ── Slash combobox state (keyboard-driven picker) ──────────────────────
  // Combo mode activates when the row text starts with COMBO_TRIGGER ("//")
  // on a depth-≥1 focused row. Mid-line "//" does NOT trigger — only when
  // the entire row text begins with it. Esc temporarily dismisses for this
  // typing session; the dismissal resets the moment the leading trigger is
  // cleared.
  const { relations } = useWidgetRelations()
  const [hoverIdx, setHoverIdx] = useState(0)
  const [comboDismissed, setComboDismissed] = useState(false)
  const startsWithTrigger = rowText.startsWith(COMBO_TRIGGER)
  const comboActive = showPicker && startsWithTrigger && !comboDismissed
  const filter = startsWithTrigger ? rowText.slice(COMBO_TRIGGER.length) : ''

  // Reset Esc-dismiss the moment the trigger is gone, so re-typing it
  // reopens the picker.
  useEffect(() => {
    if (!startsWithTrigger && comboDismissed) setComboDismissed(false)
  }, [startsWithTrigger, comboDismissed])

  // Auto-jump highlight to the first chip whose slug or Korean name starts
  // with the typed filter. Empty filter leaves hoverIdx alone (so opening
  // the combo doesn't snap away from the user's last selection).
  useEffect(() => {
    if (!comboActive || !filter) return
    const lc = filter.toLowerCase()
    const idx = relations.findIndex(
      (r) => r.slug.toLowerCase().startsWith(lc) || r.name.startsWith(filter),
    )
    if (idx >= 0) setHoverIdx(idx)
  }, [filter, relations, comboActive])

  // Keep hoverIdx in bounds if the relation list shrinks (admin deleted one).
  useEffect(() => {
    if (relations.length === 0) return
    if (hoverIdx >= relations.length) setHoverIdx(0)
  }, [relations.length, hoverIdx])

  // Strip the leading trigger ("//token") and any trailing space from
  // rowText, then apply the relation. Body text after the trigger stays
  // in place. Both fields update atomically — separate text + relation
  // callbacks would race on the same stale items snapshot, leaving the
  // "//" behind.
  function applyCombo(slug) {
    const m = rowText.match(/^\/\/\S*\s?(.*)$/)
    onPatch({
      text: m ? m[1] : '',
      relation: slug === DEFAULT_RELATION ? null : slug,
    })
  }

  // Single entrypoint used by both keyboard (Enter) and mouse (chip click)
  // — when combo is active, the slash text is consumed; otherwise it's a
  // plain relation set.
  function selectRelation(slug) {
    if (comboActive) applyCombo(slug)
    else onRelationChange(slug === DEFAULT_RELATION ? null : slug)
  }

  function handleChange(e) {
    const next = e.target.value
    // Legacy text shortcut (`//원인 ` with trailing space) — apply
    // immediately when the full slug or Korean name matches exactly.
    // Combo navigation handles the partial / prefix path; this is for
    // power users who type the whole thing in one go. Atomic patch so
    // text + relation update together.
    const m = next.match(/^\/\/([^\s/]+)\s(.*)$/)
    if (m) {
      const token = m[1]
      const rest = m[2]
      const matched = relations.find((r) => r.slug === token || r.name === token)
      if (matched) {
        onPatch({
          text: rest,
          relation: matched.slug === DEFAULT_RELATION ? null : matched.slug,
        })
        return
      }
    }
    // Auto-prefix conversion: if the text starts with a recognized prefix
    // followed by a space, strip it and remap depth. Only fires when the
    // line is starting fresh (i.e. user is at the start of a new line).
    // Atomic patch (depth + text) avoids the same race.
    if (next.length >= 2 && next[1] === ' ') {
      const target = PREFIX_TO_DEPTH[next[0]]
      if (target !== undefined && target !== depth) {
        const stripped = next.slice(2)
        const maxAllowed = isFirst ? 0 : Math.min(MAX_DEPTH, (parentDepth ?? 0) + 1)
        const newDepth = clamp(target, 0, maxAllowed)
        onPatch({ depth: newDepth, text: stripped })
        return
      }
    }
    onTextChange(next)
  }

  function handleKeyDown(e) {
    // Combo navigation takes priority over everything else when active.
    if (comboActive && relations.length > 0) {
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowUp' ||
        (e.key === 'Tab' && e.shiftKey)
      ) {
        e.preventDefault()
        setHoverIdx((i) => (i - 1 + relations.length) % relations.length)
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Tab') {
        e.preventDefault()
        setHoverIdx((i) => (i + 1) % relations.length)
        return
      }
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        const target = relations[hoverIdx]
        if (target) applyCombo(target.slug)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setComboDismissed(true)
        return
      }
      // Other keys (letters, backspace) fall through to normal text edit
      // — the filter updates naturally on the next onChange.
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      onNewLine()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      onDepthChange(e.shiftKey ? depth - 1 : depth + 1)
      return
    }
    const caret = e.target.selectionStart ?? 0
    const end = e.target.selectionEnd ?? caret
    if (e.key === 'Backspace' && caret === 0 && end === 0) {
      // Indented row → outdent first. One Backspace = one level up,
      // mirroring how Notion/Workflowy outliners behave. The text on the
      // row stays intact.
      if (depth > 0) {
        e.preventDefault()
        onDepthChange(depth - 1)
        return
      }
      // depth === 0 (□ row): empty → delete entire row;
      // non-empty → merge into the previous row (preserves text).
      if (rowText.length === 0) {
        e.preventDefault()
        onDeleteEmpty()
        return
      }
      e.preventDefault()
      onMergeWithPrev()
      return
    }
    if (e.key === 'ArrowUp' && caret === 0) {
      e.preventDefault()
      onFocusPrev(caret)
      return
    }
    if (e.key === 'ArrowDown' && caret === rowText.length) {
      e.preventDefault()
      onFocusNext(caret)
      return
    }
  }

  return (
    <div style={{ paddingLeft: `${depth * INDENT_PX_PER_DEPTH}px` }}>
      <div className="flex items-start gap-2 group">
        <span className="select-none text-muted-foreground shrink-0 leading-8 w-4 text-center">
          {DEPTH_PREFIX[depth]}
        </span>
        <input
          ref={(el) => setInputRef(index, el)}
          type="text"
          value={rowText}
          placeholder={placeholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/50 text-sm py-1 leading-6"
        />
        <RelationChip relation={relation} onChange={onRelationChange} />
        {showWarning && <DepthWarning depth={depth} />}
      </div>
      {showPicker && (
        <RelationPickerStrip
          currentRelation={relation}
          comboActive={comboActive}
          hoverIdx={hoverIdx}
          onSelect={selectRelation}
        />
      )}
    </div>
  )
}

/**
 * Horizontal chip strip with every relation in the workspace's vocabulary.
 * Renders directly under the focused row's input.
 *
 *  - Always clickable (mouse-friendly): clicking a chip applies that
 *    relation, with mousedown.preventDefault so focus stays in the input.
 *  - Keyboard combo mode: when the row text starts with "/", `hoverIdx`
 *    drives a strong ring highlight that the user navigates with arrows.
 *    The hint slot on the right flips to "← → ↵ ⎋" as a discovery cue.
 *
 * `currentRelation` (the saved slug, may be null/detail) shows a subtle
 * ring on its chip independently of `hoverIdx`, so the user can see both
 * "what's currently set" and "what will Enter pick" at the same time.
 */
function RelationPickerStrip({ currentRelation, comboActive, hoverIdx, onSelect }) {
  const { relations, loading } = useWidgetRelations()
  if (loading) return null
  // Order matches the `relations` array — index 0 = detail, then sort_order.
  return (
    <div
      className="mt-0.5 ml-6 flex flex-wrap items-center gap-1 text-[10px]"
      onMouseDown={(e) => {
        // Keep focus on the input so blur doesn't fire and dismiss us.
        e.preventDefault()
      }}
    >
      <span className="text-muted-foreground select-none">관계:</span>
      {relations.map((r, i) => {
        const isCurrent =
          r.slug === DEFAULT_RELATION
            ? !currentRelation
            : currentRelation === r.slug
        const isComboPick = comboActive && i === hoverIdx
        return (
          <PickerChip
            key={r.slug}
            current={isCurrent}
            comboPick={isComboPick}
            onClick={() => onSelect(r.slug)}
            title={r.description ?? r.name}
          >
            {r.name}
          </PickerChip>
        )
      })}
      <span className="ml-auto pl-2 text-muted-foreground/70 select-none">
        {comboActive ? (
          <span className="font-mono">← → ↵ ⎋</span>
        ) : (
          <span>
            줄 맨 앞에서 <span className="font-mono">//</span> 입력 → 키보드 선택
          </span>
        )}
      </span>
    </div>
  )
}

function PickerChip({ current, comboPick, onClick, title, children }) {
  // `comboPick` (active in keyboard combo) wins visually — it's the chip
  // Enter would pick right now. `current` is a softer underline-style
  // marker on whichever relation is saved.
  const ring = comboPick
    ? 'ring-2 ring-amber-500'
    : current
      ? 'ring-1 ring-amber-300'
      : ''
  const bg = comboPick || current
    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200'
    : 'bg-muted text-muted-foreground hover:bg-muted/70'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 leading-none transition-colors ${bg} ${ring}`}
    >
      {children}
    </button>
  )
}

function DepthWarning({ depth }) {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-[10px] mt-1.5"
      title={
        '깊은 단계는 AI Reading / RAG 분석에서 부모 문맥과의 연결이 흐릿해질 수 있습니다.\n' +
        `현재 깊이: ${depth + 1}단계 (3단계 이내 권장)`
      }
    >
      <AlertTriangle className="h-3 w-3" />
      깊은 단계
    </span>
  )
}

// --------------------------------------------------------------------------- //
// Relation chip — small inline label shown next to the prefix when a row
// has a non-default relation assigned. Click X to clear. The picker (and
// slash command handling) live in OutlineRow.
// --------------------------------------------------------------------------- //
function RelationChip({ relation, onChange }) {
  const { byKey } = useWidgetRelations()
  if (!relation) return null
  const rel = byKey[relation]
  const label = rel?.name ?? relation
  const known = Boolean(rel)

  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 rounded text-[10px] px-1.5 py-0.5 leading-none mt-1.5 ${
        known
          ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200'
          : 'bg-muted text-muted-foreground'
      }`}
      title={known ? rel.description || rel.name : `알 수 없는 관계: ${relation}`}
    >
      {label}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(null)}
        className="opacity-50 hover:opacity-100"
        aria-label="관계 제거"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  )
}
