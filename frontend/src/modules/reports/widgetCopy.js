/** 뷰 모드에서 위젯 내용을 클립보드/파일로 손쉽게 내보내는 헬퍼.
 *
 *  세 갈래로 나눠 처리한다 — DOCX export(convertBlock)의 위젯 분류와 같은
 *  기준이다:
 *   - 글 위젯(text): 글자 그대로 클립보드 복사.
 *   - 표 위젯(table): 렌더된 <table> 을 HTML 로 복사 → PPT·Word 엔 표,
 *     엑셀엔 셀.
 *   - 시각 위젯(image): #block-<id> 를 html2canvas 로 떠서 PNG 다운로드.
 *
 *  운영서버가 평문 HTTP 라 이미지 클립보드(navigator.clipboard.write)는
 *  secure-context 전용으로 불가 → 시각 위젯은 PNG 다운로드로 대체한다.
 *  텍스트/표는 HTTP-safe 폴백(copyTextToClipboard / execCommand)을 쓴다.
 *
 *  시각 위젯을 새로 추가하려면 IMAGE_TYPES 에 슬러그만 더하면 된다 — 캡처는
 *  위젯-불문이고, 렌더러가 id `block-<id>` 아래 마운트되기만 하면 된다(모든
 *  /widgets/ Editor 가 그렇다). WebGL 캔버스(scatter3d/cad_3d/plotly gl)는
 *  preserveDrawingBuffer:true 로 그려져 html2canvas 가 픽셀을 읽을 수 있다.
 */
import { toast } from 'sonner'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
import { toTsv } from '@/modules/templates/widgets/_shared'

// 글자로 복사 — 캡션/항목 텍스트를 그대로 클립보드에.
const TEXT_TYPES = new Set(['rich_text', 'heading', 'bulleted_list', 'key_value'])
// 렌더된 <table> 을 HTML 표로 복사 (PPT·Word 엔 표, 엑셀엔 셀).
const TABLE_TYPES = new Set(['table', 'raci_matrix', 'comparison'])
// #block-<id> 를 PNG 로 떠서 다운로드 (차트·플롯·다이어그램·3D·이미지 등).
const IMAGE_TYPES = new Set([
  'chart',
  'scatter',
  'scatter3d',
  'heatmap',
  'contour',
  'treemap',
  'packing',
  'tree',
  'network',
  'mind_map',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
  'equation',
  'progress_bar',
  'milestone',
  'flowchart',
  'quadrant',
  'sankey',
  'cad_3d',
  'image',
])

export function isWidgetCopyable(type) {
  return TEXT_TYPES.has(type) || TABLE_TYPES.has(type) || IMAGE_TYPES.has(type)
}

/** 버튼 아이콘/툴팁 결정용 — 'text' | 'table' | 'image' | null. */
export function widgetCopyKind(type) {
  if (IMAGE_TYPES.has(type)) return 'image'
  if (TABLE_TYPES.has(type)) return 'table'
  if (TEXT_TYPES.has(type)) return 'text'
  return null
}

// RichText.jsx 의 DEPTH_PREFIX 미러 — DOM 추출이 불가한 폴백 경로에서만 쓴다
// (DOM 경로는 보고서별 글리프 override 까지 반영된 실제 기호를 그대로 읽는다).
const DEPTH_PREFIX = ['■', '-', '·', '·', '·', '·']

/** #block-<id> 안에서 selector 에 맞는 *보이는* 요소를 고른다.
 *
 *  autoFit 위젯은 높이 측정용 mirror 복제본을 본체보다 *먼저* 그린다 — class
 *  `report-autofit-mirror` + `visibility:hidden`. 단순 querySelector 는 이
 *  숨은 mirror 를 집어버리는데, mirror 는 innerText 가 ''(visibility:hidden)
 *  라 본문이 통째로 빈 채 복사되고, 표도 엉뚱한(숨은) 복제본을 뜬다. 그래서
 *  mirror 안에 들어있지 않은 첫 요소만 고른다. */
function findVisibleInBlock(blockId, selector) {
  if (typeof document === 'undefined') return null
  const el = document.getElementById(`block-${blockId}`)
  if (!el) return null
  const all = el.querySelectorAll(selector)
  for (const node of all) {
    if (!node.closest('.report-autofit-mirror')) return node
  }
  return all[0] ?? null
}

/** 렌더된 긴 글(OutlineView)에서 화면에 보이는 그대로 추출한다 — 줄마다
 *  글머리 기호(보고서별 글리프 포함) + 들여쓰기 + 본문의 줄바꿈(<br>·문단)을
 *  살린다. innerText 는 실제 레이아웃 기준이라 줄바꿈이 그대로 따라온다.
 *  관계 칩은 본문(span[data-rt-body]) 밖이라 자연히 빠진다. 렌더 전이면 null. */
function richTextFromDom(blockId) {
  const outline = findVisibleInBlock(blockId, '[data-rt-outline]')
  if (!outline) return null
  const lines = []
  let anyBody = false
  outline.querySelectorAll('[data-rt-row]').forEach((row) => {
    const depth = Math.max(0, Number(row.getAttribute('data-rt-depth')) || 0)
    const glyph = row.querySelector('[data-rt-prefix]')?.textContent?.trim() ?? ''
    const bodyEl = row.querySelector('[data-rt-body]')
    const body = (bodyEl?.innerText ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .trim()
    if (body) anyBody = true
    const indent = '  '.repeat(depth)
    lines.push(`${indent}${glyph ? `${glyph} ` : ''}${body}`)
  })
  // \ubcf8\ubb38\uc774 \ud558\ub098\ub3c4 \uc548 \uc7a1\ud614\uc73c\uba74(\uc608: \uc228\uc740 \ud2b8\ub9ac\ub9cc \uc788\ub358 \uc608\uc678) \uae00\uba38\ub9ac \uae30\ud638\ub9cc \ub0a8\uc544
  // \ubc84\ub9ac\ubbc0\ub85c null \ub85c \ub3cc\ub824\ubcf4\ub0b4 \ub370\uc774\ud130 \ubaa8\ub378 \ud3f4\ubc31\uc744 \ud0c0\uac8c \ud55c\ub2e4.
  if (!anyBody) return null
  return lines.join('\n')
}

/** DOM 추출 폴백 — 데이터 모델(items)에서 재구성. 글머리 기호는 기본
 *  DEPTH_PREFIX 로 붙이고, 빈 줄은 뷰와 동일하게 건너뛴다. */
function richTextToPlain(content) {
  const items = Array.isArray(content?.items) ? content.items : []
  return items
    .filter((it) => (typeof it?.text === 'string' ? it.text : '').trim().length > 0)
    .map((it) => {
      const depth = Math.max(0, Math.min(5, Math.floor(Number(it?.depth) || 0)))
      const glyph = DEPTH_PREFIX[Math.min(depth, DEPTH_PREFIX.length - 1)]
      return `${'  '.repeat(depth)}${glyph} ${it.text}`
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function headingToPlain(content) {
  return typeof content?.text === 'string' ? content.text.trim() : ''
}

function bulletedListToPlain(content) {
  const items = Array.isArray(content?.items) ? content.items : []
  return items
    .map((it) => (typeof it === 'string' ? it.trim() : ''))
    .filter((s) => s.length > 0)
    .map((s) => `• ${s}`)
    .join('\n')
}

// key_value 의 값 포맷 — KeyValue.jsx 의 isFilled/formatKvValue 와 동일 규칙.
function kvIsFilled(item, value) {
  if (value === undefined || value === null) return false
  if (item?.multi) return Array.isArray(value) && value.some((v) => v !== '' && v != null)
  return value !== ''
}
function kvFormatValue(item, value) {
  if (value === undefined || value === '' || value === null) return ''
  if (item?.multi && Array.isArray(value)) {
    return value.filter((v) => v !== '' && v != null).map(String).join(', ')
  }
  return String(value)
}
function keyValueToPlain(content) {
  const items = Array.isArray(content?.items) ? content.items : []
  return items
    .filter((item) => kvIsFilled(item, content?.[item.key]))
    .map((item) => {
      const label = item.label || item.key || ''
      return `${label}: ${kvFormatValue(item, content[item.key])}`
    })
    .join('\n')
}

/** 글 위젯(TEXT_TYPES) → 클립보드용 평문. 타입별 직렬화기로 분기.
 *  긴 글은 렌더된 DOM(글머리 기호·줄바꿈 포함)을 우선 읽고, 없으면 모델로 폴백. */
function widgetToPlainText(type, content, blockId) {
  if (type === 'heading') return headingToPlain(content)
  if (type === 'bulleted_list') return bulletedListToPlain(content)
  if (type === 'key_value') return keyValueToPlain(content)
  return richTextFromDom(blockId) ?? richTextToPlain(content)
}

function tableToTsvText(content) {
  const cols = Array.isArray(content?.columns) ? content.columns : []
  const rows = Array.isArray(content?.rows) ? content.rows : []
  if (cols.length === 0) return ''
  const header = cols.map((c) => c.label || c.key || '')
  const body = rows.map((r) => cols.map((c) => r?.[c.key]))
  return toTsv([header, ...body])
}

function safeFileName(s) {
  return (s || 'chart')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
}

// html2canvas(구버전)는 최신 색 함수 color()/color-mix()/oklch() 를 못 파싱하고
// "unsupported color function" 으로 캡처를 통째로 실패시킨다(비교표·토큰 배경 등).
const MODERN_COLOR_FN = /(?:color|color-mix|oklch|oklab|lab|lch|hwb)\(/i
const NEUTRALIZE_COLOR_PROPS = [
  'color',
  'backgroundColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'outlineColor',
  'textDecorationColor',
  'fill',
  'stroke',
]

/** 캡처 직전 클론 문서에서 최신 색 함수를 rgb(a) 로 인라인 치환한다.
 *  html2canvas 의 onclone 에서 호출 — 클론에만 손대니 화면은 안 바뀐다. */
function neutralizeUnsupportedColors(rootEl) {
  if (!rootEl) return
  const win = rootEl.ownerDocument?.defaultView
  if (!win) return
  const nodes = [rootEl, ...rootEl.querySelectorAll('*')]
  for (const node of nodes) {
    if (!node.style) continue
    let cs
    try {
      cs = win.getComputedStyle(node)
    } catch {
      continue
    }
    for (const prop of NEUTRALIZE_COLOR_PROPS) {
      const v = cs[prop]
      if (typeof v === 'string' && MODERN_COLOR_FN.test(v)) {
        const c = parseCssColorToRgba(v)
        if (c) node.style[prop] = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`
      }
    }
  }
}

/** 위젯 DOM(#block-<id>)을 PNG 로 떠서 다운로드. DOCX export 와 거의 같은
 *  html2canvas 옵션이되, 한 가지가 다르다 — DOCX 는 캡션을 별도 제목 문단으로
 *  다시 박으므로 data-export-skip="caption" 으로 PNG 에서 캡션을 빼지만, 위젯
 *  복사는 PNG 한 장이 전부라 "그림 N / 표 N" 캡션을 이미지에 같이 넣어야 한다.
 *  그래서 caption 만 남기고 나머지 export-skip(액션 버튼·단락 구분 strip·표
 *  펼치기 토글 등)은 그대로 제외한다. */
async function downloadWidgetPng(blockId, label) {
  const el = document.getElementById(`block-${blockId}`)
  if (!el) throw new Error('캡처할 위젯 영역을 찾을 수 없습니다.')
  const html2canvas = (await import('html2canvas')).default
  const canvas = await html2canvas(el, {
    scale: 2,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    ignoreElements: (node) => {
      const skip = node?.dataset?.exportSkip
      return skip != null && skip !== 'caption'
    },
    // 클론 문서에서 color()/color-mix()/oklch() 를 rgb 로 바꿔, html2canvas 가
    // "unsupported color function" 으로 죽는 걸 막는다(비교표·토큰 배경 등).
    onclone: (doc) => {
      neutralizeUnsupportedColors(doc.getElementById(`block-${blockId}`))
    },
  })
  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  )
  if (!blob) throw new Error('이미지 생성에 실패했습니다.')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeFileName(label)}.png`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 일부 브라우저가 즉시 revoke 시 다운로드를 취소 → 잠시 뒤에 해제.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// 붙여넣은 표의 글자 크기 하한(pt). PPT 는 붙여넣은 HTML 의 px 글자를 작게
// 축소 해석하는 버그가 있어 px 가 아니라 pt 로 박아야 화면 크기를 따라온다.
// 그 위에 읽기 어려운 크기는 이 하한까지 끌어올린다.
const TABLE_COPY_MIN_FONT_PT = 11

// color-mix(in srgb, …) 는 브라우저 getComputedStyle 에서 최신 색 함수로
// resolve 된다 — 크롬은 color(srgb r g b / a) 형태로 돌려준다. 이 형식과
// rgb(a)/#hex 를 모두 {r,g,b,a}(a 0..1)로 파싱한다. (구버전 html2canvas·정규식
// 이 color() 를 못 읽어 배경 누락·이미지 캡처 오류가 났던 원인.)
function parseCssColorToRgba(str) {
  if (typeof str !== 'string') return null
  const s = str.trim().toLowerCase()
  if (!s || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  let m = s.match(/^rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) {
      return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 && Number.isFinite(p[3]) ? p[3] : 1 }
    }
    return null
  }
  // color(srgb r g b [/ a]) — r,g,b 는 0..1.
  m = s.match(/^color\(\s*srgb\s+([^)]+)\)/)
  if (m) {
    const [head, tail] = m[1].split('/')
    const rgb = head.trim().split(/\s+/).map(Number)
    const a = tail != null ? parseFloat(tail) : 1
    if (rgb.length >= 3 && rgb.slice(0, 3).every(Number.isFinite)) {
      return {
        r: Math.round(rgb[0] * 255),
        g: Math.round(rgb[1] * 255),
        b: Math.round(rgb[2] * 255),
        a: Number.isFinite(a) ? a : 1,
      }
    }
    return null
  }
  m = s.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      }
    }
  }
  return null
}

/** CSS 색 → '#rrggbb'. 셀 배경은 color-mix 로 만든 *반투명* 틴트(알파 0.16)라,
 *  흰 종이 위에 합성(알파 블렌딩)해 화면에 보이는 옅은 색을 그대로 낸다.
 *  완전 투명(알파 0)·파싱 실패는 null. */
function rgbToHex(color) {
  const c = parseCssColorToRgba(color)
  if (!c || c.a <= 0) return null
  const blend = (x) => Math.round(x * c.a + 255 * (1 - c.a))
  const h = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${h(blend(c.r))}${h(blend(c.g))}${h(blend(c.b))}`
}

/** px 폰트 → pt 문자열(하한 적용). 없으면 null. */
function pxToPtFont(fontSizeStr) {
  const px = parseFloat(fontSizeStr)
  if (!Number.isFinite(px) || px <= 0) return null
  return `${Math.max(Math.round(px * 0.75), TABLE_COPY_MIN_FONT_PT)}pt`
}

/** 클론 요소(들)에 원본의 *계산된* 텍스트 서식을 인라인으로 옮긴다.
 *  th/td 뿐 아니라 셀 안의 span·strong·em 등 모든 후손까지 훑어, 셀 안에서
 *  부분 적용된 색·굵기·기울임·밑줄까지 살린다(토큰 클래스는 외부 CSS 라
 *  붙여넣을 때 버려지므로 값으로 박아야 한다). 글자 크기는 하한을 적용해
 *  PPT·Word 에서 너무 작아지지 않게 한다. */
function inlineComputedTextStyles(origRoot, cloneRoot) {
  const origEls = [origRoot, ...origRoot.querySelectorAll('*')]
  const cloneEls = [cloneRoot, ...cloneRoot.querySelectorAll('*')]
  origEls.forEach((oe, i) => {
    const ce = cloneEls[i]
    if (!ce || ce.nodeType !== 1) return
    const cs = window.getComputedStyle(oe)
    if (cs.color) ce.style.color = cs.color
    // 배경은 color-mix → color(srgb …) 로 계산돼 Word·엑셀이 못 읽으므로,
    // 흰 위 합성한 hex 로 박는다(투명은 건너뜀).
    const bgHex = rgbToHex(cs.backgroundColor)
    if (bgHex) ce.style.backgroundColor = bgHex
    // 굵기는 600 이상일 때만 명시 — 400(보통)을 굳이 박지 않는다.
    if (Number(cs.fontWeight) >= 600) ce.style.fontWeight = cs.fontWeight
    if (cs.fontStyle && cs.fontStyle !== 'normal') ce.style.fontStyle = cs.fontStyle
    const deco = cs.textDecorationLine || cs.textDecoration
    if (deco && deco !== 'none') ce.style.textDecoration = deco
    const pt = pxToPtFont(cs.fontSize)
    if (pt) ce.style.fontSize = pt
    const tag = ce.tagName?.toLowerCase()
    if (tag === 'th' || tag === 'td') {
      ce.style.border = '1px solid #999'
      // 넉넉한 여백 — PPT 는 붙여넣은 표를 작게 배치하며 글자를 줄이는데,
      // 셀을 물리적으로 키우면(여백·행 높이) 축소가 덜하다.
      ce.style.padding = '8px 12px'
      ce.style.textAlign = cs.textAlign
      ce.style.verticalAlign = cs.verticalAlign || 'top'
    }
  })
}

/** PPT·Word 가 셀 단위로 확실히 수용하도록 셀(th/td)을 보강한다 — 두 가지가
 *  CSS inline 만으로는 잘 안 먹는다:
 *   1) 배경색: PPT 는 td 의 style="background-color" 를 무시하므로 레거시
 *      `bgcolor` 속성(hex)으로 박는다.
 *   2) 글자 크기: PPT 는 td 의 font-size 를 런(run)에 적용하지 않는다 — 특히
 *      "펼침" 모드의 평문 셀은 텍스트가 td 직속이라 감싸는 요소가 없다. 셀
 *      내용을 run <span>(font-size·색·굵기 보유)으로 감싸 런 단위로 박는다.
 *  origCell 의 computed 를 읽어 cloneCell 에 적용한다. */
function reinforceTableCell(origCell, cloneCell) {
  const cs = window.getComputedStyle(origCell)
  const bgHex = rgbToHex(cs.backgroundColor)
  if (bgHex) {
    cloneCell.setAttribute('bgcolor', bgHex)
    cloneCell.style.backgroundColor = bgHex
  }
  if (!cloneCell.childNodes.length) return
  const span = document.createElement('span')
  const pt = pxToPtFont(cs.fontSize)
  if (pt) span.style.fontSize = pt
  if (cs.color) span.style.color = cs.color
  if (Number(cs.fontWeight) >= 600) span.style.fontWeight = cs.fontWeight
  while (cloneCell.firstChild) span.appendChild(cloneCell.firstChild)
  cloneCell.appendChild(span)
}

/** 렌더된 표(#block-<id> 안의 <table>)를 HTML 그대로 클립보드에 복사한다.
 *  선택영역 + execCommand('copy') 트릭 — text/html 과 text/plain 을 함께
 *  올려, PPT·Word 엔 "표"로, 엑셀엔 "셀"로 붙는다. ClipboardItem(text/html)
 *  과 달리 secure-context 가 필요 없어 HTTP 에서도 동작한다.
 *  화면 표가 깜빡이지 않도록 클론을 화면 밖에서 선택한다. 붙여넣을 때 표
 *  모양(색·테두리·글자 서식·크기)이 살도록 셀과 그 안 요소에 인라인 스타일을
 *  입힌다. 성공 시 true. */
function copyRenderedTableHtml(blockId) {
  // 보이는 표를 골라야 한다 — autoFit mirror(숨김 복제본)를 뜨면 화면과
  // 다른(작은/빈) 표가 복사된다.
  const table = findVisibleInBlock(blockId, 'table')
  if (!table) return false
  const clone = table.cloneNode(true)
  clone.style.borderCollapse = 'collapse'
  // 표 폭(화면 렌더 폭)을 픽셀로 못박는다 — Word·엑셀엔 화면과 같은 비율로
  // 들어가고, PPT 도 HTML 표의 픽셀 크기를 보고 배치하므로 폭이 클수록 덜
  // 줄어든다(왜곡 방지로 화면 폭 그대로, 억지 확대는 안 한다).
  const renderedW = Math.round(table.getBoundingClientRect?.().width || 0)
  if (renderedW > 0) {
    clone.setAttribute('width', String(renderedW))
    clone.style.width = `${renderedW}px`
  }
  // 배경/글자색/굵기/기울임/밑줄/정렬/크기는 토큰 클래스로 입혀져 있어 HTML 을
  // 붙여넣으면(PPT·Word 가 외부 CSS 를 버리므로) 사라진다. 원본의 *계산된*
  // 스타일을 클론에 인라인으로 옮겨 붙여넣을 때 표 모양이 살게 한다. (셀 안
  // 부분 서식까지 살리려고 모든 후손을 훑는다.)
  inlineComputedTextStyles(table, clone)
  // 셀 단위 보강 — PPT 가 무시하는 배경(→bgcolor 속성)·글자 크기(→run span)를
  // 다시 박는다. inline 패스 *뒤*에 해야 자식 구조를 흩뜨려도 정렬이 안 깨진다.
  const origCells = table.querySelectorAll('th,td')
  const cloneCells = clone.querySelectorAll('th,td')
  origCells.forEach((oc, i) => {
    const cc = cloneCells[i]
    if (cc) reinforceTableCell(oc, cc)
  })
  // compact 모드 셀은 본문을 숨은 tooltip span 으로 한 번 더 들고 있어, 그대로
  // 두면 붙여넣을 때 같은 글자가 두 번 나온다. 인라인/보강(인덱스 정렬) 패스가
  // 끝난 *뒤* 클론에서만 제거한다.
  clone.querySelectorAll('[role="tooltip"]').forEach((n) => n.remove())
  const holder = document.createElement('div')
  holder.style.position = 'fixed'
  holder.style.left = '-9999px'
  holder.style.top = '0'
  holder.appendChild(clone)
  document.body.appendChild(holder)
  try {
    const range = document.createRange()
    range.selectNodeContents(holder)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const ok = document.execCommand('copy')
    sel.removeAllRanges()
    return ok
  } catch {
    return false
  } finally {
    document.body.removeChild(holder)
  }
}

/** 뷰 모드 카드의 복사 버튼 핸들러.
 *  - 긴 글: 텍스트로 클립보드 복사 (HTTP-safe).
 *  - 표: 렌더된 HTML 표로 복사 → PPT·Word 엔 표, 엑셀엔 셀. 실패 시 TSV 폴백.
 *  - 차트/산점도: PNG 다운로드 (HTTP 에선 이미지 클립보드 불가). */
export async function copyWidget({ type, content, blockId, label }) {
  try {
    if (IMAGE_TYPES.has(type)) {
      await downloadWidgetPng(blockId, label || content?.caption || type)
      toast.success('이미지로 저장했습니다 (PNG).')
      return
    }
    if (TABLE_TYPES.has(type)) {
      if (copyRenderedTableHtml(blockId)) {
        toast.success('표를 복사했습니다 — PPT·Word엔 표로, 엑셀엔 셀로 붙여넣기.')
        return
      }
      // 폴백: 렌더된 표를 못 찾으면 데이터로 만든 TSV 텍스트.
      const tsv = tableToTsvText(content)
      if (!tsv.trim()) {
        toast.info('복사할 내용이 없습니다.')
        return
      }
      await copyTextToClipboard(tsv)
      toast.success('표를 복사했습니다 (엑셀 등에 붙여넣기).')
      return
    }
    const text = widgetToPlainText(type, content, blockId)
    if (!text.trim()) {
      toast.info('복사할 내용이 없습니다.')
      return
    }
    await copyTextToClipboard(text)
    toast.success('글을 복사했습니다.')
  } catch (e) {
    toast.error('복사 실패', { description: String(e?.message ?? e) })
  }
}

/** 표(또는 임의 위젯)를 화면 그대로 PNG 로 저장. HTML 표 복사는 PPT 가 글자를
 *  줄여버려 화면과 어긋나므로, "화면 그대로"가 필요할 때 쓰는 별도 버튼용.
 *  차트와 같은 캡처 경로(캡션 포함). */
export async function downloadWidgetImage({ blockId, content, label }) {
  try {
    await downloadWidgetPng(blockId, label || content?.caption || 'table')
    toast.success('표를 이미지(PNG)로 저장했습니다 — PPT·Word에 붙여넣기.')
  } catch (e) {
    toast.error('이미지 저장 실패', { description: String(e?.message ?? e) })
  }
}
