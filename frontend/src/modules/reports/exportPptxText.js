/** 텍스트 위젯 → pptxgenjs 네이티브 텍스트 런 변환 (PPT 내보내기 Phase 2).
 *
 *  heading / rich_text / bulleted_list / key_value 를 이미지가 아니라 편집
 *  가능한 PPT 텍스트박스로 만든다(글자 색·굵기·기울임·밑줄·글머리·들여쓰기
 *  유지, 검색·편집 가능). 표·차트·수식 등은 그대로 이미지(이 모듈 대상 아님).
 *
 *  색은 rt-c-{token} 클래스(현재 저장 형식)를 라이트모드 swatch hex 로 매핑 —
 *  슬라이드는 흰 배경이라 라이트 색이 맞다. (exportReportToDocx 의 _TOKEN_HEX
 *  와 같은 사유.)
 */
import { COLOR_TOKENS } from '@/shared/text-color'

export const NATIVE_TEXT_TYPES = new Set([
  'heading',
  'rich_text',
  'bulleted_list',
  'key_value',
])

const TOKEN_HEX = Object.fromEntries(
  COLOR_TOKENS.filter((t) => t.token).map((t) => [
    t.token,
    t.swatch.replace('#', '').toUpperCase(),
  ]),
)

// RichText 위젯 글머리 기호(화면과 동일 set). depth 0 = ■.
const DEPTH_PREFIX = ['■', '-', '·', '·', '·', '·']

function normalizeHex(s) {
  if (!s) return null
  const t = String(s).trim()
  let m = t.match(/^#([0-9a-f]{3})$/i)
  if (m) {
    const v = m[1]
    return (v[0] + v[0] + v[1] + v[1] + v[2] + v[2]).toUpperCase()
  }
  m = t.match(/^#([0-9a-f]{6})$/i)
  if (m) return m[1].toUpperCase()
  m = t.match(/^rgba?\(([^)]+)\)/i)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x))
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) {
      const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
      return (h(p[0]) + h(p[1]) + h(p[2])).toUpperCase()
    }
  }
  return null
}

function cssPx(s) {
  const m = String(s).match(/([\d.]+)\s*px/)
  return m ? parseFloat(m[1]) : null
}

// 인라인 html → 문자 런 [{text, bold, italic, underline, strike, color, px}]
function walkRuns(node, fmt, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3 /* TEXT */) {
      const text = child.nodeValue ?? ''
      if (text.length === 0) continue
      out.push({ text, ...fmt })
    } else if (child.nodeType === 1 /* ELEMENT */) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'br') {
        out.push({ text: '\n', ...fmt, isBreak: true })
        continue
      }
      const next = { ...fmt }
      if (tag === 'strong' || tag === 'b') next.bold = true
      if (tag === 'em' || tag === 'i') next.italic = true
      if (tag === 'u') next.underline = true
      if (tag === 's' || tag === 'del' || tag === 'strike') next.strike = true
      if (tag === 'span') {
        const style = child.getAttribute('style') || ''
        const cm = style.match(/(^|;)\s*color\s*:\s*([^;]+)/i)
        const fm = style.match(/(^|;)\s*font-size\s*:\s*([^;]+)/i)
        if (cm) next.color = normalizeHex(cm[2]) ?? next.color
        if (fm) next.px = cssPx(fm[2]) ?? next.px
        const cls = child.getAttribute('class') || ''
        const tok = cls.match(/\brt-c-([a-z0-9]+)\b/)
        if (tok && TOKEN_HEX[tok[1]]) next.color = TOKEN_HEX[tok[1]]
      }
      walkRuns(child, next, out)
    }
  }
}

function htmlToCharRuns(html, fallbackText) {
  const base = { bold: false, italic: false, underline: false, strike: false, color: null, px: null }
  const fallback = () => (fallbackText ? [{ text: fallbackText, ...base }] : [])
  if (typeof html !== 'string' || !html || typeof DOMParser === 'undefined') return fallback()
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return fallback()
  }
  const p = doc.body.firstElementChild
  if (!p) return fallback()
  const out = []
  walkRuns(p, base, out)
  return out.length > 0 ? out : fallback()
}

function formatKvValue(item, raw) {
  if (raw == null || raw === '') return ''
  if (item?.multi && Array.isArray(raw)) {
    return raw.filter((v) => v !== '' && v != null).map(String).join(', ')
  }
  if (Array.isArray(raw)) return raw.filter((v) => v !== '' && v != null).map(String).join(', ')
  return String(raw)
}

// ── 타입별 "줄(line)" 생성 — 각 줄 = { charRuns, para } ──────────────── //
// 캡션(제목)은 여기서 다루지 않는다 — exportReportToPptx 가 렌더된 캡션 DOM 을
// 읽어 위젯 위에 별도 텍스트박스로 얹는다(번호 "그림/표 N" + 라벨 자동채움 포함).

function headingLines(meta) {
  const text = meta.content?.text ?? meta.props?.default_text ?? ''
  const html = meta.content?.text_html
  const cr = htmlToCharRuns(html, text)
  if (cr.length === 0) return []
  // 제목은 굵게(화면에서도 강조). 명시 색/굵기는 유지.
  cr.forEach((r) => {
    r.bold = true
  })
  return [{ charRuns: cr, para: {} }]
}

function richTextLines(meta) {
  const items = Array.isArray(meta.content?.items) ? meta.content.items : []
  const lines = []
  for (const it of items) {
    const text = typeof it?.text === 'string' ? it.text : ''
    const cr = htmlToCharRuns(it?.html, text)
    if (cr.length === 0) continue
    const depth = Math.max(0, Math.min(5, Math.floor(Number(it?.depth) || 0)))
    const glyph = DEPTH_PREFIX[depth] || '·'
    const prefix = { text: `${'  '.repeat(depth)}${glyph} `, color: '888888' }
    lines.push({ charRuns: [prefix, ...cr], para: {} })
  }
  return lines
}

function bulletedListLines(meta) {
  const items = Array.isArray(meta.content?.items) ? meta.content.items : []
  const lines = []
  for (const s of items) {
    if (typeof s !== 'string' || !s.trim()) continue
    lines.push({ charRuns: [{ text: s }], para: { bullet: true } })
  }
  return lines
}

function keyValueLines(meta) {
  const items = Array.isArray(meta.content?.items)
    ? meta.content.items
    : Array.isArray(meta.props?.items)
      ? meta.props.items
      : []
  const lines = []
  for (const item of items) {
    const value = formatKvValue(item, meta.content?.[item.key])
    if (value === '') continue
    const label = item.label || item.key || ''
    lines.push({
      charRuns: [
        { text: `${label}: `, color: '555555' },
        { text: value },
      ],
      para: {},
    })
  }
  return lines
}

function buildLines(meta) {
  switch (meta.type) {
    case 'heading':
      return headingLines(meta)
    case 'rich_text':
      return richTextLines(meta)
    case 'bulleted_list':
      return bulletedListLines(meta)
    case 'key_value':
      return keyValueLines(meta)
    default:
      return []
  }
}

/** 위젯의 첫 *본문* 텍스트 노드 computed font-size(px). 캡션은 제외(본문 기준).
 *  못 찾으면 null → 호출부가 기본값(18)으로. */
export function readBasePx(el) {
  if (!el || typeof document === 'undefined') return null
  try {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const t = n.nodeValue?.trim()
      const parent = n.parentElement
      if (!t || !parent) continue
      if (parent.closest('[data-export-skip]')) continue // 캡션·액션 등 제외
      const px = parseFloat(window.getComputedStyle(parent).fontSize)
      if (Number.isFinite(px) && px > 0) return px
    }
  } catch {
    /* noop */
  }
  return null
}

/** 텍스트 위젯 → pptxgenjs addText 용 런 배열. 빈 내용/미지원이면 null.
 *  ctx: { ptPerPx, basePx } — 글자 크기를 px→pt 로 환산(레이아웃 배율 반영). */
export function buildPptxText(meta, ctx) {
  if (!NATIVE_TEXT_TYPES.has(meta?.type)) return null
  const lines = buildLines(meta)
  if (lines.length === 0) return null

  const basePx = Number.isFinite(ctx?.basePx) && ctx.basePx > 0 ? ctx.basePx : 18
  const ptPerPx = Number.isFinite(ctx?.ptPerPx) && ctx.ptPerPx > 0 ? ctx.ptPerPx : 1
  const toPt = (px) => Math.max(6, Math.round((px ?? basePx) * ptPerPx))

  const runs = []
  lines.forEach((line, li) => {
    const cr = line.charRuns.length ? line.charRuns : [{ text: '' }]
    const isLastLine = li === lines.length - 1
    cr.forEach((r, ri) => {
      const isLastRun = ri === cr.length - 1
      runs.push({
        text: r.text ?? '',
        options: {
          bold: r.bold || undefined,
          italic: r.italic || undefined,
          underline: r.underline ? { style: 'sng' } : undefined,
          strike: r.strike || undefined,
          color: r.color || undefined,
          fontSize: toPt(r.px),
          ...(line.para || {}),
          ...(isLastRun && !isLastLine ? { breakLine: true } : {}),
        },
      })
    })
  })
  return runs.length > 0 ? runs : null
}
