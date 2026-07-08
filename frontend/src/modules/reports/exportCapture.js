/** 내보내기(PPT 등)용 공용 위젯 캡처 — html2canvas 로 위젯 DOM 을 PNG 로 뜬다.
 *
 *  두 가지 방어가 들어있다(위젯 복사 widgetCopy.js 와 같은 사유):
 *   1) color()/color-mix()/oklch() 등 최신 색 함수 → rgb 로 인라인 치환.
 *      구버전 html2canvas 가 이 함수를 못 파싱하면 "unsupported color
 *      function" 으로 캡처가 통째로 실패한다(토큰 배경·비교표 등).
 *   2) 캡션은 살리고(그림 N/표 N 이 이미지에 포함), 액션 버튼·진행률 오버레이
 *      ·표 펼치기 토글 등 화면 전용 chrome 은 제외한다.
 */
// html2canvas-pro: 유지보수되는 드롭인 포크. flex/grid `gap` 을 실제로 렌더하고
// (구 html2canvas 1.4.1 은 gap 을 무시해 요소 간격이 붙어버렸다) 하단 클리핑·
// 최신 색 함수(oklch/color())도 개선됐다. API 는 동일.
import html2canvas from 'html2canvas-pro'

/** 파일명 정규화 — OS 금지문자 제거 + 80자 컷. (exportReportToDocx 와 동일
 *  로직이지만 여기로 옮겨, PPT 내보내기가 무거운 docx 라이브러리를 끌어오지
 *  않도록 한다.) */
export function sanitizeFileName(name) {
  return (
    String(name || '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim()
      .slice(0, 80) || 'report'
  )
}

/** Blob 다운로드 트리거. revoke 는 다운로드 fetch 가 끝나도록 넉넉히 늦춘다. */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// rgb(a)/color(srgb …)/#hex → {r,g,b,a}. color-mix 는 getComputedStyle 에서
// color(srgb …) 로 resolve 돼 들어온다.
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

/** CSS 색 문자열 → 'RRGGBB'(# 없음, pptxgenjs 형식). compositeWhite=true 면
 *  반투명색을 흰 배경 위에 합성(셀 배경 틴트용). 투명/파싱 실패는 null. */
export function cssColorToHex(str, { compositeWhite = false } = {}) {
  const c = parseCssColorToRgba(str)
  if (!c || c.a <= 0) return null
  let { r, g, b } = c
  if (compositeWhite && c.a < 1) {
    const blend = (x) => x * c.a + 255 * (1 - c.a)
    r = blend(r)
    g = blend(g)
    b = blend(b)
  }
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return (h(r) + h(g) + h(b)).toUpperCase()
}

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

/** 클론 문서의 root 하위에서 최신 색 함수를 rgb(a) 로 인라인 치환한다.
 *  html2canvas onclone 에서 호출 — 클론에만 손대니 화면은 안 바뀐다. */
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

/** 위젯 DOM 엘리먼트를 PNG 캔버스로 캡처. 화면 전용 chrome 은 제외.
 *  region 을 주면 그 영역(엘리먼트 좌상단 기준 CSS px, 음수 가능)을 캡처한다 —
 *  translate/absolute 로 박스 밖에 삐져나온 요소(마일스톤 라벨 등)까지 담으려고
 *  넘친 만큼 넓혀 캡처할 때 쓴다.
 *  hideCaption=true 면 캡션(그림/표 N)을 visibility:hidden 으로 **자리는 두되 안
 *  보이게** 한다(호출부가 캡션을 네이티브 텍스트박스로 따로 얹을 때 — 이미지엔 빈
 *  자리만 남아 위젯 비율이 그대로 유지된다). 기본은 캡션 포함.
 *  반환: html2canvas 캔버스(호출부에서 toDataURL + 가로/세로 사용). */
export async function captureBlockToCanvas(
  blockEl,
  { scale = 2, region = null, hideCaption = false } = {},
) {
  if (!blockEl) throw new Error('캡처할 위젯 엘리먼트가 없습니다.')
  const id = blockEl.id || null
  return html2canvas(blockEl, {
    scale,
    ...(region
      ? { x: region.x, y: region.y, width: region.width, height: region.height }
      : {}),
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    ignoreElements: (node) => {
      // 진행률 오버레이는 캡처에 끼면 안 됨.
      if (node?.dataset?.exportOverlay != null) return true
      // export-skip 중 caption 만 남기고(이미지에 캡션 포함) 나머지는 제외.
      const skip = node?.dataset?.exportSkip
      return skip != null && skip !== 'caption'
    },
    onclone: (doc) => {
      const target = (id && doc.getElementById(id)) || doc.body
      neutralizeUnsupportedColors(target)
      if (hideCaption && target.querySelectorAll) {
        // 캡션은 자리(레이아웃)는 유지하고 렌더만 숨긴다 → 이미지엔 빈 공간.
        for (const cap of target.querySelectorAll('[data-export-skip="caption"]')) {
          if (!cap.closest('.report-autofit-mirror')) cap.style.visibility = 'hidden'
        }
      }
    },
  })
}
