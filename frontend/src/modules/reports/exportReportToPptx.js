/** 보고서 → PowerPoint(.pptx) 내보내기 (MVP, 이미지 기반).
 *
 *  보고서는 "폭 고정·세로로 흐르는 12열 그리드"이고 PPT 는 "고정 크기 슬라이드"라,
 *  화면에 렌더된 각 위젯의 *실측 사각형*(getBoundingClientRect)을 읽어:
 *    1) 세로로 겹치는 위젯을 한 '행 그룹'으로 묶고(멀티컬럼 유지),
 *    2) 행을 위→아래로 채우다 슬라이드 높이를 넘치면 다음 슬라이드로 분할,
 *    3) 슬라이드보다 큰 단일 행은 그 슬라이드에 맞춰 축소·가운데 배치.
 *  각 위젯은 html2canvas 로 PNG 캡처(캡션 포함)해 슬라이드에 그림으로 올린다.
 *
 *  호출 전 제약(호출부 ReportDetailPage 가 보장):
 *   - printing=true → 모든 페이지가 읽기전용·all 뷰로 DOM 에 렌더됨
 *   - 차트 렌더 안정화 대기 완료
 *   - (권장) 라이트 테마 강제 — 슬라이드는 흰 배경이라 다크 토큰색이면 어색함
 */
import {
  captureBlockToCanvas,
  sanitizeFileName,
  triggerDownload,
} from './exportCapture'

// 슬라이드 물리 크기(인치). PowerPoint 2013+ 기본은 16:9(13.333×7.5).
const SLIDE_SIZES = {
  '16:9': { w: 13.333, h: 7.5 },
  '4:3': { w: 10, h: 7.5 },
  '16:10': { w: 12.5, h: 7.8125 },
}
const DEFAULT_RATIO = '16:9'
// 슬라이드 가장자리 여백(인치). 콘텐츠 영역 = 슬라이드 - 여백×2.
const MARGIN_IN = 0.3
// 부동소수 흔들림 방지용 여유(px).
const FIT_EPS_PX = 2

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

/** 같은 페이지의 위젯들을 세로 겹침 기준으로 '행 그룹'으로 묶는다. 각 그룹은
 *  좌→우로 정렬(멀티컬럼). 반환은 위→아래 순. */
function groupRows(blocks) {
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const b of sorted) {
    const last = rows[rows.length - 1]
    // 새 위젯의 top 이 현재 행의 bottom 보다 위면 같은 시각적 행으로 병합.
    if (last && b.y < last.bottom - FIT_EPS_PX) {
      last.blocks.push(b)
      last.top = Math.min(last.top, b.y)
      last.bottom = Math.max(last.bottom, b.y + b.h)
    } else {
      rows.push({ top: b.y, bottom: b.y + b.h, blocks: [b] })
    }
  }
  for (const r of rows) r.blocks.sort((a, b) => a.x - b.x)
  return rows
}

/** 페이지별 그리드 컨테이너 + 위젯 실측 사각형(그리드 원점 기준)을 수집. */
function collectPages() {
  const pageEls = Array.from(document.querySelectorAll('.report-detail-page'))
  return pageEls.map((pageEl) => {
    const grid = pageEl.querySelector('.react-grid-layout') || pageEl
    const gridRect = grid.getBoundingClientRect()
    const blocks = Array.from(grid.querySelectorAll('[id^="block-"]'))
      .map((el) => {
        const r = el.getBoundingClientRect()
        return {
          el,
          x: r.left - gridRect.left,
          y: r.top - gridRect.top,
          w: r.width,
          h: r.height,
        }
      })
      .filter((b) => b.w > 1 && b.h > 1)
    return { gridWidthPx: gridRect.width || 1, blocks }
  })
}

export async function exportReportToPptx({ draft, slide = {}, onProgress, signal } = {}) {
  const ratio = SLIDE_SIZES[slide.ratio] ? slide.ratio : DEFAULT_RATIO
  const dim = SLIDE_SIZES[ratio]
  const contentW = dim.w - MARGIN_IN * 2
  const contentH = dim.h - MARGIN_IN * 2

  const pages = collectPages().filter((p) => p.blocks.length > 0)
  const totalBlocks = pages.reduce((s, p) => s + p.blocks.length, 0)
  if (totalBlocks === 0) {
    throw new Error('내보낼 위젯이 없습니다.')
  }

  onProgress?.({ phase: 'load', current: 0, total: totalBlocks, label: '내보내기 모듈 로드 중...' })
  const PptxGenJS = (await import('pptxgenjs')).default
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'RA_LAYOUT', width: dim.w, height: dim.h })
  pptx.layout = 'RA_LAYOUT'

  let done = 0
  onProgress?.({ phase: 'capture', current: 0, total: totalBlocks, label: '슬라이드 변환 준비 중...' })

  for (const page of pages) {
    throwIfAborted(signal)
    // 보고서 페이지 폭 전체를 슬라이드 콘텐츠 폭에 맞춘다 → px↔인치 환산 계수.
    const pxPerIn = page.gridWidthPx / contentW
    const slideBudgetPx = contentH * pxPerIn

    const rows = groupRows(page.blocks)
    let curSlide = null
    let slideOriginY = 0 // 이 px y 가 현재 슬라이드 콘텐츠 상단에 대응
    let forceNew = true // 페이지 시작은 항상 새 슬라이드

    for (const row of rows) {
      throwIfAborted(signal)
      const rowH = row.bottom - row.top
      const oversized = rowH > slideBudgetPx

      if (forceNew) {
        curSlide = pptx.addSlide()
        slideOriginY = row.top
        forceNew = false
      } else if (row.top - slideOriginY + rowH > slideBudgetPx + FIT_EPS_PX) {
        // 현재 슬라이드에 안 들어감 → 새 슬라이드, 이 행이 상단.
        curSlide = pptx.addSlide()
        slideOriginY = row.top
      }

      // 행 내 위젯 캡처 + 배치.
      let scale = 1
      let offsetXIn = MARGIN_IN
      let rowLeft = 0
      if (oversized) {
        // 슬라이드보다 큰 행 → 통째로 축소해 단독 슬라이드에 가운데 배치.
        slideOriginY = row.top
        scale = slideBudgetPx / rowH
        rowLeft = Math.min(...row.blocks.map((b) => b.x))
        const rowRight = Math.max(...row.blocks.map((b) => b.x + b.w))
        const scaledWidthIn = ((rowRight - rowLeft) * scale) / pxPerIn
        offsetXIn = MARGIN_IN + Math.max(0, (contentW - scaledWidthIn) / 2)
      }

      for (const b of row.blocks) {
        throwIfAborted(signal)
        onProgress?.({
          phase: 'capture',
          current: done,
          total: totalBlocks,
          label: `위젯 변환 중 (${done + 1}/${totalBlocks})`,
        })
        const canvas = await captureBlockToCanvas(b.el, { scale: 2 })
        const dataUrl = canvas.toDataURL('image/png')
        const xIn = oversized
          ? offsetXIn + ((b.x - rowLeft) * scale) / pxPerIn
          : MARGIN_IN + b.x / pxPerIn
        const yIn = oversized
          ? MARGIN_IN + ((b.y - row.top) * scale) / pxPerIn
          : MARGIN_IN + (b.y - slideOriginY) / pxPerIn
        const wIn = (b.w * scale) / pxPerIn
        const hIn = (b.h * scale) / pxPerIn
        curSlide.addImage({ data: dataUrl, x: xIn, y: yIn, w: wIn, h: hIn })
        done += 1
      }

      // 축소 행을 단독으로 채웠으면 다음 행은 새 슬라이드부터.
      if (oversized) forceNew = true
    }
  }

  throwIfAborted(signal)
  onProgress?.({ phase: 'write', current: totalBlocks, total: totalBlocks, label: 'PPT 파일 생성 중...' })
  const blob = await pptx.write({ outputType: 'blob' })
  triggerDownload(blob, `${sanitizeFileName(draft?.title || 'report')}.pptx`)
}
