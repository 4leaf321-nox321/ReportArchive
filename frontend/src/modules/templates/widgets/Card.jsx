// 카드(Card) 위젯 — 한 장 요약 블록. 색 악센트 + (선택)아이콘 + 제목 + 본문.
//
// KPI 타일·콜아웃 밴드·상태 카드는 **별도 타입이 아니라** variant/선택필드의
// 조합으로 파생한다(카드위젯_설계.md §3):
//   개념 타일 = icon+title+body · KPI = stat · 밴드 = variant:'banner' · 상태 = badge
//
// 색은 hex 가 아니라 rt-c-* 토큰으로만 저장한다. 화면은 클래스(rt-bg-*)로 테마에
// 적응하고, export(PPTX/DOCX)는 같은 토큰을 hex 로 굽는다(bandBgHex/highlightHex).
// 제목 배경 밴드(Heading.jsx)가 쓰던 배관을 그대로 재사용한다.
import { useRef } from 'react'
import { Palette, X } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import {
  ColorSwatchPicker,
  bandBgHex,
  bandTextHex,
  bgTokenClass,
  normalizeToken,
} from '@/shared/text-color'
import {
  CaptionInput,
  NoteInput,
  EditorOptionBar,
  EditorOptionSegmented,
  EditorOptionToggle,
  captionPositionOf,
  captionSkipProps,
  _richIsEmpty,
} from './_shared'
import { RichTextRowEditor } from './RichTextRowEditor'
import { CARD_ICON_NAMES, cardIconComponent } from './cardIcons'

const VARIANTS = [
  { value: 'soft', label: '연한 배경' },
  { value: 'outline', label: '테두리' },
  { value: 'filled', label: '진한 배경' },
  { value: 'banner', label: '띠' },
]

const BADGE_TONES = [
  { value: 'success', label: '완료', token: 'green' },
  { value: 'info', label: '정보', token: 'blue' },
  { value: 'warn', label: '주의', token: 'amber' },
  { value: 'neutral', label: '보통', token: 'gray' },
]

const DEFAULT_ACCENT = 'slate'

// --------------------------------------------------------------------------- //
// Effective values — content(per-report) → props(템플릿 기본) → 하드 기본값      //
// --------------------------------------------------------------------------- //

function effectiveVariant(content, props) {
  const ok = (v) => VARIANTS.some((x) => x.value === v)
  if (ok(content?.variant)) return content.variant
  if (ok(props?.default_variant)) return props.default_variant
  return 'soft'
}

function effectiveAccent(content, props) {
  return (
    normalizeToken(content?.accent) ??
    normalizeToken(props?.default_accent) ??
    DEFAULT_ACCENT
  )
}

/**
 * variant + accent → 카드 겉면 스타일.
 *
 * soft/outline 은 클래스(rt-bg-*)로 테마 적응시키고, filled/banner 는 밴드와 같은
 * 솔리드 hex + 자동 대비 글자색을 쓴다(연한 틴트로는 "진한 배경"이 안 되므로).
 * 반환: { className, style } — 둘 다 카드 루트에 적용.
 */
function surfaceOf(variant, accent) {
  const hex = bandBgHex(accent)
  if (variant === 'filled' || variant === 'banner') {
    const fg = bandTextHex(accent)
    return {
      className: variant === 'banner' ? 'rounded-md' : 'rounded-lg',
      style: hex
        ? { backgroundColor: `#${hex}`, color: `#${fg}` }
        : undefined,
    }
  }
  if (variant === 'outline') {
    return {
      className: 'rounded-lg border-2',
      // 테두리 색만 악센트 — 배경은 투명(카드 뒤 지면이 비친다).
      style: hex ? { borderColor: `#${hex}` } : undefined,
    }
  }
  // soft — 연한 틴트(color-mix 16%)라 라이트/다크 모두에서 글자가 읽힌다.
  return { className: cn('rounded-lg border', bgTokenClass(accent)), style: undefined }
}

/** 진한 배경(filled/banner) 위에서는 보조 텍스트도 흰/검을 상속받아야 한다. */
function isSolid(variant) {
  return variant === 'filled' || variant === 'banner'
}

// --------------------------------------------------------------------------- //
// PropsPanel — 템플릿 설계자용                                                  //
// --------------------------------------------------------------------------- //

export function CardPropsPanel({ props, onChange }) {
  const set = (patch) => onChange({ ...props, ...patch })
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">라벨</Label>
        <Input
          value={props.label ?? ''}
          onChange={(e) => set({ label: e.target.value })}
          placeholder="카드"
          className="mt-1"
        />
      </div>
      <div>
        <Label className="text-xs">기본 표현형</Label>
        <select
          value={props.default_variant ?? 'soft'}
          onChange={(e) => set({ default_variant: e.target.value })}
          className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        >
          {VARIANTS.map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-muted-foreground">
          작성자가 보고서마다 바꿀 수 있습니다. 여기서는 시작값만 정합니다.
        </p>
      </div>
      <div>
        <Label className="text-xs">기본 색</Label>
        <div className="mt-1">
          <ColorSwatchPicker
            value={props.default_accent ?? DEFAULT_ACCENT}
            onChange={(token) => set({ default_accent: token ?? undefined })}
          />
        </div>
      </div>
      <div className="space-y-2 border-t pt-3">
        <ToggleRow
          label="아이콘 사용"
          hint="끄면 작성 화면에 아이콘 선택이 안 보입니다."
          value={props.icon_enabled !== false}
          onChange={(v) => set({ icon_enabled: v ? undefined : false })}
        />
        <ToggleRow
          label="KPI 숫자 사용"
          hint="큰 숫자 + 단위(지표 타일)를 쓸 수 있게 합니다."
          value={props.allow_stat !== false}
          onChange={(v) => set({ allow_stat: v ? undefined : false })}
        />
      </div>
    </div>
  )
}

function ToggleRow({ label, hint, value, onChange }) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="text-xs font-medium">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

// --------------------------------------------------------------------------- //
// Preview — 템플릿 캔버스의 자리표시                                            //
// --------------------------------------------------------------------------- //

export function CardPreview({ props }) {
  const accent = normalizeToken(props?.default_accent) ?? DEFAULT_ACCENT
  const variant = props?.default_variant ?? 'soft'
  const { className, style } = surfaceOf(variant, accent)
  return (
    <div className={cn('p-3', className)} style={style}>
      <div className="text-sm font-semibold">{props?.label || '카드'}</div>
      <div className={cn('mt-1 text-xs', !isSolid(variant) && 'text-muted-foreground')}>
        제목과 내용을 작성 화면에서 입력합니다.
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor — 작성 화면(읽기 모드 렌더도 이 컴포넌트가 겸한다)                      //
// --------------------------------------------------------------------------- //

export function CardEditor({ props, content, onChange, readOnly }) {
  const patch = (p) => onChange({ ...(content ?? {}), ...p })

  const variant = effectiveVariant(content, props)
  const accent = effectiveAccent(content, props)
  const solid = isSolid(variant)
  const { className: surfaceClass, style: surfaceStyle } = surfaceOf(variant, accent)

  const capPos = captionPositionOf(content)
  const iconEnabled = props?.icon_enabled !== false
  const statAllowed = props?.allow_stat !== false

  const icon = iconEnabled ? content?.icon : undefined
  const IconCmp = cardIconComponent(icon)
  const title = content?.title ?? ''
  const eyebrow = content?.eyebrow ?? ''
  const footnote = content?.footnote ?? ''
  const badge = content?.badge
  const stat = statAllowed ? content?.stat : undefined
  const items = Array.isArray(content?.body?.items) ? content.body.items : []

  // 악센트 hex — 진한 배경이 아닐 때 아이콘/eyebrow 를 악센트 색으로 칠한다.
  const accentHex = bandBgHex(accent)
  const accentColor = solid ? undefined : (accentHex ? `#${accentHex}` : undefined)

  const captionEl = (
    <CaptionInput
      value={content?.caption ?? ''}
      onChange={(v) => patch({ caption: v })}
      placeholder="카드 제목(선택)"
      readOnly={readOnly}
      color={content?.caption_color}
      {...captionSkipProps({ content, patch })}
    />
  )

  return (
    <div className="flex h-full flex-col">
      {capPos === 'above' && captionEl}

      <div
        className={cn(
          'min-h-0 flex-1',
          surfaceClass,
          variant === 'banner' ? 'px-4 py-2.5' : 'p-4',
        )}
        style={surfaceStyle}
      >
        {/* 머리줄 — eyebrow / 배지 */}
        {(eyebrow || badge?.text || (!readOnly && !solid)) && (
          <div className="mb-1 flex items-start justify-between gap-2">
            {readOnly ? (
              eyebrow ? (
                <span
                  className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: accentColor }}
                >
                  {eyebrow}
                </span>
              ) : <span />
            ) : (
              <input
                value={eyebrow}
                onChange={(e) => patch({ eyebrow: e.target.value || undefined })}
                placeholder="①"
                className="w-24 bg-transparent text-[11px] font-semibold uppercase tracking-wide outline-none placeholder:font-normal placeholder:normal-case placeholder:text-muted-foreground/60"
                style={{ color: accentColor }}
              />
            )}
            {badge?.text && <Badge badge={badge} solid={solid} />}
          </div>
        )}

        {/* 제목줄 — 아이콘 + 제목 */}
        <div className="flex items-center gap-2">
          {IconCmp && (
            // data-card-icon — PPTX 네이티브 변환이 이 SVG 를 찾아 PNG 로 굽는다
            // (exportPptxCard.js). 셀렉터를 바꾸려면 그쪽도 함께 고칠 것.
            <span data-card-icon className="shrink-0 leading-none">
              <IconCmp
                className="h-5 w-5"
                style={{ color: accentColor }}
                aria-hidden="true"
              />
            </span>
          )}
          {readOnly ? (
            title && <h3 className="text-base font-semibold leading-tight">{title}</h3>
          ) : (
            <input
              value={title}
              onChange={(e) => patch({ title: e.target.value || undefined })}
              placeholder="제목"
              className="min-w-0 flex-1 bg-transparent text-base font-semibold leading-tight outline-none placeholder:font-normal placeholder:text-muted-foreground/60"
            />
          )}
        </div>

        {/* KPI 숫자 */}
        {stat?.value != null && stat.value !== '' && (
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-3xl font-bold leading-none tabular-nums">
              {stat.value}
            </span>
            {stat.unit && <span className="text-sm opacity-70">{stat.unit}</span>}
          </div>
        )}

        {/* 본문 */}
        <CardBody
          items={items}
          readOnly={readOnly}
          solid={solid}
          onChange={(next) =>
            patch({ body: next.length ? { items: next } : undefined })
          }
        />

        {footnote && (
          <p className={cn('mt-2 text-[11px]', !solid && 'text-muted-foreground', solid && 'opacity-75')}>
            {footnote}
          </p>
        )}
      </div>

      {capPos === 'below' && captionEl}

      <NoteInput
        value={content?.note ?? ''}
        onChange={(v) => patch({ note: v })}
        readOnly={readOnly}
        color={content?.note_color}
        html={content?.note_html}
        onChangeRich={(html, text) =>
          patch({
            note_html: _richIsEmpty(html) ? undefined : html,
            note: text?.trim() ? text : undefined,
          })
        }
      />

      {!readOnly && (
        <CardOptions
          content={content}
          patch={patch}
          variant={variant}
          accent={accent}
          iconEnabled={iconEnabled}
          statAllowed={statAllowed}
        />
      )}
    </div>
  )
}

function Badge({ badge, solid }) {
  const tone = BADGE_TONES.find((t) => t.value === badge.tone) ?? BADGE_TONES[3]
  const hex = bandBgHex(tone.token)
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold',
        // 진한 배경 위에서는 배지도 솔리드로 띄워야 대비가 산다.
        solid ? 'bg-white/90' : 'text-white',
      )}
      style={
        solid
          ? { color: hex ? `#${hex}` : undefined }
          : { backgroundColor: hex ? `#${hex}` : undefined }
      }
    >
      {badge.text}
    </span>
  )
}

// --------------------------------------------------------------------------- //
// 본문 — 긴 글과 같은 개요 항목 형식(depth + html/text)                          //
// --------------------------------------------------------------------------- //

const DEPTH_PREFIX = ['■', '–', '·', '·', '·', '·']

function CardBody({ items, readOnly, solid, onChange }) {
  // 편집 중 항목이 없으면 빈 줄 하나를 띄워 어디에 쓸지 보이게 한다(저장값은 빈 채).
  const rows = !readOnly && items.length === 0 ? [{ depth: 0, text: '' }] : items
  const editorRefs = useRef([])

  if (readOnly && rows.length === 0) return null

  const setRow = (i, next) => {
    const copy = rows.map((r, j) => (j === i ? { ...r, ...next } : r))
    // 완전히 빈 줄만 남으면 저장하지 않는다(빈 body 키를 남기지 않게).
    onChange(copy.filter((r) => (r.text ?? '').trim() !== ''))
  }

  const insertAfter = (i) => {
    const copy = [...rows]
    copy.splice(i + 1, 0, { depth: rows[i]?.depth ?? 0, text: '' })
    onChange(copy.filter((r, j) => j === i + 1 || (r.text ?? '').trim() !== ''))
    // 새 줄로 포커스 — DOM 이 생긴 다음 프레임에.
    requestAnimationFrame(() => editorRefs.current[i + 1]?.focus?.())
  }

  const removeAt = (i) => {
    if (rows.length <= 1) return
    onChange(rows.filter((_, j) => j !== i).filter((r) => (r.text ?? '').trim() !== ''))
    requestAnimationFrame(() => editorRefs.current[Math.max(0, i - 1)]?.focus?.())
  }

  const shiftDepth = (i, delta) => {
    const cur = rows[i]?.depth ?? 0
    setRow(i, { depth: Math.max(0, Math.min(5, cur + delta)) })
  }

  return (
    <div className={cn('mt-2 space-y-0.5', readOnly && 'text-sm')}>
      {rows.map((item, i) => {
        const depth = Math.max(0, Math.min(5, item.depth ?? 0))
        return (
          <div
            key={i}
            className="flex items-start gap-1.5 text-sm"
            style={{ paddingLeft: `${depth * 12}px` }}
          >
            <span
              className={cn('mt-[3px] shrink-0 text-[10px]', !solid && 'text-muted-foreground', solid && 'opacity-70')}
              aria-hidden="true"
            >
              {DEPTH_PREFIX[depth]}
            </span>
            {readOnly ? (
              <span
                className="min-w-0 flex-1"
                // 본문 html 은 저장 시 sanitize 된 리치텍스트(긴 글과 동일 경로).
                dangerouslySetInnerHTML={{ __html: item.html || escapeText(item.text) }}
              />
            ) : (
              <RichTextRowEditor
                ref={(el) => { editorRefs.current[i] = el }}
                html={item.html || escapeText(item.text)}
                placeholder="내용"
                className="min-w-0 flex-1"
                onChange={(html, text) =>
                  setRow(i, { html: _richIsEmpty(html) ? undefined : html, text: text ?? '' })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    insertAfter(i)
                  } else if (e.key === 'Tab') {
                    e.preventDefault()
                    shiftDepth(i, e.shiftKey ? -1 : 1)
                  } else if (
                    e.key === 'Backspace' &&
                    (item.text ?? '').trim() === '' &&
                    rows.length > 1
                  ) {
                    e.preventDefault()
                    removeAt(i)
                  }
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 평문 → 최소 HTML(리치 편집기 입력 형식). 마크업 주입 방지용 이스케이프 포함. */
function escapeText(text) {
  const s = String(text ?? '')
  if (!s) return ''
  const esc = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<p>${esc}</p>`
}

// --------------------------------------------------------------------------- //
// 옵션 바 — 표현형·색·아이콘·배지·KPI                                            //
// --------------------------------------------------------------------------- //

function CardOptions({ content, patch, variant, accent, iconEnabled, statAllowed }) {
  const badge = content?.badge
  const stat = content?.stat
  return (
    <EditorOptionBar title="카드">
      <EditorOptionSegmented
        label="표현"
        value={variant}
        options={VARIANTS.map((v) => ({ value: v.value, label: v.label }))}
        onChange={(v) => patch({ variant: v })}
      />

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">색</span>
        <ColorSwatchPicker
          value={accent}
          onChange={(token) => patch({ accent: token ?? undefined })}
        />
      </div>

      {iconEnabled && (
        <IconPicker
          value={content?.icon}
          onChange={(name) => patch({ icon: name ?? undefined })}
        />
      )}

      <EditorOptionToggle
        label="배지"
        value={!!badge}
        onChange={(on) =>
          patch({ badge: on ? { text: '완료', tone: 'success' } : undefined })
        }
        hint="상태 라벨(완료/주의 등)을 오른쪽 위에 답니다."
      />
      {badge && (
        <>
          <input
            value={badge.text ?? ''}
            onChange={(e) => patch({ badge: { ...badge, text: e.target.value } })}
            placeholder="완료"
            className="h-7 w-20 rounded border bg-background px-2 text-xs"
          />
          <select
            value={badge.tone ?? 'neutral'}
            onChange={(e) => patch({ badge: { ...badge, tone: e.target.value } })}
            className="h-7 rounded border bg-background px-1 text-xs"
          >
            {BADGE_TONES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </>
      )}

      {statAllowed && (
        <EditorOptionToggle
          label="KPI 숫자"
          value={!!stat}
          onChange={(on) => patch({ stat: on ? { value: '', unit: '' } : undefined })}
          hint="큰 숫자 + 단위로 지표 타일처럼 보여줍니다."
        />
      )}
      {statAllowed && stat && (
        <>
          <input
            value={stat.value ?? ''}
            onChange={(e) => patch({ stat: { ...stat, value: e.target.value } })}
            placeholder="128"
            className="h-7 w-16 rounded border bg-background px-2 text-xs"
          />
          <input
            value={stat.unit ?? ''}
            onChange={(e) => patch({ stat: { ...stat, unit: e.target.value } })}
            placeholder="건"
            className="h-7 w-12 rounded border bg-background px-2 text-xs"
          />
        </>
      )}

      <input
        value={content?.footnote ?? ''}
        onChange={(e) => patch({ footnote: e.target.value || undefined })}
        placeholder="각주(선택)"
        className="h-7 w-32 rounded border bg-background px-2 text-xs"
      />
    </EditorOptionBar>
  )
}

function IconPicker({ value, onChange }) {
  const Current = cardIconComponent(value)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="아이콘"
          aria-label="아이콘 선택"
          className="flex h-7 items-center gap-1 rounded border bg-background px-2 text-xs hover:bg-muted"
        >
          {Current ? <Current className="h-3.5 w-3.5" /> : <Palette className="h-3.5 w-3.5" />}
          <span className="text-muted-foreground">아이콘</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium">아이콘</span>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" /> 없애기
            </button>
          )}
        </div>
        <div className="grid grid-cols-8 gap-1">
          {CARD_ICON_NAMES.map((name) => {
            const Cmp = cardIconComponent(name)
            return (
              <button
                key={name}
                type="button"
                title={name}
                onClick={() => onChange(name)}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded hover:bg-muted',
                  value === name && 'bg-primary/15 ring-1 ring-primary',
                )}
              >
                <Cmp className="h-4 w-4" />
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default CardEditor
