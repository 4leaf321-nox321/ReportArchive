import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import { useCurrentBlockHeadingNumber } from '@/shared/reports/CurrentBlockRefContext'
import {
  HEADING_DEFAULT_PX_BY_LEVEL,
  TextStyleField,
  pruneOverrideKeys,
  textStyleToClassName,
  textStyleToInlineStyle,
  _richIsEmpty,
  _richSeed,
  sanitizeCaptionHtml,
} from './_shared'
import { RichTextRowEditor } from './RichTextRowEditor'
import { SlashMenu } from './RichText'

// --------------------------------------------------------------------------- //
// Effective-value plumbing                                                    //
//                                                                              //
// The heading widget lets the writer tune level / text style / bottom         //
// spacing from an inline popover (no "위젯 편집" modal — heading is in the     //
// INLINE_EDITABLE_WIDGETS set). Per-report values live in `content`; the      //
// renderer reads `content.<field> ?? props.<field> ?? default`. text_style    //
// is merged per-field so the writer can override e.g. font size without        //
// wiping a template-set alignment.                                            //
// --------------------------------------------------------------------------- //

function effectiveLevel(content, props) {
  const c = content?.level
  if (c === 1 || c === 2 || c === 3) return c
  const p = props?.level
  if (p === 1 || p === 2 || p === 3) return p
  return 2
}

function effectiveTextStyle(content, props) {
  const base = props?.text_style ?? {}
  const overlay = content?.text_style ?? {}
  return { ...base, ...overlay }
}

function effectiveMarginBottomPx(content, props) {
  if (Number.isFinite(content?.margin_bottom_px)) return content.margin_bottom_px
  if (Number.isFinite(props?.margin_bottom_px)) return props.margin_bottom_px
  return 0
}

function levelClass(level) {
  if (level === 1) return 'text-2xl font-bold'
  if (level === 3) return 'text-lg font-medium'
  return 'text-xl font-semibold'
}

// --------------------------------------------------------------------------- //
// PropsPanel — template-side designer controls                                //
// --------------------------------------------------------------------------- //
export function HeadingPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">레벨</Label>
        <select
          value={props.level ?? 2}
          onChange={(e) => onChange({ ...props, level: Number(e.target.value) })}
          className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        >
          <option value={1}>제목 1 (가장 큼)</option>
          <option value={2}>제목 2</option>
          <option value={3}>제목 3</option>
        </select>
      </div>
      <div>
        <Label className="text-xs">기본 텍스트 (선택)</Label>
        <Input
          value={props.default_text ?? ''}
          onChange={(e) =>
            onChange({ ...props, default_text: e.target.value || undefined })
          }
          className="mt-1 h-9"
          placeholder="작성 시 미리 채워질 제목"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          제목 텍스트는 보고서 작성 시 입력됩니다. 기본값은 작성자가 수정 가능.
        </p>
      </div>
      <div>
        <Label className="text-xs">아래 여백 (px)</Label>
        <Input
          type="number"
          min={0}
          max={200}
          value={props.margin_bottom_px ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? undefined : Number(e.target.value)
            onChange({ ...props, margin_bottom_px: v })
          }}
          className="mt-1 h-9"
          placeholder="0"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          제목 아래에 추가로 둘 빈 공간. 다음 위젯이 너무 붙어 보일 때 사용.
        </p>
      </div>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => onChange({ ...props, text_style })}
        defaultSizePx={HEADING_DEFAULT_PX_BY_LEVEL[props.level ?? 2]}
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //
export function HeadingPreview({ props }) {
  const text = props.default_text || '(보고서에서 입력)'
  const isPlaceholder = !props.default_text
  const cls = `${levelClass(props.level ?? 2)} ${textStyleToClassName(props.text_style)}`
  const inlineStyle = {
    ...(textStyleToInlineStyle(props.text_style) ?? {}),
    ...(Number.isFinite(props.margin_bottom_px) && props.margin_bottom_px > 0
      ? { marginBottom: `${props.margin_bottom_px}px` }
      : {}),
  }
  return (
    <div
      className={`px-2 ${cls} ${isPlaceholder ? 'text-muted-foreground italic' : ''}`}
      style={inlineStyle}
    >
      {text}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //
export function HeadingEditor({ props, content, onChange, readOnly, onInsertWidgetAfter }) {
  // 절 번호 자동매김이 켜진 보고서에서만 채워짐("1.1.1"). 렌더 부모가 문서순서로
  // 계산해 per-block 으로 내려준다. 편집 모드에선 붙이지 않는다(작성 텍스트와
  // 섞이면 혼란 — 읽기/내보내기 렌더에만 prefix).
  const headingNumber = useCurrentBlockHeadingNumber()
  // 슬래시커맨드(①) — 빈 제목에서 / 로 위젯 삽입. { query, rect } | null.
  const [slash, setSlash] = useState(null)
  const value = content?.text ?? ''
  // dual-field: 평문 text(제목 역할·TOC·export)는 유지하고, 색·서식 일부만 칠한
  // rich 마크업은 text_html 에 둔다(긴 글처럼 per-char). 둘 다 RichTextRowEditor
  // 가 onChange(html, text) 로 동기화.
  const htmlValue = content?.text_html ?? ''
  const hasRich = !_richIsEmpty(htmlValue)
  const level = effectiveLevel(content, props)
  const textStyle = effectiveTextStyle(content, props)
  const marginBottomPx = effectiveMarginBottomPx(content, props)
  // 선택 버블 메뉴의 "기본 (N px)" 표기용 — 현재 글자크기 override 가 있으면 그
  // 값, 없으면 레벨 기본 px. (표 셀과 동일하게 기본 px 을 작성자에게 보여준다.)
  const headingBaseSizePx = Number.isFinite(textStyle?.font_size_px)
    ? textStyle.font_size_px
    : HEADING_DEFAULT_PX_BY_LEVEL[level]
  const cls = `${levelClass(level)} ${textStyleToClassName(textStyle)}`
  const inlineTextStyle = textStyleToInlineStyle(textStyle) ?? {}
  const wrapperStyle =
    marginBottomPx > 0 ? { marginBottom: `${marginBottomPx}px` } : undefined

  function patch(next) {
    const merged = { ...(content ?? {}), text: value, ...next }
    // text is required by the schema even when empty — keep the key.
    if (typeof merged.text !== 'string') merged.text = ''

    // text_style is a sparse per-field override. Prune fields that
    // match the template default; if every field matches, drop the
    // whole key so a later template change still flows through.
    if (merged.text_style != null && typeof merged.text_style === 'object') {
      const tmpl = props?.text_style ?? {}
      const cleaned = {}
      for (const [k, v] of Object.entries(merged.text_style)) {
        if (v === undefined || v === null || v === '') continue
        if (v === tmpl[k]) continue
        cleaned[k] = v
      }
      if (Object.keys(cleaned).length === 0) {
        delete merged.text_style
      } else {
        merged.text_style = cleaned
      }
    }

    // Scalar overrides — strip when matching the template default so a
    // bumped template still propagates to untouched reports.
    pruneOverrideKeys(merged, props, {
      level: 2,
      margin_bottom_px: 0,
    })
    onChange(merged)
  }

  if (readOnly) {
    if (!value && !hasRich) return null
    return (
      <div className={`px-2 py-1 ${cls}`} style={{ ...inlineTextStyle, ...wrapperStyle }}>
        {headingNumber && (
          <span className="mr-2" data-heading-number>
            {headingNumber}
          </span>
        )}
        {hasRich ? (
          <span
            className="[&_p]:m-0 [&_p]:inline"
            dangerouslySetInnerHTML={{ __html: sanitizeCaptionHtml(htmlValue) }}
          />
        ) : (
          value
        )}
      </div>
    )
  }

  return (
    <div
      className="relative group/heading flex items-baseline"
      style={wrapperStyle}
    >
      {/* 절 번호(headingNumber)는 편집 중에도 비편집 prefix 로 함께 보여준다 —
          작성자가 번호 구조를 바로 확인할 수 있게(읽기/내보내기와 동일한 값).
          flex-1 은 outline-rich-row(내가 제어하는 블록)에 둔다 — className 은
          tiptap contenteditable 로 내려가 wrapper 를 늘리지 못하기 때문. */}
      {headingNumber && (
        <span
          className={cn('shrink-0 pl-2 py-1', cls)}
          style={inlineTextStyle}
          contentEditable={false}
          data-heading-number
        >
          {headingNumber}
        </span>
      )}
      {/* 색·서식은 텍스트 선택 시 뜨는 버블 메뉴에서(긴 글과 동일). 평문 text 도
          onChange 가 함께 동기화해 제목 역할을 유지. */}
      <div className="outline-rich-row flex-1 min-w-0">
        <RichTextRowEditor
          html={_richSeed(htmlValue, value)}
          placeholder={props.default_text || '제목 입력 (빈 제목에서 / 로 위젯 추가)'}
          defaultSizePx={headingBaseSizePx}
          onChange={(html, text) => {
            patch({
              text_html: _richIsEmpty(html) ? undefined : html,
              text: text ?? '',
            })
            // 슬래시커맨드(①) — 제목 전체가 "/…"(공백 없음)면 위젯 메뉴를 연다.
            if (!onInsertWidgetAfter) return
            const m = /^\/([^\s/]*)$/.exec(text ?? '')
            if (m) setSlash({ query: m[1], rect: headingCaretRect() })
            else setSlash(null)
          }}
          className={cn(
            'placeholder:text-muted-foreground/50 py-1 pr-9',
            headingNumber ? 'pl-2' : 'px-2',
            cls,
          )}
          style={inlineTextStyle}
        />
      </div>
      <HeadingOptionsPopover
        props={props}
        content={content}
        level={level}
        textStyle={textStyle}
        marginBottomPx={marginBottomPx}
        onPatch={patch}
      />
      {slash && (
        <SlashMenu
          rect={slash.rect}
          query={slash.query}
          onSelect={(type) => {
            setSlash(null)
            // 제목은 그대로 두고(제목 텍스트만 "/…" 지움) 아래에 새 위젯을 추가한다.
            // 제목을 없애 버리면 "변경"처럼 동작해, 새 위젯을 이어 붙이는
            // 본래 의도와 어긋난다. 제목은 남겨 사용자가 제목을 채워 넣게 둔다.
            patch({ text: '', text_html: undefined })
            onInsertWidgetAfter?.(type)
          }}
          onClose={() => setSlash(null)}
        />
      )}
    </div>
  )
}

// 캐럿(또는 활성 요소) 화면 좌표 — 제목 슬래시 메뉴 앵커.
function headingCaretRect() {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect()
    if (r && (r.top || r.left || r.bottom)) return r
  }
  return document.activeElement?.getBoundingClientRect?.() ?? null
}

// --------------------------------------------------------------------------- //
// Inline options popover                                                       //
//                                                                              //
// Gear button positioned at the right edge of the heading input, only           //
// visible on hover/focus to keep the heading visually clean. Clicking opens     //
// a small popover with per-report overrides for level, font, alignment,         //
// and bottom spacing. Each control writes through `onPatch` (the editor's       //
// patch()) so changes flow through the standard content path.                   //
// --------------------------------------------------------------------------- //
function HeadingOptionsPopover({
  props,
  content,
  level,
  textStyle,
  marginBottomPx,
  onPatch,
}) {
  const [open, setOpen] = useState(false)

  const fontSize = Number.isFinite(textStyle.font_size_px)
    ? textStyle.font_size_px
    : HEADING_DEFAULT_PX_BY_LEVEL[level]
  const align = textStyle.align ?? ''
  const weight = textStyle.weight ?? ''
  const family = textStyle.font_family ?? ''

  function patchTextStyle(p) {
    // Build the next text_style by merging the current overlay (from
    // content, not the merged effective object — so we don't promote
    // template defaults into overrides) with the incoming partial.
    const current = (content?.text_style && typeof content.text_style === 'object'
      ? content.text_style
      : {}) ?? {}
    const next = { ...current, ...p }
    // Drop empty / undefined keys so the patch() pruner can decide
    // whether the whole text_style object should disappear.
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === null || v === '') delete next[k]
    }
    onPatch({ text_style: next })
  }

  function resetAll() {
    onPatch({
      level: undefined,
      text_style: {},
      margin_bottom_px: undefined,
    })
    setOpen(false)
  }

  // "Override is active" indicator on the gear so writers can see at
  // a glance that the heading is not on template defaults.
  const hasOverride = Boolean(
    (content?.level && content.level !== props?.level) ||
      (content?.text_style && Object.keys(content.text_style).length > 0) ||
      Number.isFinite(content?.margin_bottom_px),
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Stop the mousedown so clicking the gear doesn't steal
          // focus from the heading input mid-typing.
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2',
            'inline-flex h-6 w-6 items-center justify-center rounded-md',
            'text-muted-foreground hover:bg-muted hover:text-foreground',
            'transition-opacity',
            open || hasOverride
              ? 'opacity-100'
              : 'opacity-0 group-hover/heading:opacity-100 focus:opacity-100',
          )}
          title="제목 옵션"
          aria-label="제목 옵션"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {hasOverride && (
            <span
              className="absolute top-0.5 right-0.5 inline-block h-1.5 w-1.5 rounded-full bg-primary"
              aria-hidden
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-3 space-y-3"
        align="end"
        // Avoid grabbing focus away from the input so the writer can
        // keep typing while the popover is open.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          제목 옵션
        </div>

        {/* Level segmented */}
        <div className="space-y-1">
          <div className="text-xs">레벨</div>
          <div className="inline-flex rounded-md border bg-background overflow-hidden">
            {[1, 2, 3].map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => onPatch({ level: lv })}
                className={cn(
                  'h-7 px-3 text-xs transition-colors',
                  level === lv
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted',
                )}
              >
                H{lv}
              </button>
            ))}
          </div>
        </div>

        {/* Font size + weight */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="text-xs">글자 크기</div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={6}
                max={200}
                value={Number.isFinite(fontSize) ? fontSize : ''}
                onChange={(e) => {
                  if (e.target.value === '') {
                    patchTextStyle({ font_size_px: undefined, size: undefined })
                    return
                  }
                  const n = Number(e.target.value)
                  if (!Number.isFinite(n)) return
                  patchTextStyle({
                    font_size_px: Math.min(Math.max(6, n | 0), 200),
                    size: undefined,
                  })
                }}
                className="h-7 w-full rounded-md border px-1.5 text-center text-xs"
              />
              <span className="text-[10px] text-muted-foreground">px</span>
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs">굵기</div>
            <select
              value={weight}
              onChange={(e) =>
                patchTextStyle({ weight: e.target.value || undefined })
              }
              className="h-7 w-full rounded-md border bg-background px-1.5 text-xs"
            >
              <option value="">기본</option>
              <option value="normal">보통</option>
              <option value="medium">약간 굵게</option>
              <option value="semibold">굵게</option>
              <option value="bold">아주 굵게</option>
            </select>
          </div>
        </div>

        {/* Align + family */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <div className="text-xs">정렬</div>
            <select
              value={align}
              onChange={(e) =>
                patchTextStyle({ align: e.target.value || undefined })
              }
              className="h-7 w-full rounded-md border bg-background px-1.5 text-xs"
            >
              <option value="">기본</option>
              <option value="left">왼쪽</option>
              <option value="center">가운데</option>
              <option value="right">오른쪽</option>
            </select>
          </div>
          <div className="space-y-1">
            <div className="text-xs">글꼴</div>
            <select
              value={family}
              onChange={(e) =>
                patchTextStyle({ font_family: e.target.value || undefined })
              }
              className="h-7 w-full rounded-md border bg-background px-1.5 text-xs"
            >
              <option value="">기본</option>
              <option value="sans">산세리프</option>
              <option value="serif">세리프</option>
              <option value="mono">고정폭</option>
            </select>
          </div>
        </div>

        {/* Bottom margin */}
        <div className="space-y-1">
          <div className="text-xs">아래 여백</div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={120}
              step={4}
              value={marginBottomPx}
              onChange={(e) =>
                onPatch({ margin_bottom_px: Number(e.target.value) })
              }
              className="flex-1"
            />
            <input
              type="number"
              min={0}
              max={200}
              value={marginBottomPx}
              onChange={(e) => {
                if (e.target.value === '') {
                  onPatch({ margin_bottom_px: undefined })
                  return
                }
                const n = Number(e.target.value)
                if (!Number.isFinite(n)) return
                onPatch({
                  margin_bottom_px: Math.min(Math.max(0, n | 0), 200),
                })
              }}
              className="h-7 w-16 rounded-md border px-1.5 text-center text-xs"
            />
            <span className="text-[10px] text-muted-foreground">px</span>
          </div>
          <p className="text-[10px] text-muted-foreground">
            제목 아래에 추가로 둘 빈 공간. 다음 위젯과의 간격이 너무 좁을 때 사용.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[10px] text-muted-foreground">
            {hasOverride ? '템플릿 기본값과 다름' : '템플릿 기본값 사용 중'}
          </span>
          <button
            type="button"
            onClick={resetAll}
            disabled={!hasOverride}
            className={cn(
              'h-7 rounded-md px-2 text-xs transition-colors',
              hasOverride
                ? 'border bg-background hover:bg-muted'
                : 'text-muted-foreground/50',
            )}
          >
            기본값으로 초기화
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
