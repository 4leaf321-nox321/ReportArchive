/** 보고서 → PowerPoint(.pptx) 내보내기.
 *
 *  보고서는 "폭 고정·세로로 흐르는 12열 그리드"이고 PPT 는 "고정 크기 슬라이드"라:
 *    1) 위젯을 '행 그룹'으로 묶고(멀티컬럼 유지) 실제 렌더 높이 기준으로 슬라이드
 *       단위로 나눈다(groupRowsByRenderHeight). 편집 가이드(SlideGuideOverlay)는
 *       뷰 높이로 근사 표시하지만 분할 규칙·예산은 공유한다.
 *    2) 그리드 폭 → 슬라이드 폭(full-bleed)으로 매핑해 배치(페이지마다 새 슬라이드).
 *       덱 전체가 **같은 스케일**이라 같은 위젯이 슬라이드마다 크기가 달라지지 않고
 *       화면에서 본 비율 그대로 나온다. 슬라이드보다 길면 통째로 줄이지 않고 넘친
 *       행을 다음 슬라이드로 넘긴다(짧으면 아래에 자연스러운 여백).
 *    3) 유일한 예외 — 한 행(거대 위젯) 자체가 슬라이드보다 크면 넘길 곳이 없어
 *       그 슬라이드만 맞춤 축소(가로 가운데)한다.
 *
 *  위젯 처리(Phase 2):
 *    - 글 위젯(heading/rich_text/bulleted_list/key_value) → 편집 가능한
 *      네이티브 PPT 텍스트박스(색·굵기·기울임·밑줄·글머리·들여쓰기 유지).
 *    - 그 외(표·차트·다이어그램·수식·이미지 등) → html2canvas PNG.
 *
 *  호출 전 제약(호출부 ReportDetailPage 가 보장):
 *   - printing=true → 모든 페이지가 읽기전용·all 뷰로 DOM 에 렌더됨
 *   - 차트 렌더 안정화 대기 완료 / (권장) 라이트 테마 강제
 */
import {
  captureBlockToCanvas,
  sanitizeFileName,
  triggerDownload,
} from './exportCapture'
import { NATIVE_TEXT_TYPES, buildPptxText, readBasePx } from './exportPptxText'
import { NATIVE_TABLE_TYPES, buildPptxTable } from './exportPptxTable'
import { NATIVE_CARD_TYPES, tryAddNativeCard } from './exportPptxCard'
import { COLOR_TOKENS, bandBgHex, bandTextHex } from '@/shared/text-color'

// 색 토큰 → 라이트 swatch hex(# 제외). PPT 는 다크모드가 없어 라이트 hex 를 쓴다.
const _TOKEN_HEX = Object.fromEntries(
  COLOR_TOKENS.filter((c) => c.token && c.swatch).map((c) => [
    c.token,
    c.swatch.replace('#', ''),
  ]),
)

/** content.bordered/border_width/border_color → pptxgenjs 표 border 옵션. */
function pptxTableBorder(content) {
  if (!content || content.bordered !== true) return { type: 'none' }
  const pt = { 1: 0.75, 2: 1.5, 3: 2.25 }[content.border_width] || 0.75
  const color = _TOKEN_HEX[content.border_color] || 'B0B0B0'
  return { type: 'solid', pt, color }
}
import {
  groupRowsByRenderHeight,
  measureSlideRows,
  SLIDE_MARGIN_FRAC,
  slideHeightPx as slideHeightPxFor,
} from './slideLayout'

// 슬라이드 물리 크기(인치). PowerPoint 2013+ 기본은 16:9(13.333×7.5).
const SLIDE_SIZES = {
  '16:9': { w: 13.333, h: 7.5 },
  '4:3': { w: 10, h: 7.5 },
  '16:10': { w: 12.5, h: 7.8125 },
}
const DEFAULT_RATIO = '16:9'
const TEXT_FONT = '맑은 고딕' // 네이티브 텍스트 기본 글꼴(한글 대응)

// 폰트 크기 기준 그리드 폭(px). 폰트를 **캔버스 폭과 무관하게** 만든다:
// 실제 그리드 폭이 아니라 항상 이 기준 폭에서 재는 것처럼 pt 를 계산하므로
// (fontNorm = gridWidthPx/이값 을 곱하면 gridWidthPx 가 상쇄됨) →
//   폰트 pt = 화면px × (콘텐츠폭 / FONT_REF_GRID_PX) × 72 × scale
// 즉 26px 제목은 디자인 폭이 1024든 2000이든 항상 같은 pt 가 나온다.
// 값은 기본 캔버스(≈1024 폭−패딩)에 맞춰, 기존 기본-폭 보고서는 거의 불변.
// ↑키우려면 값을 낮추고, ↓줄이려면 높인다. 위젯 박스 크기는 안 바뀌므로 너무
// 키우면 글 많은 박스가 아래로 넘칠 수 있다.
const FONT_REF_GRID_PX = 1000

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

function lookupTemplate(pageTemplateMap, page) {
  if (!page || !pageTemplateMap) return null
  const key = `${page.template_id}@${page.template_version}`
  return typeof pageTemplateMap.get === 'function'
    ? pageTemplateMap.get(key) ?? null
    : pageTemplateMap[key] ?? null
}

/** 페이지의 blockId → { type, props } 맵. 템플릿 스키마 블록 + extra_blocks.
 *  (DOCX 의 combinedBlocks 와 같은 출처지만, 여기선 docx 라이브러리를 끌어오지
 *  않으려 최소 정보만 직접 모은다. content 는 page.content[id] 에서 따로.) */
function buildBlockMeta(template, page) {
  const map = new Map()
  const tplBlocks = Array.isArray(template?.schema?.blocks)
    ? template.schema.blocks
    : []
  for (const b of tplBlocks) {
    if (b?.id) map.set(b.id, { type: b.type, props: b.props ?? {} })
  }
  for (const b of page?.extra_blocks ?? []) {
    if (b?.id) map.set(b.id, { type: b.type, props: b.props ?? {} })
  }
  return map
}

/** 페이지별 그리드 측정 + draft.page 매핑. 행 그룹/뷰높이는 slideLayout 공용
 *  로직(measureSlideRows)을 써서 편집 가이드와 *완전히 동일한 기준*으로 묶는다.
 *  draft.pages 와는 section#report-page-N 의 N 으로 짝지어 누락 페이지가 있어도
 *  어긋나지 않게 한다. */
function gatherPages(draft) {
  const pageEls = Array.from(document.querySelectorAll('.report-detail-page'))
  return pageEls.map((pageEl) => {
    const m = (pageEl.id || '').match(/report-page-(\d+)/)
    const pageIdx = m ? Number(m[1]) : null
    const page = pageIdx != null ? draft?.pages?.[pageIdx] : null
    const grid = pageEl.querySelector('.react-grid-layout') || pageEl
    const { gridWidthPx, rows } = measureSlideRows(grid, 0)
    return { page, gridWidthPx, rows }
  })
}

/** 위젯의 *보이는* 캡션(제목) — 렌더된 텍스트 그대로(번호 "그림/표 N" + 라벨
 *  자동채움 포함). 네이티브 위젯(표·글)은 캡처 이미지가 아니라서 캡션이 빠지므로,
 *  이걸 읽어 위에 별도 텍스트박스로 얹는다. mirror 의 캡션은 제외. */
function readVisibleCaption(blockEl) {
  const els = blockEl.querySelectorAll('[data-export-skip="caption"]')
  let capEl = null
  for (const e of els) {
    if (!e.closest('.report-autofit-mirror')) {
      capEl = e
      break
    }
  }
  if (!capEl) return null
  const text = (capEl.innerText ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const r = capEl.getBoundingClientRect()
  const fontPx = parseFloat(window.getComputedStyle(capEl).fontSize) || 14
  // 헤더가 본문 아래(caption_position='below')인지 — 캡션 박스가 블록 세로
  // 중간선보다 아래에 있으면 below 로 본다(content 를 안 들고도 DOM 으로 판단).
  const blockRect = blockEl.getBoundingClientRect()
  const below = blockRect.height > 0 && r.top > blockRect.top + blockRect.height / 2
  // 블록 상단 기준 캡션의 top/bottom(px) — 이미지 폴백에서 캡션 영역을 크롭해
  // '내용만' 남길 때 쓴다.
  return {
    text,
    heightPx: r.height || 0,
    fontPx,
    below,
    topPx: r.top - blockRect.top,
    bottomPx: r.bottom - blockRect.top,
  }
}

/** 캡션 텍스트박스를 위젯 영역 상단(기본) 또는 하단(below)에 얹고, 차지한
 *  높이(인치)를 돌려준다. 캡션 없으면 0. */
function addCaptionBox(slide, caption, pos, ptPerPx) {
  if (!caption?.text) return 0
  const capH = Math.max(0.18, Math.min(pos.h * 0.6, (caption.heightPx * ptPerPx) / 72))
  const y = caption.below ? pos.y + pos.h - capH : pos.y
  slide.addText(
    [{ text: caption.text, options: { bold: true, fontSize: Math.max(9, Math.round(caption.fontPx * ptPerPx)) } }],
    { x: pos.x, y, w: pos.w, h: capH, valign: 'top', wrap: true, fontFace: TEXT_FONT, margin: 1 },
  )
  return capH
}

/** 캡션·화면전용(export-skip/overlay) 요소를 뺀 '내용' 요소들이 블록 박스를 넘는
 *  최대 넘침(px, 상하좌우 ≥0). translate/absolute 로 박스 밖으로 나간 라벨(마일스톤
 *  아래 라벨 등)을 캡처에 포함시키기 위한 여백. 과도 방지로 각 변 블록 크기까지. */
function measureContentOverflow(blockEl, rect) {
  let top = 0
  let right = 0
  let bottom = 0
  let left = 0
  for (const el of blockEl.querySelectorAll('*')) {
    if (el.closest('[data-export-skip], [data-export-overlay]')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    top = Math.max(top, rect.top - r.top)
    right = Math.max(right, r.right - rect.right)
    bottom = Math.max(bottom, r.bottom - rect.bottom)
    left = Math.max(left, rect.left - r.left)
  }
  const cap = Math.max(rect.width, rect.height)
  return {
    top: Math.min(cap, Math.max(0, Math.ceil(top))),
    right: Math.min(cap, Math.max(0, Math.ceil(right))),
    bottom: Math.min(cap, Math.max(0, Math.ceil(bottom))),
    left: Math.min(cap, Math.max(0, Math.ceil(left))),
  }
}

/** 이미지 폴백 위젯 캡처. 캡션(그림/표 N)은 호출부가 네이티브 텍스트박스로 따로
 *  얹으므로 여기선 캡션을 **자리만 두고 안 보이게**(hideCaption) 떠서, 위젯 비율을
 *  그대로 유지한다(크롭 안 함 → 늘어짐·잘림 없음). 박스 밖으로 삐져나온 요소는
 *  넘친 만큼 캡처 영역을 넓혀 담는다. 반환: { canvas, rect } — rect 는 캔버스가 덮는
 *  영역(블록 좌상단 기준 px)이라 호출부가 그대로 슬라이드에 매핑해 배치한다. */
async function captureContentCanvas(blockEl, caption) {
  const rect = blockEl.getBoundingClientRect()
  const w = rect.width
  const h = rect.height
  const hideCaption = !!(caption && caption.heightPx > 0)
  if (!(w > 0) || !(h > 0)) {
    const canvas = await captureBlockToCanvas(blockEl, { scale: 2, hideCaption })
    return { canvas, rect: { left: 0, top: 0, width: w, height: h } }
  }
  const ov = measureContentOverflow(blockEl, rect)
  const useRegion = ov.top > 1 || ov.right > 1 || ov.bottom > 1 || ov.left > 1
  const region = useRegion
    ? { x: -ov.left, y: -ov.top, width: w + ov.left + ov.right, height: h + ov.top + ov.bottom }
    : null
  const canvas = await captureBlockToCanvas(blockEl, {
    scale: 2,
    hideCaption,
    ...(region ? { region } : {}),
  })
  const cover = region
    ? { left: -ov.left, top: -ov.top, width: w + ov.left + ov.right, height: h + ov.top + ov.bottom }
    : { left: 0, top: 0, width: w, height: h }
  return { canvas, rect: cover }
}

/** 글 위젯을 네이티브 텍스트박스로 배치 시도(+ 캡션 박스). 성공/빈내용은
 *  true(이미지 생략), 오류면 false(이미지 폴백). */
function tryAddNativeText(slide, meta, content, el, pos, ptPerPx, caption) {
  try {
    const basePx = readBasePx(el) ?? 18
    // 절 번호 — 렌더된 heading DOM 의 [data-heading-number] 를 읽어 넘긴다(캡션과
    // 동일하게 화면 계산 결과를 그대로 사용 → PPTX 에 별도 index 계산 불필요).
    const headingNumber =
      meta.type === 'heading'
        ? el?.querySelector?.('[data-heading-number]')?.textContent?.trim() || null
        : null
    const runs = buildPptxText(
      { type: meta.type, props: meta.props, content, headingNumber },
      { ptPerPx, basePx },
    )
    const capH = addCaptionBox(slide, caption, pos, ptPerPx)
    // 헤더가 아래면 본문은 위에서 시작, 위면 캡션 높이만큼 내려서 시작.
    const bodyY = caption?.below ? pos.y : pos.y + capH
    // 제목 배경 밴드(PPT 섹션 헤더) — 텍스트박스 fill + 대비 글자색.
    const bandTok =
      meta.type === 'heading'
        ? content?.bg_color ?? meta.props?.bg_color ?? null
        : null
    const bandBg = bandTok ? bandBgHex(bandTok) : null
    const bandFg = bandTok
      ? bandTextHex(bandTok, content?.bg_text ?? meta.props?.bg_text)
      : null
    if (runs && runs.length) {
      const finalRuns = bandFg
        ? runs.map((r) => ({ ...r, options: { ...r.options, color: bandFg } }))
        : runs
      slide.addText(finalRuns, {
        x: pos.x,
        y: bodyY,
        w: pos.w,
        h: Math.max(0.2, pos.h - capH),
        valign: 'top',
        wrap: true,
        fontFace: TEXT_FONT,
        margin: 2,
        ...(bandBg ? { fill: { color: bandBg } } : {}),
      })
    }
    return true
  } catch (e) {
    console.warn('PPT 네이티브 텍스트 변환 실패 — 이미지로 대체합니다.', e)
    return false
  }
}

/** 표 위젯을 네이티브 PPT 표로 배치 시도(+ 캡션 박스). 이미지 셀이 있거나
 *  오류면 false(이미지 폴백). 캡션 박스는 표가 네이티브로 확정된 뒤에만 얹어
 *  이미지 폴백 시 캡션 중복을 막는다. */
function tryAddNativeTable(slide, el, pos, ptPerPx, caption, border = { type: 'none' }) {
  try {
    const built = buildPptxTable(el, { ptPerPx, tableWidthIn: pos.w })
    if (!built || !built.rows.length) return false
    const capH = addCaptionBox(slide, caption, pos, ptPerPx)
    // 헤더가 아래면 표는 위에서 시작, 위면 캡션 높이만큼 내려서 시작.
    const bodyY = caption?.below ? pos.y : pos.y + capH
    slide.addTable(built.rows, {
      x: pos.x,
      y: bodyY,
      w: pos.w,
      h: Math.max(0.2, pos.h - capH),
      colW: built.colW,
      // 격자 테두리 옵션(content.bordered/border_width/border_color)에 맞춤 —
      // 켜면 굵기·색 격자선, 끄면 무테두리(화면 기본 형태에 더 가깝게).
      border,
      valign: 'middle',
      fontFace: TEXT_FONT,
      autoPage: false,
      margin: 2,
    })
    return true
  } catch (e) {
    console.warn('PPT 네이티브 표 변환 실패 — 이미지로 대체합니다.', e)
    return false
  }
}

export async function exportReportToPptx({
  draft,
  pageTemplateMap,
  slide = {},
  onProgress,
  signal,
} = {}) {
  const ratio = SLIDE_SIZES[slide.ratio] ? slide.ratio : DEFAULT_RATIO
  const dim = SLIDE_SIZES[ratio]
  // 상하좌우 여백(동일 인치 = 폭 × SLIDE_MARGIN_FRAC). 콘텐츠는 슬라이드 전체가
  // 아니라 여백을 뺀 안쪽 영역에 배치한다(좌상단 딱 붙음 방지). slideHeightPx 의
  // 높이 예산도 같은 여백을 반영하므로 가이드와 분할 기준이 일치한다.
  const margin = dim.w * SLIDE_MARGIN_FRAC
  const contentW = dim.w - 2 * margin

  const pages = gatherPages(draft).filter((p) => p.rows.length > 0)
  const totalBlocks = pages.reduce(
    (s, p) => s + p.rows.reduce((n, r) => n + r.blocks.length, 0),
    0,
  )
  if (totalBlocks === 0) throw new Error('내보낼 위젯이 없습니다.')

  onProgress?.({ phase: 'load', current: 0, total: totalBlocks, label: '내보내기 모듈 로드 중...' })
  const PptxGenJS = (await import('pptxgenjs')).default
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'RA_LAYOUT', width: dim.w, height: dim.h })
  pptx.layout = 'RA_LAYOUT'

  let done = 0
  onProgress?.({ phase: 'capture', current: 0, total: totalBlocks, label: '슬라이드 변환 준비 중...' })

  for (const pg of pages) {
    throwIfAborted(signal)
    const template = lookupTemplate(pageTemplateMap, pg.page)
    const blockMeta = buildBlockMeta(template, pg.page)
    const content = pg.page?.content ?? {}

    // 편집 가이드와 동일 기준: 여백 반영 콘텐츠영역 높이 예산 + mirror 뷰 높이.
    const slideH = slideHeightPxFor(pg.gridWidthPx, ratio)
    if (!Number.isFinite(slideH) || slideH <= 0) continue
    const pxPerIn = pg.gridWidthPx / contentW // 그리드 폭 → 콘텐츠 영역 폭(여백 안쪽)
    // 폰트를 캔버스 폭과 무관하게: 이 계수를 ptPerPx 에 곱하면 gridWidthPx 가
    // 상쇄돼 폰트가 항상 '기준 폭' 기준으로 정해진다(위젯 위치·크기엔 영향 없음
    // — pos 는 pxPerIn 만 쓰고 폰트만 ptPerPx 를 쓴다).
    const fontNorm = pg.gridWidthPx / FONT_REF_GRID_PX
    // 실제 렌더 높이 기준으로 분할 → 넘치는 콘텐츠는 다음 슬라이드로 넘어가고,
    // 덱 전체가 같은 스케일(위젯 크기 = 화면 그대로)로 유지된다.
    const slideGroups = groupRowsByRenderHeight(pg.rows, slideH)

    for (const slideRows of slideGroups) {
      throwIfAborted(signal)
      const curSlide = pptx.addSlide()
      const originY = slideRows[0].top
      // 덱 전체 단일 스케일(scale=1)이 기본 — 넘친 건 패킹 단계에서 이미 다음
      // 슬라이드로 넘겼다. 유일한 예외: 한 행(거대 위젯) 자체가 슬라이드보다 크면
      // 넘길 곳이 없어 그 슬라이드만 맞춤 축소(가로 가운데)한다.
      const slabBottom = Math.max(...slideRows.map((r) => r.bottom))
      const slabH = slabBottom - originY
      const scale = slideRows.length === 1 && slabH > slideH ? slideH / slabH : 1
      // 축소(거대 위젯) 시 콘텐츠 영역 안에서 가로 가운데.
      const offsetXIn = scale < 1 ? (contentW * (1 - scale)) / 2 : 0

      for (const row of slideRows) {
        for (const b of row.blocks) {
          throwIfAborted(signal)
          onProgress?.({
            phase: 'capture',
            current: done,
            total: totalBlocks,
            label: `위젯 변환 중 (${done + 1}/${totalBlocks})`,
          })
          const pos = {
            x: margin + offsetXIn + (b.x * scale) / pxPerIn,
            y: margin + ((b.y - originY) * scale) / pxPerIn,
            w: (b.w * scale) / pxPerIn,
            h: (b.h * scale) / pxPerIn,
          }
          const meta = blockMeta.get(b.id)
          // 폰트만 fontNorm 적용(위치·박스 크기는 위 pos 에서 이미 확정, 불변).
          const ptPerPx = (1 / pxPerIn) * 72 * scale * fontNorm
          const caption = readVisibleCaption(b.el)
          let placed = false
          if (meta && NATIVE_TEXT_TYPES.has(meta.type)) {
            placed = tryAddNativeText(curSlide, meta, content[b.id] ?? {}, b.el, pos, ptPerPx, caption)
          } else if (meta && NATIVE_CARD_TYPES.has(meta.type)) {
            // 카드는 도형(배경/테두리) + 글 + 아이콘 조합이라 전용 경로. 아이콘
            // 래스터화 때문에 async — 실패하면 아래 이미지 폴백으로 떨어진다.
            placed = await tryAddNativeCard(
              curSlide,
              meta,
              content[b.id] ?? {},
              b.el,
              pos,
              ptPerPx,
              caption,
              addCaptionBox,
              { fontFace: TEXT_FONT, basePx: readBasePx(b.el) ?? 18 },
            )
          } else if (meta && NATIVE_TABLE_TYPES.has(meta.type)) {
            placed = tryAddNativeTable(
              curSlide,
              b.el,
              pos,
              ptPerPx,
              caption,
              pptxTableBorder(content[b.id]),
            )
          }
          if (!placed) {
            // 이미지 폴백 — 캡션을 안 보이게 뜬(위젯 비율 유지) 뒤 캔버스가 덮는
            // 실제 영역(cr) 그대로 슬라이드에 매핑해 배치(늘어짐·잘림 없음).
            const { canvas, rect: cr } = await captureContentCanvas(b.el, caption)
            curSlide.addImage({
              data: canvas.toDataURL('image/png'),
              x: pos.x + (cr.left * scale) / pxPerIn,
              y: pos.y + (cr.top * scale) / pxPerIn,
              w: (cr.width * scale) / pxPerIn,
              h: (cr.height * scale) / pxPerIn,
            })
            // 캡션(그림/표 N)은 표·글 위젯처럼 네이티브 텍스트박스로 **이미지 위에**
            // 얹는다 — 나중에 add 해야 z-order 상 이미지에 안 가려진다.
            if (caption) addCaptionBox(curSlide, caption, pos, ptPerPx)
          }
          done += 1
        }
      }
    }
  }

  throwIfAborted(signal)
  onProgress?.({ phase: 'write', current: totalBlocks, total: totalBlocks, label: 'PPT 파일 생성 중...' })
  const blob = await pptx.write({ outputType: 'blob' })
  triggerDownload(blob, `${sanitizeFileName(draft?.title || 'report')}.pptx`)
}
