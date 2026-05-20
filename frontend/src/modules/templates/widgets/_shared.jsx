import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { cn } from '@/shared/lib/utils'

/**
 * Shared editor for the {key, label, type, options?, required?} item shape
 * used by both `key_value.items` and `table.columns`.
 */
const ITEM_TYPES = [
  { value: 'text', label: '텍스트' },
  { value: 'number', label: '숫자' },
  { value: 'integer', label: '정수' },
  { value: 'date', label: '날짜' },
  { value: 'select', label: '선택지' },
]

export function FieldItemListEditor({ items, onChange, addLabel = '항목 추가' }) {
  function update(idx, patch) {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  function remove(idx) {
    onChange(items.filter((_, i) => i !== idx))
  }
  function move(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= items.length) return
    const next = [...items]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    onChange(next)
  }
  function add() {
    onChange([
      ...items,
      { key: nextItemKey(items), label: '', type: 'text', required: false },
    ])
  }

  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <div key={idx} className="rounded-md border p-2 bg-muted/20 space-y-2">
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-3">
              <Label className="text-[10px] uppercase">키</Label>
              <Input
                value={item.key ?? ''}
                onChange={(e) => update(idx, { key: e.target.value.toLowerCase() })}
                className="mt-0.5 h-8 text-xs font-mono"
                placeholder="period"
              />
            </div>
            <div className="col-span-3">
              <Label className="text-[10px] uppercase">라벨</Label>
              <Input
                value={item.label ?? ''}
                onChange={(e) => update(idx, { label: e.target.value })}
                className="mt-0.5 h-8 text-xs"
                placeholder="보고 기간"
              />
            </div>
            <div className="col-span-2">
              <Label className="text-[10px] uppercase">타입</Label>
              <select
                value={item.type ?? 'text'}
                onChange={(e) => update(idx, { type: e.target.value })}
                className="mt-0.5 flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {ITEM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-1 flex items-center justify-center pt-4">
              <label className="flex items-center gap-1 text-[10px]">
                <input
                  type="checkbox"
                  checked={!!item.required}
                  onChange={(e) => update(idx, { required: e.target.checked })}
                />
                필수
              </label>
            </div>
            <div className="col-span-1 flex items-center justify-center pt-4">
              <label
                className="flex items-center gap-1 text-[10px]"
                title="여러 값을 입력할 수 있음 (key_value 전용 — table 열에는 영향 없음)"
              >
                <input
                  type="checkbox"
                  checked={!!item.multi}
                  onChange={(e) => update(idx, { multi: e.target.checked })}
                />
                다중값
              </label>
            </div>
            <div className="col-span-2 flex items-start gap-1 pt-4 justify-end">
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
          </div>

          {item.type === 'select' && (
            <div>
              <Label className="text-[10px] uppercase">선택지 (쉼표 구분)</Label>
              <Input
                value={(item.options ?? []).join(', ')}
                onChange={(e) =>
                  update(idx, {
                    options: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                className="mt-0.5 h-8 text-xs"
                placeholder="옵션1, 옵션2, 옵션3"
              />
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground select-none">
              메타 (선택)
            </summary>
            <div className="mt-1">
              <FieldMetaEditor
                value={item.meta}
                onChange={(meta) => update(idx, { meta })}
              />
            </div>
          </details>
        </div>
      ))}

      <Button variant="outline" size="sm" onClick={add}>
        <Plus className="mr-1 h-3 w-3" />
        {addLabel}
      </Button>
    </div>
  )
}

function nextItemKey(items) {
  let n = 1
  while (items.some((it) => it.key === `field_${n}`)) n += 1
  return `field_${n}`
}

/** Shared label + help row used at the top of every PropsPanel. */
export function LabelField({ label, value, onChange, placeholder, hint }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9"
        placeholder={placeholder}
      />
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Compact section header used in Preview cards. */
export function PreviewLabel({ children, hint }) {
  return (
    <div className="flex items-baseline gap-2">
      <h4 className="text-sm font-medium">{children}</h4>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Ontology / aggregation metadata editors
//
// Meta is purely a hint layer used downstream (entity extraction, cross-
// report aggregation, AI prompt assembly). All fields are optional and
// can be left blank — the validator ignores absent meta entirely. See
// backend `validation.META_SCHEMA` for the authoritative shape.
// --------------------------------------------------------------------------- //

const META_CATEGORIES = [
  { value: '', label: '(없음)' },
  { value: 'metric', label: '지표' },
  { value: 'event', label: '이벤트' },
  { value: 'entity', label: '엔티티' },
  { value: 'note', label: '메모' },
  { value: 'reference', label: '참조' },
  { value: 'attribute', label: '속성' },
]

const META_AGGREGATIONS = [
  { value: '', label: '(없음)' },
  { value: 'sum', label: '합계' },
  { value: 'avg', label: '평균' },
  { value: 'count', label: '개수' },
  { value: 'list', label: '목록' },
  { value: 'max', label: '최대' },
  { value: 'min', label: '최소' },
  { value: 'none', label: 'none' },
]

/** Strip empty values so saved meta stays compact (no `concept: ""`). */
function pruneMeta(meta) {
  if (!meta) return undefined
  const out = {}
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Block-level meta editor — concept + category + aggregation + tags +
 * AI prompt. Renders inline (no card chrome) so it can sit inside the
 * BlockPropsEditor's right panel.
 */
export function BlockMetaEditor({ value, onChange }) {
  const meta = value ?? {}
  function patch(p) {
    onChange(pruneMeta({ ...meta, ...p }))
  }
  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">개념 (concept)</Label>
        <Input
          value={meta.concept ?? ''}
          onChange={(e) => patch({ concept: e.target.value })}
          placeholder="예: MonthlyRevenue, Incident"
          className="mt-1 h-9 text-xs"
        />
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          이 블록이 표현하는 온톨로지 클래스 이름. 같은 concept끼리 집계·연결됨.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">카테고리</Label>
          <select
            value={meta.category ?? ''}
            onChange={(e) => patch({ category: e.target.value || undefined })}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {META_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs">집계 방식</Label>
          <select
            value={meta.aggregatable ?? ''}
            onChange={(e) =>
              patch({ aggregatable: e.target.value || undefined })
            }
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {META_AGGREGATIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label className="text-xs">태그 (쉼표 구분)</Label>
        <Input
          value={(meta.tags ?? []).join(', ')}
          onChange={(e) => {
            const tags = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            patch({ tags: tags.length > 0 ? tags : undefined })
          }}
          placeholder="finance, monthly"
          className="mt-1 h-9 text-xs"
        />
      </div>
      <div>
        <Label className="text-xs">AI 프롬프트 힌트</Label>
        <textarea
          value={meta.ai_prompt ?? ''}
          onChange={(e) => patch({ ai_prompt: e.target.value || undefined })}
          placeholder="이 블록을 AI가 작성할 때 사용할 지시"
          className="mt-1 flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs"
          rows={2}
        />
      </div>
    </div>
  )
}

/**
 * Compact meta editor for an individual field (key_value item, table
 * column, chart series). Smaller surface than block-level meta — only
 * the most useful fields for entity linking.
 */
export function FieldMetaEditor({ value, onChange }) {
  const meta = value ?? {}
  function patch(p) {
    onChange(pruneMeta({ ...meta, ...p }))
  }
  return (
    <div className="space-y-2 p-2 bg-muted/30 rounded">
      <div>
        <Label className="text-[10px] uppercase">개념</Label>
        <Input
          value={meta.concept ?? ''}
          onChange={(e) => patch({ concept: e.target.value })}
          placeholder="예: Team, Person"
          className="mt-0.5 h-7 text-xs"
        />
      </div>
      <label className="flex items-center gap-1 text-[11px]">
        <input
          type="checkbox"
          checked={!!meta.is_entity_id}
          onChange={(e) =>
            patch({ is_entity_id: e.target.checked || undefined })
          }
        />
        엔티티 식별자 (이 값을 entities 테이블에 promote)
      </label>
      {meta.is_entity_id && (
        <div>
          <Label className="text-[10px] uppercase">엔티티 타입</Label>
          <Input
            value={meta.linked_entity_type ?? ''}
            onChange={(e) =>
              patch({ linked_entity_type: e.target.value || undefined })
            }
            placeholder="user, team, project..."
            className="mt-0.5 h-7 text-xs font-mono"
          />
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Text styling — designer-time controls + render-time CSS mapping              //
//                                                                              //
// Every text-bearing widget carries an optional `props.text_style` object       //
// declared in backend/app/widgets/registry.py. Render-time emits two surfaces:  //
//                                                                              //
//   * textStyleToInlineStyle(style) → React style object. Used as `style={...}` //
//     and always wins over any conflicting Tailwind class (heading levels,     //
//     widget body text-sm defaults, etc.). This is the canonical surface for   //
//     all new code.                                                            //
//                                                                              //
//   * textStyleToClassName(style) → Tailwind class string for the legacy       //
//     `size` enum only. Pre-numeric-switch templates still carry e.g.          //
//     `size: 'sm'` and we honor it via class so the report-widget-body 1.3×    //
//     boost continues to apply (matching how those templates rendered before). //
//     weight/family/align deliberately stop emitting classes — the inline      //
//     style path covers them, and emitting both would re-introduce the         //
//     cascade race we are trying to fix.                                       //
//                                                                              //
// CRITICAL: do NOT build class strings via interpolation — Tailwind purges      //
// unseen patterns. Every literal must appear in the source, hence the lookups.  //
// --------------------------------------------------------------------------- //

// Legacy size enum → Tailwind class. Only honored when `font_size_px` is unset.
const _LEGACY_SIZE_CLASS = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
}
// Legacy size enum → px value, used by textStyleToInlineStyle when callers
// fall back through to the legacy field. Numbers match the boosted sizes
// the `.report-widget-body` overrides produced for these enum values, so a
// template saved with `size: 'sm'` renders at the same visual size after
// the switch to inline px even if its widget host loses the boost.
const _LEGACY_SIZE_PX = {
  xs: 12,
  sm: 18,
  base: 21,
  lg: 23,
  xl: 26,
  '2xl': 31,
}
const _FONT_FAMILY_CSS = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
}
const _WEIGHT_NUM = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
}

function _fontSizePx(style) {
  if (!style || typeof style !== 'object') return undefined
  if (Number.isFinite(style.font_size_px)) return style.font_size_px
  return _LEGACY_SIZE_PX[style.size]
}

/**
 * Map a text_style object to a React style object. Wins over conflicting
 * Tailwind classes — this is how Heading (text-xl) + user's pick (e.g. 18px)
 * land on the user's choice instead of whichever class Tailwind emitted last.
 *
 * Returns undefined when nothing is set so JSX can splat it without leaking
 * an empty `style={}` attribute onto the DOM.
 */
export function textStyleToInlineStyle(style) {
  if (!style || typeof style !== 'object') return undefined
  const out = {}
  const px = _fontSizePx(style)
  if (px != null) out.fontSize = `${px}px`
  if (style.font_family && _FONT_FAMILY_CSS[style.font_family]) {
    out.fontFamily = _FONT_FAMILY_CSS[style.font_family]
  }
  if (style.align) out.textAlign = style.align
  if (style.weight && _WEIGHT_NUM[style.weight] != null) {
    out.fontWeight = _WEIGHT_NUM[style.weight]
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Legacy class string — only emits `text-{size}` for the deprecated `size`
 * enum so old templates keep rendering with the report-widget-body boost.
 * New code should prefer `textStyleToInlineStyle`; this helper exists so
 * the existing `className={textClass}` plumbing in each widget keeps
 * working without per-call site refactors.
 */
export function textStyleToClassName(style) {
  if (!style || typeof style !== 'object') return ''
  // If the writer picked a numeric size, drop the legacy class so it can't
  // race with the inline style we also emit. (Old data with no font_size_px
  // still falls through to the class so its boost-era rendering survives.)
  if (Number.isFinite(style.font_size_px)) return ''
  return _LEGACY_SIZE_CLASS[style.size] ?? ''
}

// Curated font sizes matching the RichText inline floating toolbar so
// designers see the same vocabulary at template time and at write time.
// Kept as integers in the schema; the UI presents them in px for clarity.
const _FONT_SIZE_PX_OPTIONS = [
  { value: '', label: '기본' },
  { value: 10, label: '10 px' },
  { value: 11, label: '11 px' },
  { value: 12, label: '12 px' },
  { value: 13, label: '13 px' },
  { value: 14, label: '14 px' },
  { value: 16, label: '16 px' },
  { value: 18, label: '18 px' },
  { value: 20, label: '20 px' },
  { value: 24, label: '24 px' },
  { value: 28, label: '28 px' },
  { value: 32, label: '32 px' },
  { value: 36, label: '36 px' },
  { value: 48, label: '48 px' },
]

/**
 * Body widgets render inside `.report-widget-body`, which scales `text-sm`
 * (the widget body default) to 1.1375rem ≈ 18px. Surfaced as a named
 * constant so every widget's "기본 (18 px)" label points at the same
 * place; bump this and the index.css boost together.
 */
export const DEFAULT_BODY_FONT_PX = 18

/**
 * Heading level → boosted px. Mirrors `.report-widget-body .text-lg/xl/2xl`
 * from index.css so the heading props panel's "기본" hint matches what the
 * report editor actually paints.
 */
export const HEADING_DEFAULT_PX_BY_LEVEL = {
  1: 31, // text-2xl → 1.95rem
  2: 26, // text-xl  → 1.625rem
  3: 23, // text-lg  → 1.4625rem
}

/**
 * Build the font-size dropdown options with the widget's resolved default
 * surfaced inside the empty option's label. Falls back to a plain "기본"
 * row when no default was passed in, so callers that haven't been updated
 * yet still get the previous behavior.
 */
function _fontSizeOptionsWithDefault(defaultPx) {
  if (!Number.isFinite(defaultPx)) return _FONT_SIZE_PX_OPTIONS
  return _FONT_SIZE_PX_OPTIONS.map((o) =>
    o.value === '' ? { value: '', label: `기본 (${defaultPx} px)` } : o,
  )
}
const _FONT_OPTIONS = [
  { value: '', label: '기본' },
  { value: 'sans', label: '산세리프 (Sans)' },
  { value: 'serif', label: '세리프 (Serif)' },
  { value: 'mono', label: '고정폭 (Mono)' },
]
const _ALIGN_OPTIONS = [
  { value: '', label: '기본' },
  { value: 'left', label: '왼쪽' },
  { value: 'center', label: '가운데' },
  { value: 'right', label: '오른쪽' },
  { value: 'justify', label: '양쪽' },
]
const _WEIGHT_OPTIONS = [
  { value: '', label: '기본' },
  { value: 'normal', label: '보통' },
  { value: 'medium', label: '약간 굵게' },
  { value: 'semibold', label: '굵게' },
  { value: 'bold', label: '아주 굵게' },
]

/**
 * Designer-time text-style editor. Renders inside a `<details>` so it
 * stays out of the way for templates that don't customize typography.
 * Sets each field to `undefined` when "기본" is picked so the saved
 * `text_style` object stays sparse (and is pruned to `undefined` entirely
 * when every field is empty).
 */
export function TextStyleField({ value, onChange, defaultSizePx }) {
  const style = value ?? {}
  function patch(p) {
    const merged = { ...style, ...p }
    // Drop empty string / undefined entries so we don't ship noise.
    const cleaned = {}
    for (const [k, v] of Object.entries(merged)) {
      if (v === '' || v === undefined || v === null) continue
      cleaned[k] = v
    }
    onChange(Object.keys(cleaned).length === 0 ? undefined : cleaned)
  }
  // Preview reflects the current selection (inline style + legacy class) so
  // the designer sees the actual visual without saving and switching to the
  // report editor.
  const previewClass = textStyleToClassName(style) || 'text-sm text-muted-foreground'
  const previewStyle = textStyleToInlineStyle(style)
  // Legacy templates may carry only `size` (enum). Surface its mapped px
  // value in the dropdown so the designer sees the current setting; the
  // first edit upgrades the row to `font_size_px` and drops the legacy key.
  const displayFontSize = style.font_size_px ?? _LEGACY_SIZE_PX[style.size] ?? ''

  return (
    <details className="rounded-md border bg-muted/10 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium select-none">
        텍스트 스타일
        {Object.keys(style).length > 0 && (
          <span className="ml-2 text-[10px] text-muted-foreground">
            ({Object.keys(style).length}개 항목 설정됨)
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <_TextStyleSelect
            label="글자 크기"
            value={displayFontSize === '' ? '' : String(displayFontSize)}
            options={_fontSizeOptionsWithDefault(defaultSizePx)}
            onChange={(v) =>
              patch({
                font_size_px: v === '' ? '' : Number(v),
                // Clear the legacy enum on any edit so we never carry both
                // and so old back-compat data graduates to the numeric field.
                size: '',
              })
            }
          />
          <_TextStyleSelect
            label="글꼴"
            value={style.font_family ?? ''}
            options={_FONT_OPTIONS}
            onChange={(v) => patch({ font_family: v })}
          />
          <_TextStyleSelect
            label="정렬"
            value={style.align ?? ''}
            options={_ALIGN_OPTIONS}
            onChange={(v) => patch({ align: v })}
          />
          <_TextStyleSelect
            label="굵기"
            value={style.weight ?? ''}
            options={_WEIGHT_OPTIONS}
            onChange={(v) => patch({ weight: v })}
          />
        </div>
        <div className="rounded border bg-background p-2">
          <div className="text-[10px] uppercase text-muted-foreground mb-1">
            미리보기
          </div>
          <div className={previewClass} style={previewStyle}>
            가나다 ABC 123 — 텍스트 스타일 미리보기
          </div>
        </div>
      </div>
    </details>
  )
}

/**
 * Designer-time editor for per-depth text style overrides used by the
 * RichText widget. Exposes only the three buckets actually rendered with
 * distinct prefix glyphs (□ / – / ·); depths 3+ inherit the depth-2 style.
 *
 * Stored shape: `{ "0"?: TextStyle, "1"?: TextStyle, "2"?: TextStyle }`.
 * Each depth value is itself a sparse object — empty fields fall through
 * to the base `text_style`. When every depth has every field empty, we
 * call onChange(undefined) so the parent props stay sparse.
 *
 * NOTE: `value` here is the `depth_styles` map, not a flat TextStyle.
 */
const _DEPTH_LABELS = [
  { key: '0', glyph: '□', name: '대표 문장 (depth 0)' },
  { key: '1', glyph: '–', name: '상세 (depth 1)' },
  { key: '2', glyph: '·', name: '깊은 설명 (depth 2+)' },
]

export function DepthStyleField({ value, onChange, baseSizePx }) {
  const map = value ?? {}
  const setCount = _DEPTH_LABELS.reduce(
    (n, d) => n + (map[d.key] && Object.keys(map[d.key]).length > 0 ? 1 : 0),
    0,
  )

  function patchDepth(depthKey, style) {
    const next = { ...map }
    if (!style || Object.keys(style).length === 0) {
      delete next[depthKey]
    } else {
      next[depthKey] = style
    }
    onChange(Object.keys(next).length === 0 ? undefined : next)
  }

  return (
    <details className="rounded-md border bg-muted/10 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium select-none">
        깊이별 스타일
        {setCount > 0 && (
          <span className="ml-2 text-[10px] text-muted-foreground">
            ({setCount}개 깊이 설정됨)
          </span>
        )}
      </summary>
      <p className="mt-1 text-[10px] text-muted-foreground">
        깊이별로 텍스트 스타일을 따로 지정합니다. 비어 있는 항목은 위의 기본
        텍스트 스타일을 따릅니다. depth 3 이상은 depth 2의 스타일을 상속.
      </p>
      <div className="mt-2 space-y-2">
        {_DEPTH_LABELS.map((d) => (
          <_DepthRow
            key={d.key}
            depthKey={d.key}
            defaultSizePx={baseSizePx}
            glyph={d.glyph}
            name={d.name}
            style={map[d.key]}
            onChange={(s) => patchDepth(d.key, s)}
          />
        ))}
      </div>
    </details>
  )
}

function _DepthRow({ depthKey, glyph, name, style, onChange, defaultSizePx }) {
  const cur = style ?? {}
  function patch(p) {
    const merged = { ...cur, ...p }
    const cleaned = {}
    for (const [k, v] of Object.entries(merged)) {
      if (v === '' || v === undefined || v === null) continue
      cleaned[k] = v
    }
    onChange(Object.keys(cleaned).length === 0 ? undefined : cleaned)
  }
  const previewClass = textStyleToClassName(cur) || 'text-sm text-muted-foreground'
  const previewStyle = textStyleToInlineStyle(cur)
  const displayFontSize = cur.font_size_px ?? _LEGACY_SIZE_PX[cur.size] ?? ''
  return (
    <div className="rounded border bg-background p-2 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm w-4 text-center text-muted-foreground">
          {glyph}
        </span>
        <span className="text-xs text-muted-foreground">{name}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <_TextStyleSelect
          label="글자 크기"
          value={displayFontSize === '' ? '' : String(displayFontSize)}
          options={_fontSizeOptionsWithDefault(defaultSizePx)}
          onChange={(v) =>
            patch({
              font_size_px: v === '' ? '' : Number(v),
              size: '',
            })
          }
        />
        <_TextStyleSelect
          label="굵기"
          value={cur.weight ?? ''}
          options={_WEIGHT_OPTIONS}
          onChange={(v) => patch({ weight: v })}
        />
        <_TextStyleSelect
          label="글꼴"
          value={cur.font_family ?? ''}
          options={_FONT_OPTIONS}
          onChange={(v) => patch({ font_family: v })}
        />
        <_TextStyleSelect
          label="정렬"
          value={cur.align ?? ''}
          options={_ALIGN_OPTIONS}
          onChange={(v) => patch({ align: v })}
        />
      </div>
      <div className={`px-1 ${previewClass}`} style={previewStyle}>
        {glyph} 미리보기 — 가나다 ABC
      </div>
    </div>
  )
}

/**
 * Compute the effective class string for a given depth, layering:
 *   1. base `text_style` (always applied)
 *   2. `depth_styles[min(depth, 2)]` overlay (overrides base on shared keys)
 *
 * Tailwind purge concern: every class string emitted here goes through
 * `textStyleToClassName`, which reads from literal lookup tables. So all
 * classes appear in source and survive the purge.
 */
export function depthBodyClassName(textStyle, depthStyles, depth) {
  return textStyleToClassName(_mergedDepthStyle(textStyle, depthStyles, depth))
}

/**
 * Inline-style analog of `depthBodyClassName` — the per-depth merge then
 * fed through `textStyleToInlineStyle` so the resulting CSS overrides any
 * conflicting class on the same element.
 */
export function depthBodyInlineStyle(textStyle, depthStyles, depth) {
  return textStyleToInlineStyle(_mergedDepthStyle(textStyle, depthStyles, depth))
}

function _mergedDepthStyle(textStyle, depthStyles, depth) {
  // Bucket: 0, 1, or 2 — depths 3+ collapse into "2".
  const bucket = String(Math.min(Math.max(depth | 0, 0), 2))
  const overlay = depthStyles?.[bucket]
  // If the bucket has no override, the depth inherits the base unchanged.
  // Buckets are independent — leaving "1" empty doesn't pull in "0".
  return { ...(textStyle ?? {}), ...(overlay ?? {}) }
}

function _TextStyleSelect({ label, value, options, onChange }) {
  return (
    <div>
      <Label className="text-[10px] uppercase">{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Shared block-level caption input used by every non-heading widget's
 * Editor. Renders inline as a heading-styled text field. When set, the
 * caption replaces the block's external `<h2>` title in the report.
 *
 * Template hint behavior — `placeholder` is the value the template author
 * configured (the widget's `label` prop). When it is non-empty:
 *   - the visible hint becomes `미입력시 "X"이(가) 입력됩니다` so writers know
 *     the field auto-fills
 *   - blurring the input while the value is empty saves the hint as the
 *     caption verbatim (so view-mode renders it as a real heading)
 * Writers can opt out via the inline "제목 생략" toggle — that flips
 * `skipAutofill` on, clears the caption, and changes the placeholder to
 * "(제목 없이 표시)" so they can leave the block headerless on purpose.
 * The toggle is driven by `onChangeSkipAutofill`; widgets that don't pass
 * one stay on the legacy always-autofill behavior.
 *
 * When the template hint is empty we fall back to the legacy "제목 (선택)"
 * placeholder and no auto-fill happens, matching the prior behavior.
 *
 * When `readOnly` is true:
 *   - empty value → renders nothing (no placeholder leakage in view mode)
 *   - non-empty value → renders as static styled text
 */
/**
 * Helper that returns the props needed to wire CaptionInput's skip
 * toggle into a widget's existing `patch(next)` helper. Each widget
 * needs to make sure its `patch` round-trips `caption_skip_autofill`
 * (typically by spreading `content` into the merged object) so the
 * flag survives across unrelated edits.
 */
export function captionSkipProps({ content, patch }) {
  return {
    skipAutofill: content?.caption_skip_autofill === true,
    onChangeSkipAutofill: (skip) => {
      // Atomic patch: clear caption + set flag (or unset the flag) in
      // one call so the two field updates can't race on a stale
      // content snapshot inside a click handler.
      if (skip) {
        patch({ caption: '', caption_skip_autofill: true })
      } else {
        patch({ caption_skip_autofill: undefined })
      }
    },
  }
}

export function CaptionInput({
  value,
  onChange,
  placeholder,
  readOnly,
  skipAutofill,
  onChangeSkipAutofill,
}) {
  if (readOnly) {
    if (!value) return null
    return (
      <div className="text-base font-semibold px-2 py-1">{value}</div>
    )
  }
  const hint = typeof placeholder === 'string' ? placeholder.trim() : ''
  const hasHint = hint.length > 0
  const skip = !!skipAutofill
  const displayPlaceholder = skip
    ? '(제목 없이 표시)'
    : hasHint
      ? `미입력시 "${hint}"이(가) 입력됩니다`
      : '제목 (선택)'
  function handleBlur() {
    if (skip) return
    if (!hasHint) return
    if ((value ?? '').trim().length === 0) onChange(hint)
  }
  // Single atomic toggle callback — widgets clear the caption AND flip
  // the flag in the same onChange call so the two field updates can't
  // race on a stale content snapshot. Hidden when the widget doesn't
  // wire the callback (no way to persist the flag) or when there's no
  // template hint to autofill from (button would be a no-op).
  const showSkipToggle = Boolean(onChangeSkipAutofill) && hasHint
  function toggleSkip() {
    if (!onChangeSkipAutofill) return
    onChangeSkipAutofill(!skip)
  }
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={displayPlaceholder}
        className="flex-1 min-w-0 bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/50 text-base font-semibold px-2 py-1"
      />
      {showSkipToggle && (
        <button
          type="button"
          onClick={toggleSkip}
          // Stop bubbling so the click doesn't re-activate the block
          // and steal focus back to the input the moment we toggle.
          onMouseDown={(e) => e.stopPropagation()}
          title={
            skip
              ? '자동 채움을 다시 켭니다 (빈 칸이면 템플릿 라벨로 채움)'
              : '템플릿 라벨 자동 채움을 끄고 제목을 비워둡니다'
          }
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
            skip
              ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {skip ? '자동 채움 켜기' : '제목 생략'}
        </button>
      )}
    </div>
  )
}
