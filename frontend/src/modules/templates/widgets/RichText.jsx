import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import { AlertTriangle, X } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { cn } from '@/shared/lib/utils'
import { useWidgetCatalog } from '@/shared/hooks/useWidgetCatalog'
import { useWidgetRelations } from '@/shared/hooks/useWidgetRelations'
import { useReportStyle } from '@/shared/reports/ReportStyleContext'
import { useReportMention } from '@/shared/reports/ReportMentionContext'
import { hexToToken, colorTokenClass, tokenFromClassName } from '@/shared/text-color'
import { blockRefKey, outlineNumbers } from '@/shared/reports/blockNumbering'
import {
  CaptionInput,
  DEFAULT_BODY_FONT_PX,
  DepthStyleField,
  LabelField,
  PreviewLabel,
  TextStyleField,
  captionSkipProps,
  captionPositionOf,
  depthBodyClassName,
  depthBodyInlineStyle,
  depthBodyBaseSizePx,
} from './_shared'
import {
  RichTextRowEditor,
  RichTextFormatToolbarBody,
  RICH_TEXT_TOOLBAR_CLASS,
} from './RichTextRowEditor'

// HTML coming back from the editor is already constrained to TipTap's
// configured marks (bold/italic/underline/text style + color/size), but
// content can also arrive through API PATCHes that bypass the editor. We
// sanitize on render too so a malicious payload can't cross into the DOM.
// `style` is allowed for inline color/font-size from TextStyle marks —
// DOMPurify runs its own CSS sanitizer on the value, blocking url(),
// expression(), and other vectors.
const SANITIZE_OPTIONS = {
  // `a` is the @멘션 보고서 링크 (ReportLinkMark). We deliberately allow only
  // the data-* targeting attrs + class — NOT `href` — so navigation goes
  // through the delegated SPA click handler (OutlineView) and no javascript:
  // / external href vector can ride in via API-bypassed content.
  ALLOWED_TAGS: ['p', 'span', 'strong', 'em', 'u', 's', 'del', 'br', 'a'],
  ALLOWED_ATTR: [
    'style',
    'class',
    // 제네릭 멘션 스키마(종류가 늘어도 고정).
    'data-mention-type',
    'data-mention-id',
    'data-mention-ws',
    'data-mention-axis',
    'data-mention-page',
    // 구형 멘션(이미 저장된 보고서 호환).
    'data-report-id',
    'data-workspace-slug',
    'data-dept-slug',
  ],
}

// View-side migration: content saved before the token system carries inline
// `color: #hex` (or `<font color>`). Map each to a `rt-c-{token}` class so it
// adapts to the theme (and pasted/legacy black absorbs to inherited
// foreground). The stored html is untouched — only the rendered string is
// rewritten. New content already uses classes, so the cheap regex guard skips
// the DOM round-trip entirely. Editing such a row re-saves it as tokens.
function normalizeLegacyColorsForView(safe) {
  if (!/color/i.test(safe) || typeof DOMParser === 'undefined') return safe
  let doc
  try {
    doc = new DOMParser().parseFromString(safe, 'text/html')
  } catch {
    return safe
  }
  doc.querySelectorAll('font[color]').forEach((el) => {
    const cls = colorTokenClass(hexToToken(el.getAttribute('color')))
    el.removeAttribute('color')
    if (cls) el.classList.add(cls)
  })
  doc.querySelectorAll('[style]').forEach((el) => {
    const { style } = el
    if (style.color) {
      const cls = colorTokenClass(hexToToken(style.color))
      style.removeProperty('color')
      if (cls) el.classList.add(cls)
    }
    style.removeProperty('background-color')
    style.removeProperty('background')
    if (!el.getAttribute('style')) el.removeAttribute('style')
  })
  return doc.body.innerHTML
}

// Rewrite the visible text of block references (`#위젯 참조`) to the *current*
// number from the live index, so "그림 3" follows reorders without rewriting
// stored content. The stored html only needs the block id; the label is
// derived. Deleted targets show "(삭제된 항목)". No-op when there's no index
// (export/preview) or no block mentions in the row.
function relabelBlockMentions(html, blockIndex) {
  if (
    !blockIndex ||
    typeof html !== 'string' ||
    !html.includes('data-mention-type="block"') ||
    typeof DOMParser === 'undefined'
  ) {
    return html
  }
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }
  doc.querySelectorAll('a[data-mention-type="block"]').forEach((a) => {
    const id = a.getAttribute('data-mention-id')
    const page = a.getAttribute('data-mention-page')
    const entry =
      id != null && page != null ? blockIndex.get(blockRefKey(page, id)) : null
    a.textContent = entry ? entry.label : '(삭제된 항목)'
  })
  return doc.body.innerHTML
}

function sanitizeRowHtml(html, fallbackText) {
  if (typeof html === 'string' && html.length > 0) {
    return normalizeLegacyColorsForView(DOMPurify.sanitize(html, SANITIZE_OPTIONS))
  }
  if (typeof fallbackText === 'string' && fallbackText.length > 0) {
    return `<p>${escapeHtml(fallbackText)}</p>`
  }
  return ''
}

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
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!props.outline_numbering}
          onChange={(e) =>
            onChange({ ...props, outline_numbering: e.target.checked || undefined })
          }
        />
        개요 번호 매기기 (1 / 1.1 / 1.1.1)
        <span className="text-[10px] text-muted-foreground">
          깊이 기호(■ – ·) 대신 계층 번호
        </span>
      </label>
      <p className="text-[10px] text-muted-foreground">
        이 위젯은 줄 단위 아웃라인 입력입니다. Tab으로 깊이를 늘리고 Shift+Tab으로 줄이세요.
        자식 줄(들여쓰기된 줄)의 <strong>맨 앞</strong>에서{' '}
        <span className="font-mono">//</span>를 입력하면 상위 문장과의 관계
        (상세/원인/결과/예시 등)를 키보드로 선택할 수 있습니다 (← → 이동, Enter 적용, Esc 취소).
        문장 중간에는 동작하지 않으며 일반 텍스트로 입력됩니다.
      </p>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => onChange({ ...props, text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
      <DepthStyleField
        value={props.depth_styles}
        onChange={(depth_styles) => onChange({ ...props, depth_styles })}
        // Each depth's "기본" reflects the base text_style — if the user
        // set a numeric base, that's the inherited value; otherwise the
        // widget's body default applies.
        baseSizePx={props.text_style?.font_size_px ?? DEFAULT_BODY_FONT_PX}
      />
      <p className="text-[10px] text-muted-foreground">
        스타일은 본문 텍스트에만 적용됩니다. 깊이 기호(■ – ·)와 들여쓰기, 관계 칩은 가독성을 위해 고정 크기로 유지됩니다.
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
        <div>■ {props.placeholder || '대표 문장'}</div>
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
// Depth 0 used to render as `□` (hollow square) but that glyph is now
// reserved for the top-level 전체 과제명 marker elsewhere in the doc.
// Switched to `■` — solid square, neutral "key point" semantic without
// the directional bias that made `▶` get misread as "→ 결론" by AI when
// drafting bulleted bodies. Visually distinct from `□` so 대표 문장 vs
// 전체 과제명 don't blur. Backward compat: `□` and `▶` are still
// accepted as depth-0 paste triggers (see PREFIX_TO_DEPTH below) so
// older content / pastes still parse correctly; only the displayed
// glyph changes.
const DEPTH_PREFIX = ['■', '-', '·', '·', '·', '·']
const INDENT_PX_PER_DEPTH = 24
// Keyboard combo trigger — typed at the very start of a line to open the
// relation picker. Picked deliberately as a sequence that's rare in body
// text (a single "/" is too common — URL paths, dates, etc.).
const COMBO_TRIGGER = '//'

// 개요 번호(1 / 1.1 / 1.1.1) — outline_numbering 이 켜진 위젯에서 prefix 글리프
// 대신 쓴다. 위젯·DOCX·PPTX 가 같은 결과를 쓰도록 공유 모듈에 둔다.
const computeOutlineNumbers = outlineNumbers

// Symbols typed at the start of a line that auto-convert to a depth.
// Order matters only for documentation — we match the first character.
const PREFIX_TO_DEPTH = {
  '■': 0,
  '□': 0, // kept for backward compat — old content + pastes still parse
  '▶': 0, // kept for backward compat — content from prior `▶` glyph
  '▷': 0,
  '◇': 0,
  '◆': 0,
  '-': 1,
  '*': 1,
  '–': 1,
  '·': 2,
  '◦': 2,
  '▪': 2,
  '→': 2, // 화살표 머리표 — 붙여넣기 시 depth 2 로 인식(예: □ > - > →)
  '▸': 2,
  '➔': 2,
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
    return parseMarkdownToItems(content.markdown).map(normalizeItem)
  }
  return [normalizeItem({ depth: 0, text: '' })]
}

function normalizeItem(it) {
  const depth = clamp(Math.floor(Number(it?.depth) || 0), 0, MAX_DEPTH)
  const text = typeof it?.text === 'string' ? it.text : ''
  // Legacy rows have only `text` (plain string). On-the-fly conversion:
  // wrap as `<p>{escaped}</p>` so the rich-text editor can load it. Once
  // the row is touched in the editor, `html` is written back alongside
  // the derived `text` and the migration is permanent for that row.
  const html =
    typeof it?.html === 'string' && it.html.length > 0
      ? it.html
      : text
        ? `<p>${escapeHtml(text)}</p>`
        : '<p></p>'
  const out = { depth, text, html }
  // Any non-empty relation slug is preserved verbatim. `detail` is a real
  // relation just like `cause`/`effect` — the only "no relation" state is
  // the absence of the field.
  if (typeof it?.relation === 'string' && it.relation) {
    out.relation = it.relation
  }
  return out
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Strip the outer <p> wrapper so two rows can be concatenated as a single
// paragraph during mergeWithPrevious. Non-<p> input falls through unchanged.
function unwrapParagraph(html) {
  if (typeof html !== 'string') return ''
  const m = html.match(/^\s*<p[^>]*>([\s\S]*)<\/p>\s*$/)
  return m ? m[1] : html
}

// Read whether the first text run of a row's html is wrapped in `tag` (so
// the cross-row toolbar can pick a sensible "currently active" state — we
// look at the first row in the range as the representative).
function rowFirstRunHasTag(html, tag) {
  if (typeof html !== 'string' || !html || typeof DOMParser === 'undefined') {
    return false
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const p = doc.body.firstElementChild
  if (!p) return false
  let cur = p.firstChild
  while (cur) {
    if (cur.nodeType === 3 /* TEXT_NODE */) return false
    if (cur.nodeType !== 1) {
      cur = cur.nextSibling
      continue
    }
    if (cur.tagName.toLowerCase() === tag) return true
    cur = cur.firstChild
  }
  return false
}

// Read the marks + inline style applied to the *first* text run inside the
// row's html. We use this to style the leading prefix glyph (■ / – / ·)
// so it visually matches whatever formatting the writer applied to the
// start of the row — bold body text gets a bold bullet, a 24px first
// run gets a 24px bullet, etc.
//
// Walks down the first descendant chain until it hits a text node,
// collecting Tailwind class names (purge-safe — all literals here) for
// recognized marks, the color *token* (from the `rt-c-*` class or a legacy
// inline color), and font-size from inline style.
//
// Returns { className, style, colorToken }: `style` carries only font-size now;
// color rides as a token class inside `className` so the prefix glyph adapts to
// the theme exactly like the body text it mirrors.
const _FIRST_RUN_TAG_TO_CLASS = {
  strong: 'font-bold',
  b: 'font-bold',
  em: 'italic',
  i: 'italic',
  u: 'underline',
  s: 'line-through',
  del: 'line-through',
  strike: 'line-through',
}
function firstRunFormatting(html) {
  const out = { className: '', style: undefined, colorToken: null }
  if (typeof html !== 'string' || html.length === 0 || typeof DOMParser === 'undefined') {
    return out
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const p = doc.body.firstElementChild
  if (!p) return out
  const classes = []
  const style = {}
  let colorToken = null
  let cur = p.firstChild
  while (cur) {
    if (cur.nodeType === 3 /* TEXT_NODE */) {
      if (cur.nodeValue && cur.nodeValue.length > 0) break
      cur = cur.nextSibling
      continue
    }
    if (cur.nodeType !== 1 /* ELEMENT_NODE */) {
      cur = cur.nextSibling
      continue
    }
    const tag = cur.tagName.toLowerCase()
    const cls = _FIRST_RUN_TAG_TO_CLASS[tag]
    if (cls) classes.push(cls)
    // Color token: prefer the canonical class, fall back to legacy inline
    // color (firstRunFormatting reads the raw stored html, which may predate
    // the token migration).
    const fromClass = tokenFromClassName(cur.getAttribute('class') || '')
    if (fromClass) colorToken = fromClass
    if (tag === 'span') {
      const inline = cur.getAttribute('style') || ''
      const cm = inline.match(/(^|;)\s*color\s*:\s*([^;]+)/i)
      const fm = inline.match(/(^|;)\s*font-size\s*:\s*([^;]+)/i)
      const ff = inline.match(/(^|;)\s*font-family\s*:\s*([^;]+)/i)
      if (cm && !colorToken) colorToken = hexToToken(cm[2].trim())
      if (fm) style.fontSize = fm[2].trim()
      if (ff) style.fontFamily = ff[2].trim()
    }
    // Descend into the first child; if none, advance to next sibling.
    if (cur.firstChild) cur = cur.firstChild
    else cur = cur.nextSibling
  }
  const colorClass = colorTokenClass(colorToken)
  if (colorClass) classes.push(colorClass)
  out.className = classes.join(' ')
  out.colorToken = colorToken
  if (Object.keys(style).length > 0) out.style = style
  return out
}

/**
 * Parse the legacy markdown blob into outline items. Each non-empty line
 * becomes one item; depth is inferred from the prefix character (■/□/▶/-/·).
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

// Selection ranges return text nodes for endpoints; rowFromNode walks up to
// the nearest element so we can use Element.closest('[data-row-index]') to
// locate which paragraph row a drag started/ended in.
function elementOf(node) {
  if (!node) return null
  return node.nodeType === 1 ? node : node.parentElement
}

// Locate the first / last text node we can anchor a Selection range to. Used
// by the Ctrl+A handler: empty rows have no text nodes at all so we fall
// back to the row element itself (offset 0 / childCount).
function firstSelectableInside(rowEl) {
  if (!rowEl) return null
  const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT, null)
  return walker.nextNode() ?? rowEl
}
function lastSelectableInside(rowEl) {
  if (!rowEl) return null
  const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT, null)
  let last = null
  let node
  while ((node = walker.nextNode())) last = node
  return last ?? rowEl
}

// Quick check used during mouseup to decide whether a takeover was actually
// useful — if the user's drag collapsed back into one row before release,
// we want to restore editability instead of pinning the outline in
// non-editable mode.
function stillSpansMultipleRows(sel, container) {
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  const startEl = elementOf(range.startContainer)?.closest?.('[data-row-index]')
  const endEl = elementOf(range.endContainer)?.closest?.('[data-row-index]')
  if (!startEl || !endEl) return false
  if (!container.contains(startEl) || !container.contains(endEl)) return false
  return startEl.getAttribute('data-row-index') !== endEl.getAttribute('data-row-index')
}

// --------------------------------------------------------------------------- //
// Editor entrypoint — branches into the outline editor (write) or viewer
// --------------------------------------------------------------------------- //
export function RichTextEditor({ props, content, onChange, readOnly, onInsertWidgetAfter }) {
  const caption = content?.caption ?? ''
  const capPos = captionPositionOf(content)
  const items = useMemo(() => coerceRichTextItems(content), [content])
  const totalChars = useMemo(
    () => items.reduce((sum, it) => sum + (it.text?.length ?? 0), 0),
    [items]
  )
  const min = props.min_length
  const max = props.max_length
  // 개요 번호 켜짐 여부 — per-report content 오버라이드가 템플릿 props 기본값을
  // 이긴다. content 에 키가 없으면(=null) 템플릿 기본값을 따른다. 작성자는
  // 편집 화면의 인라인 토글로 이 위젯만 번호/불릿을 바로 바꿀 수 있다.
  const numbering =
    content?.outline_numbering != null
      ? !!content.outline_numbering
      : !!props.outline_numbering

  function patchItems(nextItems) {
    // ...content 보존 — 안 그러면 본문만 바꿔도 caption_skip_autofill(제목 생략),
    // caption_html/color, note 등 다른 content 필드가 통째로 날아가 제목 생략이
    // 풀리고 자동 채움이 다시 켜진다(버그).
    const merged = { ...(content ?? {}), caption, items: nextItems }
    if (!merged.caption) delete merged.caption
    if (!merged.items || merged.items.length === 0) delete merged.items
    onChange(merged)
  }

  // caption 관련 부분 패치 — items(본문)와 기존 content 필드를 보존하면서 넘어온
  // 키만 갱신한다. captionSkipProps 가 주는 onChangeRich/onChangeSkipAutofill/
  // onChangePosition 이 이 patch 로 흘러, 다른 위젯과 동일하게 헤더에 rich 편집
  // (글자크기·색·서식 버블 메뉴)을 쓸 수 있게 한다. undefined 로 온 키는 제거해
  // content 를 스파스하게 유지(제목 생략/위치 해제 등).
  function patchContent(partial) {
    const merged = { ...(content ?? {}), items, ...partial }
    for (const k of Object.keys(partial)) {
      if (partial[k] === undefined) delete merged[k]
    }
    if (!merged.caption) delete merged.caption
    if (!merged.items || merged.items.length === 0) delete merged.items
    onChange(merged)
  }

  // 인라인 토글 — 번호 ↔ 불릿. 템플릿 기본값과 같아지면 키를 지워 상속으로
  // 되돌린다(content 를 스파스하게 유지).
  function toggleNumbering() {
    const next = !numbering
    patchContent({
      outline_numbering: next === !!props.outline_numbering ? undefined : next,
    })
  }

  // Body-text styling — depth-aware. Each row asks for its class via this
  // function so the bucketed `depth_styles` overlay can win on a single
  // line without affecting the others. Structural marks (prefix glyphs,
  // indent width, relation chips) deliberately stay un-styled.
  //
  // `bodyStyleFor` is the inline-style twin — same merge, emitted as a
  // React style object so the size/weight/family/align reliably win over
  // the row wrapper's `text-sm` and any per-row class the editor sets.
  const bodyClassFor = useCallback(
    (d) => depthBodyClassName(props.text_style, props.depth_styles, d),
    [props.text_style, props.depth_styles],
  )
  const bodyStyleFor = useCallback(
    (d) => depthBodyInlineStyle(props.text_style, props.depth_styles, d),
    [props.text_style, props.depth_styles],
  )
  // depth 별 본문 기본 글자 px — 작성 시 버블 메뉴의 "기본 (N px)" 표기용.
  const baseSizeFor = useCallback(
    (d) => depthBodyBaseSizePx(props.text_style, props.depth_styles, d),
    [props.text_style, props.depth_styles],
  )

  if (readOnly) {
    const hasBody = items.some((it) => (it.text ?? '').trim() !== '')
    return (
      <div className="space-y-2">
        {capPos !== 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
        {hasBody && (
          <OutlineView
            items={items}
            numbering={numbering}
            bodyClassFor={bodyClassFor}
            bodyStyleFor={bodyStyleFor}
          />
        )}
        {capPos === 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
      </div>
    )
  }

  // 인라인 머리표 토글 — 작성자가 이 위젯만 번호(1.1.1) ↔ 불릿(■ – ·)을 바로
  // 전환. 템플릿 props 기본값을 per-report 로 덮어쓴다(toggleNumbering). 헤더
  // 컨트롤 줄(위/아래·제목 생략 옆)에 끼워 같은 줄에 둔다(CaptionInput.extraControls).
  const numberingToggle = (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggleNumbering}
      className="shrink-0 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title="개요 머리표 전환 — 번호(1.1.1) ↔ 불릿(■ – ·)"
    >
      {numbering ? '1.1.1 번호' : '■ 불릿'}
    </button>
  )

  return (
    <div className="space-y-2">
      {capPos !== 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patchContent({ caption: v })}
          placeholder={props.label}
          extraControls={numberingToggle}
          {...captionSkipProps({ content, patch: patchContent })}
        />
      )}
      <OutlineEditor
        items={items}
        numbering={numbering}
        onChange={patchItems}
        placeholder={props.placeholder || '부가 기능 : Tab 상세 들여쓰기 · / 위젯 추가 · @ 보고서·부서 멘션 · # 그림·표 참조'}
        bodyClassFor={bodyClassFor}
        bodyStyleFor={bodyStyleFor}
        baseSizeFor={baseSizeFor}
        onInsertWidgetAfter={onInsertWidgetAfter}
      />
      {(min || max) && (
        <p className="text-[10px] text-muted-foreground text-right">
          {totalChars}자 {min ? `(최소 ${min})` : ''} {max ? `(최대 ${max})` : ''}
        </p>
      )}
      {capPos === 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patchContent({ caption: v })}
          placeholder={props.label}
          extraControls={numberingToggle}
          {...captionSkipProps({ content, patch: patchContent })}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// View mode — read-only structured render
// --------------------------------------------------------------------------- //
function OutlineView({ items, numbering, bodyClassFor, bodyStyleFor }) {
  // 보고서 단위 depth-별 글리프 override. depth 2 글리프는 depth 2+ 모두
  // 에 그대로 적용 (= 깊은 들여쓰기는 depth 2 값을 이어 쓴다).
  const { depthGlyphs } = useReportStyle()
  // 개요 번호가 켜졌으면 글리프 대신 1/1.1/1.1.1 (위젯 내부 계산).
  const numbers = numbering ? computeOutlineNumbers(items) : null
  // 본문 안 @멘션 보고서 링크 클릭 → SPA 이동. 링크는 dangerouslySetInnerHTML
  // 로 그려진 <a data-report-id> 라 React onClick 핸들러를 직접 못 붙이므로,
  // wrapper 에서 위임 처리한다. mention 컨텍스트가 없으면(내보내기/미리보기 등)
  // hard nav 로 폴백. navigate 는 enabled 와 무관하게 항상 제공된다.
  const mention = useReportMention()
  const handleMentionClick = useCallback(
    (e) => {
      const a = e.target?.closest?.(
        'a[data-mention-type], a[data-report-id], a[data-dept-slug]',
      )
      if (!a) return
      // 멘션 anchor 면 항상 기본 동작(href="#" 점프) 차단. 이동 대상이 있을
      // 때만 SPA navigate. (엔티티는 v1 비이동 — 차단만 하고 끝.)
      e.preventDefault()
      const type = a.getAttribute('data-mention-type')
      let to = null
      if (type) {
        // 제네릭 스키마.
        const id = a.getAttribute('data-mention-id')
        const ws = a.getAttribute('data-mention-ws')
        if (type === 'block') {
          // 같은 보고서 내 위젯 참조(그림/표 …). 블록 id 는 페이지-로컬이라
          // (page, id) 둘 다로 특정한다. 호스트가 "스마트" 핸들러를 주면 그쪽
          // (보이면 하이라이트 / 안 보이면 미리보기 팝오버 / 이동+복귀)으로,
          // 없으면 단순 스크롤로 폴백한다. 앵커 엘리먼트를 넘겨 팝오버 위치·
          // 복귀 스크롤 컨테이너 산출에 쓰게 한다.
          const page = a.getAttribute('data-mention-page')
          if (id && page != null) {
            if (mention?.onBlockRefClick) mention.onBlockRefClick(Number(page), id, a)
            else mention?.scrollToBlock?.(Number(page), id)
          }
          return
        }
        if (type === 'report' && id && ws) to = `/w/${ws}/reports/${id}`
        else if (type === 'dept' && id) {
          // 부서 칩: 호스트가 미리보기 팝오버를 주면 그쪽(이동 없이 부서
          // 정보+최근 보고서)으로, 없으면 기존처럼 목록으로 이동.
          if (mention?.onDeptMentionClick) {
            mention.onDeptMentionClick(id, a)
            return
          }
          to = `/w/${id}/reports`
        }
        // type === 'entity' → 이동 없음(표시 전용 칩)
      } else {
        // 구형 스키마(이미 저장된 보고서).
        const reportId = a.getAttribute('data-report-id')
        const ws = a.getAttribute('data-workspace-slug')
        const deptSlug = a.getAttribute('data-dept-slug')
        if (reportId && ws) to = `/w/${ws}/reports/${reportId}`
        else if (deptSlug) {
          if (mention?.onDeptMentionClick) {
            mention.onDeptMentionClick(deptSlug, a)
            return
          }
          to = `/w/${deptSlug}/reports`
        }
      }
      if (!to) return
      // 도착 화면(AppShell)에서 "돌아가기" 알약이 뜨도록 출발 정보를 state 로
      // 실어 보낸다. SPA 이동일 때만 가능 — 하드 폴백은 state 를 못 싣는다.
      if (mention?.navigate)
        mention.navigate(to, {
          state: { fromMention: { fromTitle: mention?.hostReportTitle ?? null } },
        })
      else window.location.assign(to)
    },
    [mention],
  )
  // The wrapper keeps a sensible default (text-sm) — bodyClassFor returns
  // *only* the designer-selected overrides for the row's depth, so an
  // empty style leaves the original rendering untouched. `bodyStyleFor`
  // is the inline-style twin that wins on the same element, fixing the
  // class-cascade race that used to drop the designer's size pick.
  const classFor = bodyClassFor ?? (() => '')
  const styleFor = bodyStyleFor ?? (() => undefined)
  return (
    <div
      className="space-y-0.5 text-sm"
      onClick={handleMentionClick}
      // 뷰 모드 위젯 복사(widgetCopy.js)가 화면에 보이는 그대로 — 글머리
      // 기호(보고서별 글리프 포함) + 줄바꿈 — 를 읽어가는 진입점.
      data-rt-outline
    >
      {items.map((it, i) => {
        const hasContent = (it.text ?? '').trim().length > 0
        if (!hasContent) return null
        const depth = clamp(it.depth ?? 0, 0, MAX_DEPTH)
        // Inline rich text persists as `html`; legacy items have only
        // `text`. sanitizeRowHtml accepts both — for plain rows it falls
        // back to escaping the text inside a `<p>`.
        const safeHtml = relabelBlockMentions(
          sanitizeRowHtml(it.html, it.text),
          mention?.blockIndex,
        )
        const prefixFmt = firstRunFormatting(it.html)
        // Width and padding scale in `em` so the column always matches the
        // prefix's own font-size — a 48px ■ reserves ~48px, a 12px · reserves
        // ~12px. Baseline alignment keeps the glyph sitting on the body
        // text's baseline regardless of which font size is larger.
        const prefixStyle = {
          ...prefixFmt.style,
          minWidth: '1.25em',
          paddingRight: '0.4em',
        }
        return (
          <div
            key={i}
            className="flex items-baseline gap-1"
            style={{ paddingLeft: `${depth * INDENT_PX_PER_DEPTH}px` }}
            data-rt-row
            data-rt-depth={depth}
          >
            <span
              className={`select-none shrink-0 text-center ${
                prefixFmt.colorToken ? '' : 'text-muted-foreground'
              } ${prefixFmt.className}`}
              style={prefixStyle}
              data-rt-prefix
            >
              {numbers
                ? numbers[i]
                : depthGlyphs?.[Math.min(depth, 2)] || DEPTH_PREFIX[depth]}
            </span>
            <RelationChipStatic relation={it.relation} />
            <span
              className={`flex-1 min-w-0 break-words [&_p]:leading-[1.4] ${classFor(depth)}`}
              style={styleFor(depth)}
              dangerouslySetInnerHTML={{ __html: safeHtml }}
              data-rt-body
            />
          </div>
        )
      })}
    </div>
  )
}

function RelationChipStatic({ relation }) {
  const { byKey } = useWidgetRelations()
  if (!relation) return null
  const rel = byKey[relation]
  const label = rel?.name ?? relation
  return (
    <span className="shrink-0 inline-flex items-center bg-amber-500/15 dark:bg-amber-400/15 text-amber-800 dark:text-amber-200 text-[10px] font-semibold tracking-tight px-1.5 py-[3px] leading-none border-l-2 border-amber-500/70 dark:border-amber-400/60 self-center">
      {label}
    </span>
  )
}

// --------------------------------------------------------------------------- //
// Edit mode — outline with Tab depth, auto-prefix, inline relation picker
// --------------------------------------------------------------------------- //
function OutlineEditor({ items, numbering, onChange, placeholder, bodyClassFor, bodyStyleFor, baseSizeFor, onInsertWidgetAfter }) {
  // 슬래시커맨드(①) — 빈(또는 "/…"만 있는) 행에서 / 로 위젯 삽입. 상태는
  // { index, query, rect } | null. rect 는 캐럿 위치(메뉴 앵커).
  const [slash, setSlash] = useState(null)
  // 편집 중에도 글리프 대신 개요 번호를 보여준다(읽기 렌더와 동일한 값).
  const outlineNumbers = numbering ? computeOutlineNumbers(items) : null
  // Each row exposes an imperative handle ({focus, setCaret, getCaret,
  // getTextLength, isAtStart, isAtEnd}) provided by RichTextRowEditor.
  const inputRefs = useRef(new Map())
  // After an edit operation we may want to refocus a particular row at a
  // particular caret position. Recorded here and applied in a layout effect.
  const pendingFocus = useRef(null)
  // The row that currently has focus. Drives the inline relation picker
  // strip below the input — only the focused, indented row shows it.
  const [focusedIndex, setFocusedIndex] = useState(null)

  // 본문 @멘션 — 이 에디터(위젯)에 바인딩된 삽입 함수. @를 친 행에서 open 할
  // 때 이 함수를 페이로드에 실어 보내므로(아래 onMentionOpen), 한 페이지에
  // RichText 가 여러 개여도 항상 올바른 위젯·행에 삽입된다. 최신
  // items/commitChange 는 ref 로 읽어 stale 클로저를 피한다.
  const mention = useReportMention()
  const insertCtxRef = useRef({ items, commitChange })
  insertCtxRef.current = { items, commitChange }
  const insertMentionAtRow = useCallback((rowIndex, payload) => {
    const ed = inputRefs.current.get(rowIndex)
    if (!ed?.insertReportLink) return
    const { items: curItems, commitChange: commit } = insertCtxRef.current
    const curCaret = ed.getCaret?.() ?? 0
    // atCaret = '@' 바로 뒤(0-based). '@'(index atCaret-1)부터 현재 캐럿까지
    // = 타이핑된 "@query" 를 지운다. 최소 1자('@')는 지운다.
    const queryLength = Math.max(1, curCaret - ((payload.atCaret ?? 1) - 1))
    const r = ed.insertReportLink({
      text: payload.text,
      queryLength,
      attrs: payload.attrs ?? {},
    })
    const next = curItems.map((it, i) =>
      i === rowIndex ? { ...it, html: r.html, text: r.text } : it,
    )
    commit(next)
  }, [])

  // Cross-row text selection support. Each row is its own TipTap editor, so
  // browser-native drag selection visually spans multiple rows but no single
  // ProseMirror instance can format across them. We listen on the document
  // for mouseup, read window.getSelection(), and if the range spans 2+ rows
  // within our container we pop a floating toolbar to apply font-size in
  // bulk. Captured selection is held in state so the user can interact with
  // the toolbar without losing context.
  const containerRef = useRef(null)
  const toolbarRef = useRef(null)
  const [crossRowSelection, setCrossRowSelection] = useState(null)
  // Listener effects below are set up once; reads of the live selection go
  // through this ref so the closures don't capture a stale snapshot.
  const crossRowSelectionRef = useRef(null)
  useEffect(() => {
    crossRowSelectionRef.current = crossRowSelection
  }, [crossRowSelection])
  // Latest-callback ref for cross-row Delete. Recreated each render so
  // it sees current `items` / `onChange`; the keydown listener invokes
  // it through this ref.
  const crossRowDeleteRef = useRef(null)
  // 크로스-행 선택 중 붙여넣기. 행들이 non-editable 라 native paste 이벤트가
  // 안 떠서, 문서 keydown 의 Ctrl/Cmd+V 가 clipboard.readText() 로 읽어 이 ref 로
  // 넘긴다(선택 범위를 지우고 그 자리에 붙여넣은 줄들을 삽입).
  const crossRowPasteRef = useRef(null)

  // ── Outline-level undo/redo ───────────────────────────────────────────
  // Per-row TipTap history is disabled (RichTextRowEditor passes
  // `history: false` to StarterKit) so a single Ctrl+Z can roll back
  // changes that no single editor sees: row splits, depth shifts,
  // relation chips, cross-row deletes, etc.
  //
  // Stack shape: each entry is the items array from BEFORE a change.
  // Typing inside one row coalesces — if the previous push happened
  // within COALESCE_MS we skip pushing again, so a flurry of keystrokes
  // collapses into one undo step (which restores the state from before
  // the burst started). Structural ops set `coalesce: false` and always
  // push a fresh entry.
  const HISTORY_LIMIT = 50
  const COALESCE_MS = 500
  const historyRef = useRef({ undo: [], redo: [], lastPush: 0 })
  // Latest-callback refs — the document keydown listener is registered
  // once on mount but needs to see the current `items` / `onChange`.
  const performUndoRef = useRef(null)
  const performRedoRef = useRef(null)

  function commitChange(next, options) {
    const coalesce = options?.coalesce === true
    const now = Date.now()
    const recent = now - historyRef.current.lastPush < COALESCE_MS
    if (!(coalesce && recent)) {
      historyRef.current.undo.push(items)
      if (historyRef.current.undo.length > HISTORY_LIMIT) {
        historyRef.current.undo.shift()
      }
      historyRef.current.redo = []
    }
    historyRef.current.lastPush = now
    onChange(next)
  }

  performUndoRef.current = () => {
    const stacks = historyRef.current
    if (stacks.undo.length === 0) return
    const prev = stacks.undo.pop()
    stacks.redo.push(items)
    if (stacks.redo.length > HISTORY_LIMIT) stacks.redo.shift()
    // Bumping lastPush so the user's next typed character starts a fresh
    // history entry instead of coalescing into the just-restored state.
    stacks.lastPush = Date.now()
    onChange(prev)
  }

  performRedoRef.current = () => {
    const stacks = historyRef.current
    if (stacks.redo.length === 0) return
    const next = stacks.redo.pop()
    stacks.undo.push(items)
    if (stacks.undo.length > HISTORY_LIMIT) stacks.undo.shift()
    stacks.lastPush = Date.now()
    onChange(next)
  }

  const captureCrossRowSelection = useCallback(() => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setCrossRowSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const startEl = elementOf(range.startContainer)?.closest?.('[data-row-index]')
    const endEl = elementOf(range.endContainer)?.closest?.('[data-row-index]')
    const container = containerRef.current
    if (!startEl || !endEl || !container) {
      setCrossRowSelection(null)
      return
    }
    if (!container.contains(startEl) || !container.contains(endEl)) {
      setCrossRowSelection(null)
      return
    }
    // The DOM Range is always in document order, so startEl <= endEl.
    const fromRow = Number(startEl.getAttribute('data-row-index'))
    const toRow = Number(endEl.getAttribute('data-row-index'))
    if (!Number.isFinite(fromRow) || !Number.isFinite(toRow) || fromRow === toRow) {
      // Single-row text selection is handled by the per-row bubble menu.
      setCrossRowSelection(null)
      return
    }
    const fromEd = inputRefs.current.get(fromRow)
    const toEd = inputRefs.current.get(toRow)
    const fromOffset = fromEd?.charOffsetFromDOM?.(range.startContainer, range.startOffset) ?? 0
    const toOffsetRaw = toEd?.charOffsetFromDOM?.(range.endContainer, range.endOffset)
    const toLen = toEd?.getTextLength?.() ?? 0
    const toOffset = toOffsetRaw == null ? toLen : toOffsetRaw
    const rect = range.getBoundingClientRect()
    setCrossRowSelection({
      fromRow,
      fromOffset,
      toRow,
      toOffset,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    })
  }, [])

  // Drag-based cross-row selection.
  //
  // Each row is its own TipTap editor, so native text selection clamps to
  // whichever row the user mousedowned in — drags into a sibling row look
  // like nothing happened. Workaround: once a drag crosses into another
  // row, flip every editor in this outline to non-editable (via TipTap's
  // setEditable) and drive window.getSelection() ourselves with
  // caretRangeFromPoint until mouseup. Non-editable text is still natively
  // selectable so the visible highlight follows the cursor across
  // paragraphs.
  //
  // We deliberately KEEP everyone non-editable past mouseup. Restoring
  // editability immediately triggers ProseMirror's internal selection sync,
  // which collapses the cross-row DOM range back to a single row and wipes
  // the visible highlight. Instead the takenOver state is recorded in
  // a ref and only restored when the user dismisses the toolbar (clear
  // button, click outside, applying a format, or component unmount).
  const tookOverRef = useRef(false)
  const setRowsEditable = useCallback((on) => {
    inputRefs.current.forEach((ed) => ed?.setEditable?.(on))
  }, [])
  const restoreEditable = useCallback(() => {
    if (!tookOverRef.current) return
    setRowsEditable(true)
    tookOverRef.current = false
  }, [setRowsEditable])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let drag = null
    function caretAt(x, y) {
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y)
        if (r) return { node: r.startContainer, offset: r.startOffset }
      }
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y)
        if (p) return { node: p.offsetNode, offset: p.offset }
      }
      return null
    }
    function rowOf(target) {
      return elementOf(target)?.closest?.('[data-row-index]')
    }
    function onMouseDown(e) {
      if (e.button !== 0) return
      const rowEl = rowOf(e.target)
      if (!rowEl) {
        drag = null
        return
      }
      const caret = caretAt(e.clientX, e.clientY)
      drag = {
        startNode: caret?.node ?? null,
        startOffset: caret?.offset ?? 0,
        startRow: Number(rowEl.getAttribute('data-row-index')),
        takenOver: false,
      }
    }
    function onMouseMove(e) {
      if (!drag) return
      if ((e.buttons & 1) === 0) {
        drag = null
        return
      }
      if (!drag.takenOver) {
        const overEl = document.elementFromPoint(e.clientX, e.clientY)
        const overRow = rowOf(overEl)
        const overRowIdx = overRow ? Number(overRow.getAttribute('data-row-index')) : null
        if (overRowIdx === null || overRowIdx === drag.startRow) return
        drag.takenOver = true
        tookOverRef.current = true
        setRowsEditable(false)
      }
      const caret = caretAt(e.clientX, e.clientY)
      if (!caret || !drag.startNode) return
      const sel = window.getSelection()
      if (!sel) return
      try {
        sel.setBaseAndExtent(drag.startNode, drag.startOffset, caret.node, caret.offset)
      } catch (_err) {
        // setBaseAndExtent throws on disconnected nodes — ignore.
      }
      e.preventDefault()
    }
    function onMouseUp(e) {
      drag = null
      // Toolbar clicks must not re-evaluate or restore — that would clear
      // the captured selection mid-pick.
      if (toolbarRef.current?.contains(e.target)) return
      if (!container.contains(e.target)) {
        // Outside our outline entirely → close toolbar AND restore editability
        setCrossRowSelection(null)
        restoreEditable()
        return
      }
      captureCrossRowSelection()
      // Inside the outline but a single-row or collapsed selection means no
      // cross-row pick — restore so the user can keep editing normally.
      if (!tookOverRef.current) return
      // captureCrossRowSelection schedules a state update; we can read the
      // current DOM selection to decide whether to keep takeover live.
      const sel = typeof window !== 'undefined' ? window.getSelection() : null
      const hasCross =
        sel && !sel.isCollapsed && sel.rangeCount > 0 && stillSpansMultipleRows(sel, container)
      if (!hasCross) restoreEditable()
    }
    // Ctrl/Cmd+A: select every row's content in one DOM range rather than
    // letting the focused row's TipTap eat the keystroke and select-all
    // within just that paragraph. Single-row outlines are left alone — the
    // native behavior already covers the whole widget there.
    //
    // Cross-row Delete/Backspace: while a captured cross-row selection is
    // live (from Ctrl+A or a multi-row drag), per-row TipTap editors are
    // non-editable so Delete would otherwise be a no-op. After takeover
    // focus typically leaves the container (contenteditable is removed),
    // so this listener is attached at the document level — the
    // crossRowSelectionRef gate makes sure we only intercept while we
    // genuinely own the selection.
    function onKeyDown(e) {
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        crossRowSelectionRef.current
      ) {
        e.preventDefault()
        e.stopPropagation()
        crossRowDeleteRef.current?.()
        return
      }
      // Outline-level undo/redo. Per-row TipTap history is off, so this
      // listener owns Ctrl+Z. Gated on widget focus (or live cross-row
      // selection, which can sit on body after takeover) so Ctrl+Z
      // elsewhere on the page still routes to whoever owns that focus.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key
        const isZ = k === 'z' || k === 'Z' || k === 'ㅋ'
        const isY = k === 'y' || k === 'Y' || k === 'ㅛ'
        if (isZ || isY) {
          const activeEl = document.activeElement
          const inContainer = activeEl && container.contains(activeEl)
          if (!inContainer && !crossRowSelectionRef.current) return
          e.preventDefault()
          e.stopPropagation()
          if (isY || (isZ && e.shiftKey)) {
            performRedoRef.current?.()
          } else {
            performUndoRef.current?.()
          }
          return
        }
      }
      // 크로스-행 선택 중 붙여넣기(Ctrl/Cmd+V). 행이 non-editable 라 native
      // paste 이벤트가 안 뜨므로 keydown 에서 clipboard 를 직접 읽어 처리한다.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === 'v' || e.key === 'V' || e.key === 'ㅍ') &&
        crossRowSelectionRef.current
      ) {
        e.preventDefault()
        e.stopPropagation()
        if (navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (typeof text === 'string' && text.length > 0) {
                crossRowPasteRef.current?.(text)
              }
            })
            .catch(() => {})
        }
        return
      }
      // Ctrl/Cmd+Shift+Home / End: extend the selection from the current caret
      // to the very start / end of the WHOLE outline. Native handling only
      // reaches the focused row's TipTap editor, so it stops at that single
      // paragraph. Same takeover dance as Ctrl+A — suspend per-row editability
      // and drive the cross-editor DOM range ourselves. Single-row (caret
      // already in the boundary row) is left to native, which covers it.
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'Home' || e.key === 'End')
      ) {
        const active = document.activeElement
        if (!active || !container.contains(active)) return
        const activeRow = elementOf(active)?.closest?.('[data-row-index]')
        if (!activeRow) return
        const rowEls = Array.from(container.querySelectorAll('[data-row-index]'))
        if (rowEls.length < 2) return
        rowEls.sort(
          (a, b) =>
            Number(a.getAttribute('data-row-index')) -
            Number(b.getAttribute('data-row-index')),
        )
        const toEnd = e.key === 'End'
        const targetRowEl = toEnd ? rowEls[rowEls.length - 1] : rowEls[0]
        const curIdx = Number(activeRow.getAttribute('data-row-index'))
        const targetIdx = Number(targetRowEl.getAttribute('data-row-index'))
        // Caret already in the boundary row → native Ctrl+Shift+Home/End
        // selects within that paragraph, which is what we'd want anyway.
        if (curIdx === targetIdx) return
        // Anchor stays at the current selection's fixed end (the caret for a
        // collapsed selection); the focus jumps to the outline boundary.
        const sel = typeof window !== 'undefined' ? window.getSelection() : null
        if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return
        const anchorNode = sel.anchorNode
        const anchorOffset = sel.anchorOffset
        if (!container.contains(elementOf(anchorNode))) return
        const target = toEnd
          ? lastSelectableInside(targetRowEl)
          : firstSelectableInside(targetRowEl)
        if (!target) return
        e.preventDefault()
        e.stopPropagation()
        if (!tookOverRef.current) {
          tookOverRef.current = true
          setRowsEditable(false)
        }
        try {
          const targetOffset = toEnd
            ? target.nodeType === 3
              ? target.nodeValue.length
              : target.childNodes.length
            : 0
          sel.setBaseAndExtent(anchorNode, anchorOffset, target, targetOffset)
        } catch (_err) {
          return
        }
        captureCrossRowSelection()
        return
      }
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A'))) return
      if (e.shiftKey || e.altKey) return
      const active = document.activeElement
      if (!active || !container.contains(active)) return
      const rowEls = Array.from(container.querySelectorAll('[data-row-index]'))
      if (rowEls.length < 2) return
      rowEls.sort(
        (a, b) =>
          Number(a.getAttribute('data-row-index')) -
          Number(b.getAttribute('data-row-index')),
      )
      const firstEnd = firstSelectableInside(rowEls[0])
      const lastEnd = lastSelectableInside(rowEls[rowEls.length - 1])
      if (!firstEnd || !lastEnd) return
      e.preventDefault()
      e.stopPropagation()
      // Same takeover dance as a cross-row drag: TipTap can't model a
      // selection that spans separate editors, so we suspend editability and
      // drive the DOM range ourselves.
      if (!tookOverRef.current) {
        tookOverRef.current = true
        setRowsEditable(false)
      }
      const sel = typeof window !== 'undefined' ? window.getSelection() : null
      if (!sel) return
      try {
        const startOffset = 0
        const endOffset =
          lastEnd.nodeType === 3 ? lastEnd.nodeValue.length : lastEnd.childNodes.length
        sel.setBaseAndExtent(firstEnd, startOffset, lastEnd, endOffset)
      } catch (_err) {
        return
      }
      captureCrossRowSelection()
    }
    container.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      restoreEditable()
    }
  }, [captureCrossRowSelection, restoreEditable, setRowsEditable])

  // Drop stale indices when rows are added/removed/merged.
  useEffect(() => {
    setCrossRowSelection((cur) => {
      if (!cur) return cur
      if (cur.toRow > items.length - 1) return null
      return cur
    })
  }, [items.length])

  // Esc dismisses the cross-row toolbar and restores editability.
  useEffect(() => {
    if (!crossRowSelection) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        setCrossRowSelection(null)
        if (typeof window !== 'undefined') {
          window.getSelection()?.removeAllRanges?.()
        }
        restoreEditable()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [crossRowSelection, restoreEditable])

  function clearCrossRowSelection() {
    setCrossRowSelection(null)
    if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges?.()
    }
    restoreEditable()
  }

  // Apply a per-row TipTap chain to the exact char range covered by the
  // cross-row selection. Each row gets its own `from`/`to` (in ProseMirror
  // positions, 1-based) clipped to the selection bounds, so partial first
  // and last rows aren't styled outside the actual selection. `applyAndCapture`
  // collects each editor's resulting html without firing the per-editor
  // onUpdate, so we can flush all rows in one batched `onChange`.
  function applyCommandToCrossRowRange(commandFor) {
    if (!crossRowSelection) return
    const { fromRow, fromOffset, toRow, toOffset } = crossRowSelection
    const collected = new Map()
    for (let i = fromRow; i <= toRow; i++) {
      const ed = inputRefs.current.get(i)
      if (!ed?.applyAndCapture) continue
      const len = ed.getTextLength?.() ?? 0
      const startChar = i === fromRow ? fromOffset : 0
      const endChar = i === toRow ? toOffset : len
      if (startChar >= endChar) continue
      const result = ed.applyAndCapture((editor) => {
        commandFor(editor, startChar + 1, endChar + 1)
      })
      collected.set(i, result)
    }
    if (collected.size === 0) return
    const next = items.map((it, i) => {
      if (!collected.has(i)) return it
      const r = collected.get(i)
      return { ...it, html: r.html, text: r.text }
    })
    commitChange(next)
  }

  // Read the "currently active" format from the first selected row. Cross-
  // row state is intrinsically ambiguous (rows can disagree), so we treat
  // the first row as the representative — same heuristic the OutlineView
  // uses for prefix styling.
  const crossRowFormat = useMemo(() => {
    if (!crossRowSelection) return null
    const firstHtml = items[crossRowSelection.fromRow]?.html ?? ''
    const fmt = firstRunFormatting(firstHtml)
    return {
      bold:
        rowFirstRunHasTag(firstHtml, 'strong') ||
        rowFirstRunHasTag(firstHtml, 'b') ||
        fmt.className.includes('font-bold'),
      italic:
        rowFirstRunHasTag(firstHtml, 'em') ||
        rowFirstRunHasTag(firstHtml, 'i') ||
        fmt.className.includes('italic'),
      underline:
        rowFirstRunHasTag(firstHtml, 'u') || fmt.className.includes('underline'),
      strike:
        rowFirstRunHasTag(firstHtml, 's') ||
        rowFirstRunHasTag(firstHtml, 'del') ||
        rowFirstRunHasTag(firstHtml, 'strike') ||
        fmt.className.includes('line-through'),
      fontSize: fmt.style?.fontSize ?? '',
      fontFamily: fmt.style?.fontFamily ?? '',
      color: fmt.colorToken ?? null,
    }
  }, [crossRowSelection, items])

  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    const el = inputRefs.current.get(target.index)
    if (!el) return
    el.focus()
    if (typeof target.caret === 'number') {
      el.setCaret(target.caret)
    }
  }, [items])

  const setInputRef = useCallback((index, el) => {
    if (el) inputRefs.current.set(index, el)
    else inputRefs.current.delete(index)
  }, [])

  function replace(nextItems, focus) {
    if (focus) pendingFocus.current = focus
    commitChange(nextItems)
  }

  function updateRowContent(idx, html, text) {
    // Editor-driven updates carry both fields. We persist `html` (canonical)
    // and `text` (used for plain-text logic upstream: prefix detection,
    // char counts, AI prompts).
    const next = items.map((it, i) => (i === idx ? { ...it, html, text } : it))
    // Typing fires onUpdate on every keystroke; coalesce so a typing burst
    // produces a single undo entry (the state from before the burst).
    commitChange(next, { coalesce: true })
    // 슬래시커맨드(①) — 행 끝이 "(줄시작|공백)/…"(공백 없는 질의)면 메뉴를 캐럿
    // 위치에 연다. 줄에 내용이 있어도 새 단어로 "/" 를 시작하면 동작한다(Notion
    // 방식). 방금 친 "/query" 는 항상 caret(=행 끝)에 있으므로 getCaret 에 의존하지
    // 않고 전체 text 끝($)에서 매칭한다 — getCaret 이 재시드 타이밍에 어긋나
    // 내용 있는 줄에서 메뉴가 안 뜨던 문제를 피한다. 미배선(읽기)이면 무시.
    if (!onInsertWidgetAfter) return
    const t = text ?? ''
    const m = /(?:^|\s)\/([^\s/]*)$/.exec(t)
    if (m) {
      const query = m[1]
      const slashStart = t.length - (query.length + 1) // "/" 의 0-based 위치
      setSlash({ index: idx, query, rect: currentCaretRect(), slashStart, caret: t.length })
    } else {
      setSlash((s) => (s && s.index === idx ? null : s))
    }
  }

  // 캐럿(또는 활성 요소) 화면 좌표 — 슬래시 메뉴 앵커. 접힌 셀렉션도 top/left 는
  // 유효하다. 없으면 활성 contenteditable 의 rect 로 폴백.
  function currentCaretRect() {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect()
      if (r && (r.top || r.left || r.bottom)) return r
    }
    return document.activeElement?.getBoundingClientRect?.() ?? null
  }

  function closeSlash() {
    setSlash(null)
  }

  // 슬래시 메뉴에서 위젯 선택. 트리거 행을 정리하고 부모에게 위젯 삽입을 맡긴다.
  //  - 이 긴 글에 다른 내용이 있으면: 트리거 행만 제거하고 아래에 새 위젯 삽입
  //    (빈 줄이 안 남는다).
  //  - 이 긴 글이 사실상 비어 있으면: 트리거 행을 비우고 replaceAnchor 로 요청 —
  //    부모가 이 위젯 자리를 새 위젯으로 대체해 빈 위젯이 남지 않게 한다.
  function chooseSlash(type) {
    const s = slash
    setSlash(null)
    if (!s) {
      onInsertWidgetAfter?.(type)
      return
    }
    const idx = s.index
    // 트리거 행에서 "/query" 조각만 제거하고(나머지 내용·서식은 보존) 나머지
    // 행은 그대로 둔다. ProseMirror 위치는 0-based+1.
    let nextItems = items
    const ed = inputRefs.current.get(idx)
    if (ed?.applyAndCapture && s.caret > s.slashStart) {
      const r = ed.applyAndCapture((editor) => {
        editor.chain().deleteRange({ from: s.slashStart + 1, to: s.caret + 1 }).run()
      })
      nextItems = items.map((it, i) =>
        i === idx ? { ...it, html: r.html, text: r.text } : it,
      )
    }
    // "/query" 제거 후 트리거 행이 비었는지 / 다른 행에 내용이 있는지로 분기.
    const triggerEmpty = (nextItems[idx]?.text ?? '').trim() === ''
    const otherHasContent = nextItems.some(
      (it, i) => i !== idx && (it.text ?? '').trim() !== '',
    )
    if (triggerEmpty && otherHasContent) {
      // 트리거 행만 비고 다른 내용이 있으면 그 빈 행을 아예 제거(빈 줄 안 남김)
      // 하고 아래에 새 위젯을 추가한다.
      commitChange(nextItems.filter((_, i) => i !== idx), { coalesce: false })
      onInsertWidgetAfter?.(type)
    } else if (triggerEmpty) {
      // 위젯 전체가 비었으면 이 자리를 새 위젯으로 대체.
      commitChange(nextItems, { coalesce: false })
      onInsertWidgetAfter?.(type, { replaceAnchor: true })
    } else {
      // 트리거 행에 내용이 남으면(예: "내용 ") 그대로 두고 아래에 추가.
      commitChange(nextItems, { coalesce: false })
      onInsertWidgetAfter?.(type)
    }
  }

  function setDepth(idx, depth) {
    const prev = items[idx - 1]
    const maxAllowed = prev ? Math.min(MAX_DEPTH, prev.depth + 1) : 0
    const clamped = clamp(depth, 0, maxAllowed)
    if (clamped === items[idx].depth) return
    const next = items.map((it, i) => (i === idx ? { ...it, depth: clamped } : it))
    replace(next, { index: idx, caret: inputRefs.current.get(idx)?.getCaret() })
  }

  function setRelation(idx, relation) {
    const next = items.map((it, i) => {
      if (i !== idx) return it
      const copy = { ...it }
      // Pass `null`/`undefined` to clear (X button on chip). Any non-empty
      // slug — including `detail` — is stored explicitly so the chip stays
      // visible. The "no relation" state is the missing field.
      if (relation) copy.relation = relation
      else delete copy.relation
      return copy
    })
    commitChange(next)
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
    commitChange(next)
  }

  function insertAfter(idx, depth) {
    const newItem = normalizeItem({ depth: clamp(depth, 0, MAX_DEPTH), text: '' })
    const next = [...items.slice(0, idx + 1), newItem, ...items.slice(idx + 1)]
    replace(next, { index: idx + 1, caret: 0 })
  }

  /** 여러 줄 텍스트 붙여넣기 → 줄마다 행으로 펼침. 머리표/들여쓰기는 depth 로
   *  변환(parseMarkdownToItems). 현재 행이 비어 있으면 그 자리를 펼친 행들로
   *  치환하고, 내용이 있으면 그 다음에 삽입한다. */
  function pasteRowsAt(idx, text) {
    const parsed = parseMarkdownToItems(text)
    if (parsed.length === 0) return
    const rows = parsed.map((p) => normalizeItem({ depth: p.depth, text: p.text }))
    const cur = items[idx]
    const curEmpty = !(cur?.text ?? '').trim()
    const at = curEmpty ? idx : idx + 1
    const next = curEmpty
      ? [...items.slice(0, idx), ...rows, ...items.slice(idx + 1)]
      : [...items.slice(0, idx + 1), ...rows, ...items.slice(idx + 1)]
    const lastIdx = at + rows.length - 1
    replace(next, {
      index: lastIdx,
      caret: rows[rows.length - 1]?.text?.length ?? 0,
    })
  }

  // Cross-row Delete: collapse a captured cross-row selection down to a
  // single row holding (first row before fromOffset) + (last row after
  // toOffset). Used for Ctrl+A → Delete and for selecting across rows by
  // drag and then pressing Delete/Backspace. Marks on either side are
  // preserved via the row editor's splitAt() (DOMSerializer round-trip).
  //
  // Updates each render so `items` and `onChange` stay current — the
  // keydown listener reaches us through crossRowDeleteRef.
  crossRowDeleteRef.current = () => {
    const sel = crossRowSelectionRef.current
    if (!sel) return
    const { fromRow, fromOffset, toRow, toOffset } = sel
    if (fromRow < 0 || toRow >= items.length || fromRow > toRow) return

    const firstEd = inputRefs.current.get(fromRow)
    const lastEd = inputRefs.current.get(toRow)
    const firstSplit = firstEd?.splitAt?.(fromOffset)
    const lastSplit = lastEd?.splitAt?.(toOffset)

    const beforeHtml = firstSplit?.beforeHtml ?? '<p></p>'
    const beforeText = firstSplit?.beforeText ?? ''
    const afterHtml = lastSplit?.afterHtml ?? '<p></p>'
    const afterText = lastSplit?.afterText ?? ''

    const mergedText = beforeText + afterText
    const mergedHtml =
      mergedText.length === 0
        ? '<p></p>'
        : `<p>${unwrapParagraph(beforeHtml)}${unwrapParagraph(afterHtml)}</p>`

    const baseItem = items[fromRow]
    const mergedItem = { ...baseItem, html: mergedHtml, text: mergedText }

    let next = [
      ...items.slice(0, fromRow),
      mergedItem,
      ...items.slice(toRow + 1),
    ]
    if (next.length === 0) {
      next = [normalizeItem({ depth: 0, text: '' })]
    }

    setCrossRowSelection(null)
    if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges?.()
    }
    restoreEditable()
    pendingFocus.current = { index: fromRow, caret: beforeText.length }
    commitChange(next)
  }

  // 크로스-행 선택 위에 붙여넣기 — 선택 범위(첫 행 fromOffset ~ 끝 행 toOffset)를
  // 지우고 그 자리에 붙여넣은 텍스트를 줄별 행으로 넣는다. 선택 앞/뒤에 남는
  // 잔여 텍스트는 각각 별도 행으로 보존(전체선택이면 잔여가 없어 = 통째 치환).
  crossRowPasteRef.current = (text) => {
    const sel = crossRowSelectionRef.current
    if (!sel) return
    const { fromRow, fromOffset, toRow, toOffset } = sel
    if (fromRow < 0 || toRow >= items.length || fromRow > toRow) return

    const firstSplit = inputRefs.current.get(fromRow)?.splitAt?.(fromOffset)
    const lastSplit = inputRefs.current.get(toRow)?.splitAt?.(toOffset)
    const beforeHtml = firstSplit?.beforeHtml ?? '<p></p>'
    const beforeText = firstSplit?.beforeText ?? ''
    const afterHtml = lastSplit?.afterHtml ?? '<p></p>'
    const afterText = lastSplit?.afterText ?? ''

    const pasted = parseMarkdownToItems(text).map((p) =>
      normalizeItem({ depth: p.depth, text: p.text }),
    )
    const head =
      beforeText.trim().length > 0
        ? [{ ...items[fromRow], html: beforeHtml, text: beforeText }]
        : []
    const tail =
      afterText.trim().length > 0
        ? [
            normalizeItem({
              depth: clamp(items[toRow]?.depth ?? 0, 0, MAX_DEPTH),
              text: afterText,
              html: afterHtml,
            }),
          ]
        : []

    let next = [
      ...items.slice(0, fromRow),
      ...head,
      ...pasted,
      ...tail,
      ...items.slice(toRow + 1),
    ]
    if (next.length === 0) next = [normalizeItem({ depth: 0, text: '' })]

    setCrossRowSelection(null)
    if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges?.()
    }
    restoreEditable()
    const focusIdx = Math.max(
      0,
      fromRow + head.length + pasted.length - 1,
    )
    pendingFocus.current = {
      index: focusIdx,
      caret: pasted[pasted.length - 1]?.text?.length ?? 0,
    }
    commitChange(next)
  }

  // Mid-line Enter: the row editor sliced its current paragraph at the
  // caret. We replace the current row with the `before` half and insert a
  // sibling row carrying the `after` half. Relation is intentionally NOT
  // copied to the new row — the continuation is a fresh fragment, not a
  // new child of the parent.
  function splitRowAt(idx, split) {
    const cur = items[idx]
    const beforeItem = {
      ...cur,
      html: split.beforeHtml || '<p></p>',
      text: split.beforeText ?? '',
    }
    const afterItem = {
      depth: clamp(cur.depth ?? 0, 0, MAX_DEPTH),
      html: split.afterHtml || '<p></p>',
      text: split.afterText ?? '',
    }
    const next = [
      ...items.slice(0, idx),
      beforeItem,
      afterItem,
      ...items.slice(idx + 1),
    ]
    replace(next, { index: idx + 1, caret: 0 })
  }

  function removeAt(idx) {
    if (items.length === 1) {
      // Never go below one row; just clear it.
      replace([normalizeItem({ depth: 0, text: '' })], { index: 0, caret: 0 })
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
    // Concatenate the inner contents so spans/marks on either side
    // survive. Each row's html is normalized to `<p>...</p>`.
    const mergedHtml = `<p>${unwrapParagraph(prev.html)}${unwrapParagraph(cur.html)}</p>`
    const merged = { ...prev, text: mergedText, html: mergedHtml }
    const next = [...items.slice(0, idx - 1), merged, ...items.slice(idx + 1)]
    replace(next, { index: idx - 1, caret: prev.text?.length ?? 0 })
  }

  return (
    <div
      ref={containerRef}
      className="rounded-md border bg-background px-2 pt-2 pb-3 space-y-0.5"
    >
      {items.map((it, i) => (
        <OutlineRow
          key={i}
          index={i}
          item={it}
          numberPrefix={outlineNumbers ? outlineNumbers[i] : undefined}
          isFirst={i === 0}
          parentDepth={items[i - 1]?.depth}
          placeholder={i === 0 && !it.text ? placeholder : ''}
          isFocused={focusedIndex === i}
          setInputRef={setInputRef}
          // @멘션 트리거 — 이 행/에디터에 바인딩된 insert 를 페이로드에 실어
          // 보내 올바른 위젯에만 삽입되게 한다.
          onMentionOpen={({ anchorRect, atCaret, mode }) =>
            mention?.open({
              rowIndex: i,
              anchorRect,
              atCaret,
              mode: mode ?? 'mention',
              insert: (payload) => insertMentionAtRow(i, payload),
            })
          }
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
          onContentChange={(html, text) => updateRowContent(i, html, text)}
          onDepthChange={(d) => setDepth(i, d)}
          onRelationChange={(r) => setRelation(i, r)}
          onPatch={(p) => patchRow(i, p)}
          onNewLine={() => insertAfter(i, it.depth)}
          onSplitLine={(split) => splitRowAt(i, split)}
          // 여러 줄(또는 탭) 텍스트 붙여넣기 → 줄마다 별도 행으로 펼친다.
          // 머리표(□/-/· 등)·들여쓰기는 depth 로 매핑(parseMarkdownToItems).
          onPastePlain={(text) => pasteRowsAt(i, text)}
          onDeleteEmpty={() => removeAt(i)}
          onMergeWithPrev={() => mergeWithPrevious(i)}
          // Delete(앞으로 삭제)로 행 끝에서 다음 행을 끌어올림 = 다음 행을 이
          // 행에 병합(mergeWithPrevious(i+1)). 마지막 행이면 없음.
          onMergeWithNext={
            i < items.length - 1 ? () => mergeWithPrevious(i + 1) : undefined
          }
          onFocusPrev={(caret) => {
            const prev = i - 1
            if (prev < 0) return
            const el = inputRefs.current.get(prev)
            if (!el) return
            el.focus()
            const len = el.getTextLength()
            const target = clamp(caret ?? len, 0, len)
            el.setCaret(target)
          }}
          onFocusNext={(caret) => {
            const nxt = i + 1
            if (nxt >= items.length) return
            const el = inputRefs.current.get(nxt)
            if (!el) return
            el.focus()
            const len = el.getTextLength()
            const target = clamp(caret ?? 0, 0, len)
            el.setCaret(target)
          }}
          bodyClassFor={bodyClassFor}
          bodyStyleFor={bodyStyleFor}
          baseSizeFor={baseSizeFor}
        />
      ))}
      {crossRowSelection && crossRowFormat && (
        <CrossRowToolbarShell
          ref={toolbarRef}
          rect={crossRowSelection.rect}
          format={crossRowFormat}
          defaultSizePx={baseSizeFor ? baseSizeFor(0) : undefined}
          onToggleBold={() => {
            const turnOn = !crossRowFormat.bold
            applyCommandToCrossRowRange((editor, from, to) => {
              const chain = editor.chain().setTextSelection({ from, to })
              if (turnOn) chain.setBold().run()
              else chain.unsetBold().run()
            })
          }}
          onToggleItalic={() => {
            const turnOn = !crossRowFormat.italic
            applyCommandToCrossRowRange((editor, from, to) => {
              const chain = editor.chain().setTextSelection({ from, to })
              if (turnOn) chain.setItalic().run()
              else chain.unsetItalic().run()
            })
          }}
          onToggleUnderline={() => {
            const turnOn = !crossRowFormat.underline
            applyCommandToCrossRowRange((editor, from, to) => {
              const chain = editor.chain().setTextSelection({ from, to })
              if (turnOn) chain.setUnderline().run()
              else chain.unsetUnderline().run()
            })
          }}
          onToggleStrike={() => {
            const turnOn = !crossRowFormat.strike
            applyCommandToCrossRowRange((editor, from, to) => {
              const chain = editor.chain().setTextSelection({ from, to })
              if (turnOn) chain.setStrike().run()
              else chain.unsetStrike().run()
            })
          }}
          onSetFontSize={(v) => {
            applyCommandToCrossRowRange((editor, from, to) => {
              const chain = editor.chain().setTextSelection({ from, to })
              if (v) chain.setFontSize(v).run()
              else chain.unsetFontSize().run()
            })
          }}
          onSetFontFamily={(v) => {
            applyCommandToCrossRowRange((editor, from, to) => {
              const chain = editor.chain().setTextSelection({ from, to })
              if (v) chain.setFontFamily(v).run()
              else chain.unsetFontFamily().run()
            })
          }}
          onSetColor={(c) => {
            applyCommandToCrossRowRange((editor, from, to) => {
              const chain = editor.chain().setTextSelection({ from, to })
              if (c) chain.setColor(c).run()
              else chain.unsetColor().run()
            })
          }}
        />
      )}
      {slash && (
        <SlashMenu
          rect={slash.rect}
          query={slash.query}
          onSelect={chooseSlash}
          onClose={closeSlash}
        />
      )}
    </div>
  )
}

// 슬래시커맨드(①) 위젯 목록 메뉴 — 캐럿 위치에 fixed 로 뜬다. query 로 카탈로그를
// 필터하고 ↑/↓ 이동·Enter/Tab 선택·Esc/바깥클릭 닫힘. 키 이벤트는 capture 로 잡아
// 아래 행(ProseMirror)의 기본 동작(줄바꿈·행 이동)보다 먼저 선점한다.
// 긴 글·제목(Heading) 위젯이 공유한다.
export function SlashMenu({ rect, query, onSelect, onClose }) {
  const { catalog } = useWidgetCatalog()
  const q = (query ?? '').trim().toLowerCase()
  const filtered = useMemo(() => {
    const widgets = catalog?.widgets ?? []
    // 전체 위젯을 다 노출한다 — 메뉴는 max-h + overflow-y-auto 로 스크롤되므로
    // 길이 제한이 불필요하다(예전 slice(0,8)은 나머지 위젯을 가려 버렸다).
    if (!q) return widgets
    return widgets.filter(
      (w) =>
        (w.label ?? '').toLowerCase().includes(q) ||
        (w.type ?? '').toLowerCase().includes(q) ||
        (w.description ?? '').toLowerCase().includes(q),
    )
  }, [catalog, q])
  const [active, setActive] = useState(0)
  useEffect(() => {
    setActive(0)
  }, [q])
  const menuRef = useRef(null)
  const activeItemRef = useRef(null)
  const activeRef = useRef(0)
  activeRef.current = active
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered

  // 방향키로 선택을 옮기면 그 항목이 보이도록 메뉴를 스크롤한다(키보드만으로
  // 전체 목록 탐색 가능). block:'nearest' 라 최소한으로만 스크롤하고, 메뉴가
  // position:fixed 라 페이지 스크롤엔 영향 없다.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    function onKey(e) {
      const list = filteredRef.current
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActive((a) => Math.min(a + 1, Math.max(0, list.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActive((a) => Math.max(a - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const w = list[activeRef.current]
        if (w) onSelect(w.type)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    function onDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [onSelect, onClose])

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const top = Math.max(8, Math.min((rect?.bottom ?? 120) + 4, vh - 264))
  const left = Math.max(8, Math.min(rect?.left ?? 120, vw - 240))

  return createPortal(
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top, left, zIndex: 70 }}
      className="min-w-[13rem] max-h-[15.5rem] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {filtered.length === 0 ? (
        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
          일치하는 위젯이 없습니다.
        </div>
      ) : (
        filtered.map((w, i) => (
          <button
            key={w.type}
            type="button"
            ref={i === active ? activeItemRef : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => onSelect(w.type)}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
              i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
          >
            <span className="truncate">{w.label}</span>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {w.type}
            </span>
          </button>
        ))
      )}
    </div>,
    document.body,
  )
}

function OutlineRow({
  index,
  item,
  numberPrefix,
  isFirst,
  parentDepth,
  placeholder,
  isFocused,
  setInputRef,
  onFocus,
  onBlur,
  onMentionOpen,
  onContentChange,
  onDepthChange,
  onRelationChange,
  onPatch,
  onNewLine,
  onSplitLine,
  onPastePlain,
  onDeleteEmpty,
  onMergeWithPrev,
  onMergeWithNext,
  onFocusPrev,
  onFocusNext,
  bodyClassFor,
  bodyStyleFor,
  baseSizeFor,
}) {
  const depth = clamp(item.depth ?? 0, 0, MAX_DEPTH)
  const showWarning = depth >= WARN_DEPTH
  const relation = item.relation || null
  const rowText = item.text ?? ''
  const rowHtml = item.html ?? ''
  // 보고서 단위 depth-별 글리프 override. depth 2 글리프는 depth 2+ 모두
  // 에 적용 (깊은 들여쓰기까지 이어서 사용).
  const { depthGlyphs } = useReportStyle()
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
  // @멘션(보고서 링크) — Provider 가 있고 편집 가능할 때만 활성. 없으면 null.
  const mention = useReportMention()
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
  //
  // The combo trigger is plain text typed at the very start of a row, so
  // any pre-existing formatting on those characters is from regular
  // typing (no rich formatting on `//token`). Rebuilding html from the
  // surviving plain text is therefore safe and lossless in practice.
  function applyCombo(slug) {
    const m = rowText.match(/^\/\/\S*\s?(.*)$/)
    const rest = m ? m[1] : ''
    onPatch({
      text: rest,
      html: rest ? `<p>${escapeHtml(rest)}</p>` : '<p></p>',
      relation: slug || null,
    })
  }

  // Single entrypoint used by both keyboard (Enter) and mouse (chip click)
  // — when combo is active, the slash text is consumed; otherwise it's a
  // plain relation set.
  function selectRelation(slug) {
    if (comboActive) applyCombo(slug)
    else onRelationChange(slug || null)
  }

  // Called by the rich editor with (html, text) on every change. We run
  // plain-text logic on `text` (prefix detection, combo) and rebuild the
  // html only when a special-case strip happens (rare, intentional).
  function handleContent(html, text) {
    // Legacy text shortcut (`//원인 ` with trailing space) — apply
    // immediately when the full slug or Korean name matches exactly.
    // Combo navigation handles the partial / prefix path; this is for
    // power users who type the whole thing in one go. Atomic patch so
    // text + relation update together.
    const m = text.match(/^\/\/([^\s/]+)\s(.*)$/)
    if (m) {
      const token = m[1]
      const rest = m[2]
      const matched = relations.find((r) => r.slug === token || r.name === token)
      if (matched) {
        onPatch({
          text: rest,
          html: rest ? `<p>${escapeHtml(rest)}</p>` : '<p></p>',
          relation: matched.slug,
        })
        return
      }
    }
    // Auto-prefix conversion: if the text starts with a recognized prefix
    // followed by a space, strip it and remap depth. Only fires when the
    // line is starting fresh (i.e. user is at the start of a new line).
    // Atomic patch (depth + text + html) avoids the same race.
    if (text.length >= 2 && text[1] === ' ') {
      const target = PREFIX_TO_DEPTH[text[0]]
      if (target !== undefined && target !== depth) {
        const stripped = text.slice(2)
        const maxAllowed = isFirst ? 0 : Math.min(MAX_DEPTH, (parentDepth ?? 0) + 1)
        const newDepth = clamp(target, 0, maxAllowed)
        onPatch({
          depth: newDepth,
          text: stripped,
          html: stripped ? `<p>${escapeHtml(stripped)}</p>` : '<p></p>',
        })
        return
      }
    }
    onContentChange(html, text)
  }

  // Returns true when we consumed the key so ProseMirror won't run its
  // own handlers (Enter inserting a paragraph, Tab inserting whitespace,
  // arrow keys moving the caret out, etc.). ctx is provided by
  // RichTextRowEditor and exposes caret/text/atStart/atEnd derived from
  // the editor's selection.
  function handleKeyDown(e, ctx) {
    // @멘션 트리거 — 빈 선택(collapsed)에서 '@' 입력 시 작성 팝업을 연다.
    // '@' 자체는 그대로 타이핑되게 두고(absorb 안 함), 확인 시 OutlineEditor 의
    // inserter 가 '@query' 범위를 지우고 링크를 끼운다. 캐럿 rect 는 live DOM
    // selection 에서 캡처해 팝업 위치 앵커로 쓴다.
    // '#' 은 같은 보고서의 그림/표 등 위젯을 참조하는 트리거(외부 링크 '@'와
    // 별개). 같은 팝업을 mode='block' 으로 열어 블록 피커를 띄운다.
    if (
      (e.key === '@' || e.key === '#') &&
      !e.isComposing &&
      ctx?.isCollapsed &&
      mention?.enabled &&
      onMentionOpen
    ) {
      const triggerMode = e.key === '#' ? 'block' : 'mention'
      let anchorRect = null
      try {
        const sel = window.getSelection?.()
        if (sel && sel.rangeCount > 0) {
          let r = sel.getRangeAt(0).getBoundingClientRect()
          // collapsed range 는 줄 맨 앞 등에서 빈 rect(0,0,0,0)를 돌려줄 때가
          // 있다 — 그러면 팝업이 좌상단에 뜬다. 행 엘리먼트 rect 로 폴백해
          // 커서 주변(해당 행)에 열리게 한다.
          if (!r || (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0)) {
            const el =
              e.target?.closest?.('[data-row-index]') ||
              e.target?.closest?.('[contenteditable]') ||
              e.target
            const fb = el?.getBoundingClientRect?.()
            if (fb) r = fb
          }
          if (r) {
            anchorRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
          }
        }
      } catch {
        /* selection 접근 실패 — 앵커 없이(중앙) 연다 */
      }
      // atCaret = '@' 가 삽입된 뒤의 캐럿 위치(0-based). ctx.caret 은 삽입 전.
      // 이 행/에디터에 바인딩된 open 핸들러(OutlineEditor 제공)로 보내 올바른
      // 위젯에만 삽입되게 한다.
      onMentionOpen({ anchorRect, atCaret: (ctx?.caret ?? 0) + 1, mode: triggerMode })
      return false
    }
    // Combo navigation takes priority over everything else when active.
    if (comboActive && relations.length > 0) {
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowUp' ||
        (e.key === 'Tab' && e.shiftKey)
      ) {
        e.preventDefault()
        setHoverIdx((i) => (i - 1 + relations.length) % relations.length)
        return true
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Tab') {
        e.preventDefault()
        setHoverIdx((i) => (i + 1) % relations.length)
        return true
      }
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        const target = relations[hoverIdx]
        if (target) applyCombo(target.slug)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setComboDismissed(true)
        return true
      }
      // Other keys (letters, backspace) fall through to normal text edit
      // — the filter updates naturally on the next onChange.
    }

    // Ctrl/⌘+Enter 는 "아래에 새 위젯 추가"(②) 전용 — 여기서 처리하지 않고
    // 흘려보내 상위 카드(BlockEditorCard)의 onKeyDown 이 잡게 한다. 안 그러면
    // 현재 위젯에 빈 줄이 하나 추가되면서 새 위젯도 생기는 이중 동작이 된다.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      // Mid-line Enter splits the row at the caret; end-of-line Enter just
      // appends a new sibling. splitAtCaret returns null only when the row
      // editor isn't ready yet — fall back to the append path.
      const split = ctx?.splitAtCaret?.()
      if (split && (split.afterText ?? '').length > 0) {
        onSplitLine?.(split)
      } else {
        onNewLine()
      }
      return true
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      onDepthChange(e.shiftKey ? depth - 1 : depth + 1)
      return true
    }
    if (e.key === 'Backspace' && ctx?.atStart) {
      // Indented row → outdent first. One Backspace = one level up,
      // mirroring how Notion/Workflowy outliners behave. The text on the
      // row stays intact.
      if (depth > 0) {
        e.preventDefault()
        onDepthChange(depth - 1)
        return true
      }
      // depth === 0 (■ row): empty → delete entire row;
      // non-empty → merge into the previous row (preserves text + html).
      if ((ctx?.text ?? '').length === 0) {
        e.preventDefault()
        onDeleteEmpty()
        return true
      }
      e.preventDefault()
      onMergeWithPrev()
      return true
    }
    if (e.key === 'Delete' && ctx?.atEnd && onMergeWithNext) {
      // 행 끝에서 Delete(앞으로 삭제) → 다음 행을 이 행으로 끌어올려 병합
      // (Backspace-at-start 의 대칭). 마지막 행이면 onMergeWithNext 가 없어
      // 기본 동작에 맡긴다.
      e.preventDefault()
      onMergeWithNext()
      return true
    }
    if (e.key === 'ArrowUp' && ctx?.atStart) {
      e.preventDefault()
      onFocusPrev(ctx.caret ?? 0)
      return true
    }
    if (e.key === 'ArrowDown' && ctx?.atEnd) {
      e.preventDefault()
      onFocusNext(ctx.caret ?? 0)
      return true
    }
    return false
  }

  const prefixFmt = firstRunFormatting(rowHtml)
  // Same baseline alignment as OutlineView — the prefix column widens to
  // match its own font size, and `em`-based padding keeps a consistent
  // visual gap whether the first run is 10px or 48px.
  const prefixStyle = {
    ...prefixFmt.style,
    minWidth: '1.25em',
    paddingRight: '0.4em',
  }
  return (
    <div
      data-row-index={index}
      style={{ paddingLeft: `${depth * INDENT_PX_PER_DEPTH}px` }}
    >
      <div className="flex items-baseline gap-1 group">
        <span
          className={`select-none shrink-0 text-center ${
            prefixFmt.colorToken ? '' : 'text-muted-foreground'
          } ${prefixFmt.className}`}
          style={prefixStyle}
        >
          {numberPrefix != null
            ? numberPrefix
            : depthGlyphs?.[Math.min(depth, 2)] || DEPTH_PREFIX[depth]}
        </span>
        <RelationChip relation={relation} onChange={onRelationChange} />
        <div className="flex-1 min-w-0 outline-rich-row">
          <RichTextRowEditor
            ref={(el) => setInputRef(index, el)}
            html={rowHtml}
            placeholder={placeholder}
            defaultSizePx={baseSizeFor ? baseSizeFor(depth) : undefined}
            onChange={handleContent}
            onKeyDown={handleKeyDown}
            onPastePlain={onPastePlain}
            onFocus={onFocus}
            onBlur={onBlur}
            className={`min-w-0 text-sm py-1 [&_p]:leading-[1.4] focus:outline-none ${
              bodyClassFor ? bodyClassFor(depth) : ''
            }`}
            style={bodyStyleFor ? bodyStyleFor(depth) : undefined}
          />
        </div>
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
 * Floating chrome around the shared `RichTextFormatToolbarBody`. Sits above
 * the cross-row selection rect and uses the same className as the per-row
 * bubble menu, so a user dragging within a paragraph vs. across paragraphs
 * sees the identical toolbar.
 *
 * Forward-refs the wrapping div so the OutlineEditor can check
 * `toolbarRef.current.contains(e.target)` from its document mouseup
 * listener and skip evaluating clicks on the toolbar itself.
 */
const CrossRowToolbarShell = forwardRef(function CrossRowToolbarShell(
  {
    rect,
    format,
    onToggleBold,
    onToggleItalic,
    onToggleUnderline,
    onToggleStrike,
    onSetFontSize,
    onSetFontFamily,
    onSetColor,
    defaultSizePx,
  },
  ref,
) {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const top = Math.max(8, rect.top - 40)
  const left = Math.max(8, Math.min(viewportWidth - 320, rect.left))
  // 부모 chain 의 react-grid-layout grid item 이 CSS transform 으로
  // 배치되므로, 같은 트리에 자식으로 둔 position:fixed 는 viewport 가
  // 아닌 그 transformed 박스 기준으로 잡혀 toolbar 가 엉뚱한 위치로
  // 가는 버그가 있었음. document.body 에 portal 로 마운트해서 transformed
  // 조상 chain 을 우회 — 그러면 fixed + viewport 좌표 (getBoundingClientRect)
  // 가 정확히 들어맞는다.
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top, left }}
      className={RICH_TEXT_TOOLBAR_CLASS}
    >
      <RichTextFormatToolbarBody
        state={format}
        defaultSizePx={defaultSizePx}
        actions={{
          toggleBold: onToggleBold,
          toggleItalic: onToggleItalic,
          toggleUnderline: onToggleUnderline,
          toggleStrike: onToggleStrike,
          setFontSize: onSetFontSize,
          setFontFamily: onSetFontFamily,
          setColor: onSetColor,
        }}
      />
    </div>,
    document.body,
  )
})

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
      <span className="text-muted-foreground select-none">상위 문장과의 관계:</span>
      {relations.map((r, i) => {
        const isCurrent = currentRelation === r.slug
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
      className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold tracking-tight px-1.5 py-[3px] leading-none border-l-2 self-center ${
        known
          ? 'bg-amber-500/15 dark:bg-amber-400/15 text-amber-800 dark:text-amber-200 border-amber-500/70 dark:border-amber-400/60'
          : 'bg-muted text-muted-foreground border-muted-foreground/40'
      }`}
      title={known ? rel.description || rel.name : `알 수 없는 관계: ${relation}`}
    >
      {label}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(null)}
        className="opacity-50 hover:opacity-100"
        aria-label="상위 문장과의 관계 제거"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  )
}
