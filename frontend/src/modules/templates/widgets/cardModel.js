// 카드 위젯의 **순수 모델** — content 해석 규칙. 화면(Card.jsx)과 내보내기
// (exportPptxCard.js·exportReportToDocx.js)가 같은 규칙을 쓰도록 여기 한 벌만 둔다.
// 컴포넌트가 아니므로 이 파일엔 JSX 를 두지 않는다.
import { normalizeToken } from '@/shared/text-color'

export const CARD_VARIANTS = ['soft', 'outline', 'filled', 'banner']
export const CARD_DEFAULT_ACCENT = 'slate'
export const CARD_MAX_COLUMNS = 4

/** 카드 한 장이 가질 수 있는 필드(레거시 content 최상위에서 끌어올릴 때 씀). */
export const CARD_ITEM_KEYS = [
  'variant', 'accent', 'icon', 'eyebrow', 'title', 'body', 'badge', 'stat', 'footnote',
]

// 카드 "내용"으로 칠 수 있는 키 — variant/accent 만 있는 content 는 세트 설정일 뿐
// 카드가 아니다(그걸 1 장으로 세면 빈 카드가 유령처럼 생긴다).
const CARD_BODY_KEYS = ['icon', 'eyebrow', 'title', 'body', 'badge', 'stat', 'footnote']

/**
 * content → 카드 배열. `cards` 가 있으면 그대로, 없으면 **레거시 단일 카드**
 * (카드 필드가 content 최상위에 있던 시절)를 1 장으로 끌어올린다.
 *
 * ⚠️ 이 폴백은 지우면 안 된다 — 이미 저장된 보고서가 그 형태다. 해당 보고서를
 * 다시 저장하면 `cards` 로 옮겨 적히므로 시간이 지나면 자연히 줄어든다.
 */
export function cardsOf(content) {
  if (Array.isArray(content?.cards)) return content.cards
  const legacy = {}
  for (const k of CARD_ITEM_KEYS) {
    if (content?.[k] !== undefined) legacy[k] = content[k]
  }
  return CARD_BODY_KEYS.some((k) => legacy[k] !== undefined) ? [legacy] : []
}

/** 한 줄에 놓을 장수 — 지정값 우선, 없으면 장수에 맞춰(최대 4열). */
export function columnsOf(content, cardCount) {
  const c = content?.columns
  if (Number.isInteger(c) && c >= 1 && c <= CARD_MAX_COLUMNS) return c
  return Math.max(1, Math.min(CARD_MAX_COLUMNS, cardCount || 1))
}

/** 표현형 — 카드 > 세트 공통(content) > 템플릿(props) > 'soft'. */
export function cardVariant(card, content, props) {
  const ok = (v) => CARD_VARIANTS.includes(v)
  if (ok(card?.variant)) return card.variant
  if (ok(content?.variant)) return content.variant
  if (ok(props?.default_variant)) return props.default_variant
  return 'soft'
}

/** 악센트 색 토큰 — 카드 > 세트 공통 > 템플릿 > 기본. 항상 접두사 없는 토큰. */
export function cardAccent(card, content, props) {
  return (
    normalizeToken(card?.accent) ??
    normalizeToken(content?.accent) ??
    normalizeToken(props?.default_accent) ??
    CARD_DEFAULT_ACCENT
  )
}

/** 진한 배경(filled/banner)인지 — 글자색을 대비색으로 뒤집어야 하는 경우. */
export function cardIsSolid(variant) {
  return variant === 'filled' || variant === 'banner'
}
