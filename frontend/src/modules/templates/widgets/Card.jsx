// 카드(Card) 위젯 — 한 장 요약 블록을 **여러 장 담는 격자**.
//
// 위젯 하나가 카드 N 장을 갖는다(content.cards). 타일 그리드가 카드의 주 용법인데,
// 블록을 N 개 만들어 폭을 맞추는 방식은 폭이 어긋나고(12 → 6/6 → 6/3/3) 색·표현형을
// 장마다 다시 정해야 해서, 위젯 하나가 격자를 갖도록 했다. 색·표현형은 **세트 공통**
// 으로 한 번만 정하면 모든 장에 적용된다(장별 덮어쓰기도 가능).
//
// KPI 타일·콜아웃 밴드·상태 카드는 **별도 타입이 아니라** variant/선택필드의
// 조합으로 파생한다(카드위젯_설계.md §3):
//   개념 타일 = icon+title+body · KPI = stat · 밴드 = variant:'banner' · 상태 = badge
//
// 색은 hex 가 아니라 rt-c-* 토큰으로만 저장한다. 화면은 클래스(rt-bg-*)로 테마에
// 적응하고, export(PPTX/DOCX)는 같은 토큰을 hex 로 굽는다(bandBgHex/highlightHex).
// 제목 배경 밴드(Heading.jsx)가 쓰던 배관을 그대로 재사용한다.
import { useRef } from 'react'
import { ChevronLeft, ChevronRight, Palette, Plus, Trash2, X } from 'lucide-react'
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
  captionPositionOf,
  captionSkipProps,
  _richIsEmpty,
} from './_shared'
import { RichTextRowEditor } from './RichTextRowEditor'
import { CARD_ICON_NAMES, cardIconComponent } from './cardIcons'
import {
  CARD_ITEM_KEYS,
  CARD_MAX_COLUMNS as MAX_COLUMNS,
  CARD_DEFAULT_ACCENT as DEFAULT_ACCENT,
  cardAccent,
  cardIsSolid as isSolid,
  cardVariant,
  cardsOf,
  columnsOf,
} from './cardModel'

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

// --------------------------------------------------------------------------- //
// Effective values — 카드 → content(세트 공통) → props(템플릿) → 하드 기본값     //
// --------------------------------------------------------------------------- //

/**
 * variant + accent → 카드 겉면 스타일.
 *
 * soft/outline 은 클래스(rt-bg-*)로 테마 적응시키고, filled/banner 는 밴드와 같은
 * 솔리드 hex + 자동 대비 글자색을 쓴다(연한 틴트로는 "진한 배경"이 안 되므로).
 */
function surfaceOf(variant, accent) {
  const hex = bandBgHex(accent)
  if (variant === 'filled' || variant === 'banner') {
    const fg = bandTextHex(accent)
    return {
      className: variant === 'banner' ? 'rounded-md' : 'rounded-lg',
      style: hex ? { backgroundColor: `#${hex}`, color: `#${fg}` } : undefined,
    }
  }
  if (variant === 'outline') {
    // 테두리 색만 악센트 — 배경은 투명(카드 뒤 지면이 비친다).
    return {
      className: 'rounded-lg border-2',
      style: hex ? { borderColor: `#${hex}` } : undefined,
    }
  }
  // soft — 연한 틴트(color-mix 16%)라 라이트/다크 모두에서 글자가 읽힌다.
  return { className: cn('rounded-lg border', bgTokenClass(accent)), style: undefined }
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
    <div className="grid grid-cols-3 gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className={cn('p-2', className)} style={style}>
          <div className="text-[11px] font-semibold">
            {i === 0 ? (props?.label || '카드') : ' '}
          </div>
        </div>
      ))}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor — 작성 화면(읽기 모드 렌더도 이 컴포넌트가 겸한다)                      //
// --------------------------------------------------------------------------- //

export function CardEditor({ props, content, onChange, readOnly }) {
  const patch = (p) => onChange({ ...(content ?? {}), ...p })

  const cards = cardsOf(content)
  // 편집 중 한 장도 없으면 빈 카드 한 장을 띄운다(저장값은 그대로 비어 있음).
  const shown = !readOnly && cards.length === 0 ? [{}] : cards
  const cols = columnsOf(content, shown.length)
  const capPos = captionPositionOf(content)

  /** 카드 배열을 통째로 다시 쓴다 — 레거시 최상위 필드는 이때 정리한다.
   *  (cards 를 쓰기 시작하면 최상위 카드 필드는 중복 해석을 일으키므로 제거) */
  const writeCards = (next) => {
    const base = { ...(content ?? {}) }
    for (const k of CARD_ITEM_KEYS) {
      if (k !== 'variant' && k !== 'accent') delete base[k]
    }
    onChange({ ...base, cards: next })
  }
  const patchCard = (i, p) =>
    writeCards(shown.map((c, j) => (j === i ? { ...c, ...p } : c)))
  const addCard = () => writeCards([...shown, {}])
  const removeCard = (i) => writeCards(shown.filter((_, j) => j !== i))
  /** 장 순서 이동 — 격자라 dir 은 -1(앞)/+1(뒤). 줄바꿈은 열 수가 알아서 하므로
   *  "왼쪽/오른쪽"이 아니라 **배열 순서**를 옮긴다(마지막 열에서 +1 하면 다음 줄 첫 칸).
   *  _shared.jsx FieldItemListEditor 의 move(idx, dir) 와 같은 방식. */
  const moveCard = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= shown.length) return
    const next = [...shown]
    const [moved] = next.splice(i, 1)
    next.splice(j, 0, moved)
    writeCards(next)
  }

  const captionEl = (
    <CaptionInput
      value={content?.caption ?? ''}
      onChange={(v) => patch({ caption: v })}
      // 위젯 공통 머리글(격자 **바깥**). 카드 안 제목과 헷갈리지 않게 다른 위젯과
      // 같은 규약(props.label)만 띄운다.
      placeholder={props?.label ?? '카드'}
      readOnly={readOnly}
      color={content?.caption_color}
      {...captionSkipProps({ content, patch })}
    />
  )

  return (
    <div className="flex h-full flex-col">
      {capPos === 'above' && captionEl}

      <div
        className="grid min-h-0 flex-1 gap-2"
        // ⚠️ 열 수는 인라인 style 로 — `grid-cols-${n}` 처럼 클래스를 조립하면
        // Tailwind 스캐너가 못 보고 purge 해서 열이 안 먹는다(색 토큰과 같은 함정).
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {shown.map((card, i) => (
          <CardTile
            key={i}
            card={card}
            content={content}
            props={props}
            readOnly={readOnly}
            onPatch={(p) => patchCard(i, p)}
            onRemove={shown.length > 1 ? () => removeCard(i) : null}
            onMove={shown.length > 1 ? (dir) => moveCard(i, dir) : null}
            canMoveBack={i > 0}
            canMoveFwd={i < shown.length - 1}
          />
        ))}
        {!readOnly && (
          <button
            type="button"
            onClick={addCard}
            title="카드 한 장 추가"
            className="flex min-h-[64px] items-center justify-center gap-1 rounded-lg border-2 border-dashed text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" /> 카드
          </button>
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
        <SetOptions
          content={content}
          props={props}
          patch={patch}
          cols={cols}
          cardCount={shown.length}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// CardTile — 카드 한 장                                                        //
// --------------------------------------------------------------------------- //

function CardTile({
  card, content, props, readOnly, onPatch, onRemove, onMove, canMoveBack, canMoveFwd,
}) {
  const variant = cardVariant(card, content, props)
  const accent = cardAccent(card, content, props)
  const solid = isSolid(variant)
  const { className: surfaceClass, style: surfaceStyle } = surfaceOf(variant, accent)

  const iconEnabled = props?.icon_enabled !== false
  const statAllowed = props?.allow_stat !== false

  const icon = iconEnabled ? card?.icon : undefined
  const IconCmp = cardIconComponent(icon)
  const title = card?.title ?? ''
  const eyebrow = card?.eyebrow ?? ''
  const footnote = card?.footnote ?? ''
  const badge = card?.badge
  const stat = statAllowed ? card?.stat : undefined
  const items = Array.isArray(card?.body?.items) ? card.body.items : []

  // 악센트 hex — 진한 배경이 아닐 때 아이콘/eyebrow 를 악센트 색으로 칠한다.
  const accentHex = bandBgHex(accent)
  const accentColor = solid ? undefined : (accentHex ? `#${accentHex}` : undefined)

  return (
    <div
      className={cn(
        'group/tile relative flex min-w-0 flex-col',
        surfaceClass,
        variant === 'banner' ? 'px-4 py-2.5' : 'p-3',
      )}
      style={surfaceStyle}
      data-card-tile
    >
      {/* 머리줄 — eyebrow / 배지 */}
      {(eyebrow || badge?.text || !readOnly) && (
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
              onChange={(e) => onPatch({ eyebrow: e.target.value || undefined })}
              placeholder="말머리(선택)"
              title="제목 위에 붙는 작은 라벨 — 번호(①)나 분류명(STEP 1, 요약 등)에 씁니다."
              className="w-full min-w-0 bg-transparent text-[11px] font-semibold uppercase tracking-wide outline-none placeholder:font-normal placeholder:normal-case placeholder:text-muted-foreground/60"
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
            onChange={(e) => onPatch({ title: e.target.value || undefined })}
            placeholder="카드 제목"
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
          onPatch({ body: next.length ? { items: next } : undefined })
        }
      />

      {footnote && (
        <p className={cn('mt-2 text-[11px]', !solid && 'text-muted-foreground', solid && 'opacity-75')}>
          {footnote}
        </p>
      )}

      {!readOnly && (
        <TileControls
          card={card}
          iconEnabled={iconEnabled}
          statAllowed={statAllowed}
          onPatch={onPatch}
          onRemove={onRemove}
          onMove={onMove}
          canMoveBack={canMoveBack}
          canMoveFwd={canMoveFwd}
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

/** 장별 컨트롤 — 호버할 때만 뜬다(카드가 여러 장이라 항상 보이면 시끄럽다). */
function TileControls({
  card, iconEnabled, statAllowed, onPatch, onRemove, onMove, canMoveBack, canMoveFwd,
}) {
  const has = (k) => card?.[k] != null
  return (
    <div
      data-export-skip
      className="mt-2 flex flex-wrap items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/tile:opacity-100"
    >
      {iconEnabled && (
        <IconPicker
          value={card?.icon}
          onChange={(name) => onPatch({ icon: name ?? undefined })}
        />
      )}
      <MiniToggle
        label="배지"
        on={has('badge')}
        onClick={() =>
          onPatch({ badge: has('badge') ? undefined : { text: '완료', tone: 'success' } })
        }
      />
      {has('badge') && (
        <>
          <input
            value={card.badge.text ?? ''}
            onChange={(e) => onPatch({ badge: { ...card.badge, text: e.target.value } })}
            placeholder="완료"
            className="h-6 w-16 rounded border bg-background px-1.5 text-[11px]"
          />
          <select
            value={card.badge.tone ?? 'neutral'}
            onChange={(e) => onPatch({ badge: { ...card.badge, tone: e.target.value } })}
            className="h-6 rounded border bg-background px-1 text-[11px]"
          >
            {BADGE_TONES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </>
      )}
      {statAllowed && (
        <MiniToggle
          label="KPI"
          on={has('stat')}
          onClick={() => onPatch({ stat: has('stat') ? undefined : { value: '', unit: '' } })}
        />
      )}
      {statAllowed && has('stat') && (
        <>
          <input
            value={card.stat.value ?? ''}
            onChange={(e) => onPatch({ stat: { ...card.stat, value: e.target.value } })}
            placeholder="128"
            className="h-6 w-14 rounded border bg-background px-1.5 text-[11px]"
          />
          <input
            value={card.stat.unit ?? ''}
            onChange={(e) => onPatch({ stat: { ...card.stat, unit: e.target.value } })}
            placeholder="건"
            className="h-6 w-10 rounded border bg-background px-1.5 text-[11px]"
          />
        </>
      )}
      <input
        value={card?.footnote ?? ''}
        onChange={(e) => onPatch({ footnote: e.target.value || undefined })}
        placeholder="각주"
        className="h-6 w-20 rounded border bg-background px-1.5 text-[11px]"
      />
      {/* 구조 조작(순서·삭제)은 오른쪽에 묶는다 — 왼쪽은 내용 컨트롤. */}
      {(onMove || onRemove) && (
        <div className="ml-auto flex items-center gap-0.5">
          {onMove && (
            <>
              <MoveButton
                dir={-1}
                disabled={!canMoveBack}
                onClick={() => onMove(-1)}
              />
              <MoveButton
                dir={1}
                disabled={!canMoveFwd}
                onClick={() => onMove(1)}
              />
            </>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              title="이 카드 삭제"
              className="flex h-6 w-6 items-center justify-center rounded border text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 순서 이동 버튼. 양 끝에서는 비활성 — 눌러도 아무 일 없는 버튼보다 낫다. */
function MoveButton({ dir, disabled, onClick }) {
  const Icon = dir < 0 ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={dir < 0 ? '앞으로 옮기기' : '뒤로 옮기기'}
      aria-label={dir < 0 ? '카드를 앞으로 옮기기' : '카드를 뒤로 옮기기'}
      className="flex h-6 w-6 items-center justify-center rounded border text-muted-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <Icon className="h-3 w-3" />
    </button>
  )
}

function MiniToggle({ label, on, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-6 rounded border px-1.5 text-[11px]',
        on ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
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
            {/* 글머리 기호 — 편집 중 **빈 줄**에는 띄우지 않는다. 아무것도 안 쓴
                칸 옆의 ■ 는 "이게 뭐지?" 만 유발하고 알려주는 게 없다. 첫 글자를
                치는 순간 나타나 목록임을 알린다(자리는 미리 비워 둬 안 밀린다). */}
            <span
              className={cn(
                'mt-[3px] w-3 shrink-0 text-[10px]',
                !solid && 'text-muted-foreground',
                solid && 'opacity-70',
              )}
              aria-hidden="true"
            >
              {readOnly || (item.text ?? '').trim() !== '' ? DEPTH_PREFIX[depth] : ''}
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
                placeholder={i === 0 ? '내용 — Enter 로 줄 추가' : '내용'}
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
// 세트 옵션 — 모든 장에 함께 적용되는 표현형·색·열 수                            //
// --------------------------------------------------------------------------- //

function SetOptions({ content, props, patch, cols, cardCount }) {
  const variant = cardVariant(null, content, props)
  const accent = cardAccent(null, content, props)
  return (
    <EditorOptionBar title="카드 세트">
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
      <EditorOptionSegmented
        label="열"
        value={cols}
        options={Array.from({ length: MAX_COLUMNS }, (_, i) => ({
          value: i + 1,
          label: String(i + 1),
        }))}
        onChange={(n) => patch({ columns: n })}
      />
      <span className="text-[11px] text-muted-foreground">
        카드 {cardCount}장 · 표현·색은 모든 장에 함께 적용(장별로 덮어쓸 수 있음)
      </span>
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
          className="flex h-6 items-center gap-1 rounded border bg-background px-1.5 text-[11px] hover:bg-muted"
        >
          {Current ? <Current className="h-3 w-3" /> : <Palette className="h-3 w-3" />}
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
