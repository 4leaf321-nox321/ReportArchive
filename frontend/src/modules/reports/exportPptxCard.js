/** 카드 위젯 → pptxgenjs 네이티브 도형 변환 (PPT 내보내기).
 *
 *  카드는 "PPT 식 보고서"를 쓰라고 만든 위젯이라, 정작 PPT 에 죽은 그림으로
 *  나가면 목적이 어긋난다. 그래서 이미지 캡처가 아니라 **편집 가능한 네이티브
 *  요소**로 낸다:
 *    · 카드 몸통 = fill + line + 둥근 모서리를 준 텍스트박스 하나
 *      (eyebrow/제목/KPI/본문/각주를 breakLine 런으로 쌓는다)
 *    · 아이콘   = 화면에 이미 그려진 SVG 를 PNG 로 구워 위에 얹는다
 *    · 배지     = 우상단에 작은 fill 텍스트박스
 *
 *  아이콘만 이미지인 이유: pptxgenjs 는 SVG 를 네이티브 도형으로 못 넣는다.
 *  글자·배경·테두리는 전부 네이티브라 PPT 에서 그대로 고칠 수 있다.
 *
 *  색은 화면과 같은 rt-c-* 토큰에서 굽는다 — 솔리드(filled/banner)는 밴드와
 *  동일한 bandBgHex + 자동 대비 글자색, 옅은 변형(soft/outline)은 highlightHex
 *  (40% 색 + 60% 흰색)로 화면의 틴트에 대응시킨다. 슬라이드는 흰 배경이라
 *  라이트모드 색이 맞다(exportPptxText 와 같은 사유).
 */
import { bandBgHex, bandTextHex, highlightHex } from '@/shared/text-color'

/** 이 모듈이 처리하는 위젯 타입. */
export const NATIVE_CARD_TYPES = new Set(['card'])

const BADGE_TONE_TOKEN = {
  success: 'green',
  info: 'blue',
  warn: 'amber',
  neutral: 'gray',
}

const DEPTH_PREFIX = ['■', '–', '·', '·', '·', '·']

/** 화면 px → PPT pt(정수). 너무 작아지지 않게 하한을 둔다. */
function pt(px, ptPerPx, min = 8) {
  return Math.max(min, Math.round(px * ptPerPx))
}

/**
 * 화면에 그려진 <svg> 를 PNG data URL 로 굽는다. `color` 로 stroke 를 덮어써
 * (lucide 는 currentColor 를 쓰므로) 카드 배경 위에서 보이는 색을 고정한다.
 * 실패하면 null — 호출부가 아이콘 없이 진행한다(카드 자체는 살린다).
 */
async function svgToPngDataUrl(svgEl, sizePx, color) {
  try {
    const clone = svgEl.cloneNode(true)
    clone.setAttribute('width', String(sizePx))
    clone.setAttribute('height', String(sizePx))
    // currentColor 를 실제 색으로 고정 — 캔버스엔 상속할 부모가 없다.
    clone.setAttribute('stroke', color)
    clone.setAttribute('fill', 'none')
    const xml = new XMLSerializer().serializeToString(clone)
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
    const img = new Image()
    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = reject
    })
    img.src = svgUrl
    await loaded
    // 2배로 구워 PPT 확대 시 뭉개지지 않게.
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = sizePx * scale
    canvas.height = sizePx * scale
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/**
 * 카드 본문 런 배열을 만든다. pptxgenjs 는 한 텍스트박스 안에서 런마다 크기·
 * 굵기·색을 달리 줄 수 있어, 카드 한 장이 텍스트박스 하나로 들어간다.
 */
function buildCardRuns(content, { ptPerPx, basePx, fg, accentHex }) {
  const runs = []
  const line = (text, options) => runs.push({ text, options: { ...options, breakLine: true } })

  if (content?.eyebrow) {
    line(content.eyebrow, {
      bold: true,
      fontSize: pt(basePx * 0.7, ptPerPx),
      color: fg || accentHex || '666666',
    })
  }
  if (content?.title) {
    line(content.title, {
      bold: true,
      fontSize: pt(basePx * 1.1, ptPerPx, 10),
      color: fg || '000000',
    })
  }

  const statValue = content?.stat?.value
  if (statValue != null && String(statValue) !== '') {
    // KPI 는 값과 단위가 같은 줄 — 값만 크게, 단위는 본문 크기로.
    runs.push({
      text: String(statValue),
      options: { bold: true, fontSize: pt(basePx * 2, ptPerPx, 16), color: fg || '000000' },
    })
    if (content.stat.unit) {
      runs.push({
        text: ` ${content.stat.unit}`,
        options: { fontSize: pt(basePx * 0.85, ptPerPx), color: fg || '666666' },
      })
    }
    runs[runs.length - 1].options.breakLine = true
  }

  const items = Array.isArray(content?.body?.items) ? content.body.items : []
  for (const it of items) {
    const text = (it?.text ?? '').trim()
    if (!text) continue
    const depth = Math.max(0, Math.min(5, it?.depth ?? 0))
    line(`${DEPTH_PREFIX[depth] || '·'} ${text}`, {
      fontSize: pt(basePx * 0.9, ptPerPx),
      color: fg || '333333',
      // PPT 의 들여쓰기 — 깊이당 한 단계.
      indentLevel: depth,
    })
  }

  if (content?.footnote) {
    line(content.footnote, {
      italic: true,
      fontSize: pt(basePx * 0.7, ptPerPx),
      color: fg || '666666',
    })
  }
  return runs
}

/**
 * 카드를 네이티브 도형으로 배치한다. 성공하면 true, 실패하면 false(호출부가
 * 이미지 폴백). 캡션 박스는 카드가 확정된 뒤에만 얹어 폴백 시 중복을 막는다.
 *
 * @param addCaptionBox 호출부(exportReportToPptx)의 캡션 배치 함수 — 캡션 규약을
 *   한 곳에 두려고 주입받는다.
 */
export async function tryAddNativeCard(
  slide,
  meta,
  content,
  el,
  pos,
  ptPerPx,
  caption,
  addCaptionBox,
  { fontFace, basePx = 18 } = {},
) {
  try {
    const variant = content?.variant ?? meta?.props?.default_variant ?? 'soft'
    const accent = content?.accent ?? meta?.props?.default_accent ?? 'slate'
    const solid = variant === 'filled' || variant === 'banner'
    const accentHex = bandBgHex(accent)
    const fillHex = solid ? accentHex : highlightHex(accent)
    const fg = solid ? bandTextHex(accent) : null

    const runs = buildCardRuns(content, { ptPerPx, basePx, fg, accentHex })
    // 아이콘만 있고 글이 하나도 없는 카드는 네이티브로 낼 게 없다 → 이미지 폴백.
    if (!runs.length) return false

    const capH = addCaptionBox(slide, caption, pos, ptPerPx)
    const bodyY = caption?.below ? pos.y : pos.y + capH
    const bodyH = Math.max(0.2, pos.h - capH)

    // 아이콘이 있으면 그 높이만큼 글을 아래로 밀어 겹치지 않게 한다.
    const iconSvg = el?.querySelector?.('[data-card-icon] svg') ?? null
    const iconIn = iconSvg ? Math.min(0.28, bodyH * 0.22) : 0
    const padIn = 0.08

    // 1) 카드 몸통 — fill + 테두리 + 둥근 모서리를 준 텍스트박스(네이티브 도형).
    slide.addText(runs, {
      x: pos.x,
      y: bodyY,
      w: pos.w,
      h: bodyH,
      valign: 'top',
      wrap: true,
      fontFace,
      margin: 6,
      // outline 은 배경 없이 테두리만, 나머지는 배경색.
      ...(variant === 'outline'
        ? {}
        : fillHex
          ? { fill: { color: fillHex } }
          : {}),
      ...(accentHex
        ? {
            line: {
              color: accentHex,
              width: variant === 'outline' ? 1.5 : 0.75,
            },
          }
        : {}),
      rectRadius: 0.04,
      // 아이콘 자리만큼 첫 줄을 내린다(텍스트박스 안쪽 상단 여백).
      ...(iconIn ? { inset: iconIn } : {}),
    })

    // 2) 아이콘 — SVG 를 PNG 로 구워 좌상단에 얹는다(몸통 뒤에 add → 위에 보인다).
    if (iconSvg) {
      const iconColor = `#${fg || accentHex || '333333'}`
      const png = await svgToPngDataUrl(iconSvg, 48, iconColor)
      if (png) {
        slide.addImage({
          data: png,
          x: pos.x + padIn,
          y: bodyY + padIn,
          w: iconIn * 0.7,
          h: iconIn * 0.7,
        })
      }
    }

    // 3) 배지 — 우상단 작은 알약. 카드 색과 독립(완료=초록 등).
    const badgeText = content?.badge?.text
    if (badgeText) {
      const toneHex = bandBgHex(BADGE_TONE_TOKEN[content.badge.tone] ?? 'gray')
      const bw = Math.min(pos.w * 0.4, 0.12 + String(badgeText).length * 0.075)
      const bh = Math.min(0.22, bodyH * 0.2)
      slide.addText([{ text: String(badgeText), options: { bold: true, fontSize: pt(basePx * 0.6, ptPerPx), color: 'FFFFFF' } }], {
        x: pos.x + pos.w - bw - padIn,
        y: bodyY + padIn,
        w: bw,
        h: bh,
        align: 'center',
        valign: 'middle',
        fontFace,
        margin: 0,
        ...(toneHex ? { fill: { color: toneHex } } : {}),
        rectRadius: 0.1,
      })
    }
    return true
  } catch (e) {
    console.warn('PPT 네이티브 카드 변환 실패 — 이미지로 대체합니다.', e)
    return false
  }
}
