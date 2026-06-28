/** 보고서 → PowerPoint(.pptx) 내보내기.
 *
 *  보고서는 "폭 고정·세로로 흐르는 12열 그리드"이고 PPT 는 "고정 크기 슬라이드"라:
 *    1) slideLayout 공용 로직으로 위젯을 '행 그룹'으로 묶고(멀티컬럼 유지) 슬라이드
 *       단위로 나눈다 — **편집 가이드(SlideGuideOverlay)와 완전히 동일한 기준**
 *       (각 위젯의 뷰 높이 + 전체 슬라이드 높이 예산, 여백 없음)이라 "웹 1장,
 *       PPT 2장" 같은 어긋남이 없다.
 *    2) 그리드 폭 → 슬라이드 폭(full-bleed)으로 매핑해 배치(페이지마다 새 슬라이드).
 *    3) 멤버십은 뷰 높이로 정했지만 실제 배치는 렌더 rect 라, 한 슬라이드의 실제
 *       콘텐츠가 슬라이드보다 길면 그 슬라이드만 맞춤 축소(가로 가운데)한다.
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
import { COLOR_TOKENS } from '@/shared/text-color'

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
  groupRowsIntoSlides,
  measureSlideRows,
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
  return { text, heightPx: r.height || 0, fontPx, below }
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
    if (runs && runs.length) {
      slide.addText(runs, {
        x: pos.x,
        y: bodyY,
        w: pos.w,
        h: Math.max(0.2, pos.h - capH),
        valign: 'top',
        wrap: true,
        fontFace: TEXT_FONT,
        margin: 2,
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

    // 편집 가이드와 동일 기준: 전체 슬라이드 높이(여백 없음) 예산 + mirror 뷰 높이.
    const slideH = slideHeightPxFor(pg.gridWidthPx, ratio)
    if (!Number.isFinite(slideH) || slideH <= 0) continue
    const pxPerIn = pg.gridWidthPx / dim.w // full-bleed: 그리드 폭 → 슬라이드 폭
    const slideGroups = groupRowsIntoSlides(pg.rows, slideH)

    for (const slideRows of slideGroups) {
      throwIfAborted(signal)
      const curSlide = pptx.addSlide()
      const originY = slideRows[0].top
      // 멤버십은 뷰 높이로 정했지만 배치는 실제 rect 라, 한 슬라이드의 실제
      // 콘텐츠가 슬라이드보다 길면 그 슬라이드만 맞춤 축소(겹침/넘침 방지).
      const slabBottom = Math.max(...slideRows.map((r) => r.bottom))
      const slabH = slabBottom - originY
      const scale = slabH > slideH ? slideH / slabH : 1
      const offsetXIn = (dim.w * (1 - scale)) / 2 // 축소 시 가로 가운데

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
            x: offsetXIn + (b.x * scale) / pxPerIn,
            y: ((b.y - originY) * scale) / pxPerIn,
            w: (b.w * scale) / pxPerIn,
            h: (b.h * scale) / pxPerIn,
          }
          const meta = blockMeta.get(b.id)
          const ptPerPx = (1 / pxPerIn) * 72 * scale
          const caption = readVisibleCaption(b.el)
          let placed = false
          if (meta && NATIVE_TEXT_TYPES.has(meta.type)) {
            placed = tryAddNativeText(curSlide, meta, content[b.id] ?? {}, b.el, pos, ptPerPx, caption)
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
            // 이미지 폴백 — 캡션은 캡처 이미지에 이미 포함되므로 별도 박스 없음.
            const canvas = await captureBlockToCanvas(b.el, { scale: 2 })
            curSlide.addImage({ data: canvas.toDataURL('image/png'), ...pos })
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
