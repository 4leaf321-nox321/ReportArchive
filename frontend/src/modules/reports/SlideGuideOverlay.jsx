import { useLayoutEffect, useRef, useState } from 'react'
import {
  groupRowsIntoSlides,
  measureSlideRows,
  slideHeightPx as slideHeightPxFor,
} from './slideLayout'

/**
 * PPT export 보조용 슬라이드 가이드 오버레이.
 *
 * 본문 컨테이너(`.report-detail-content`) 안에 절대배치로 깔려, "한 슬라이드에
 * 무엇이 들어갈지"를 수평 점선으로 보여준다.
 *
 * 분할 기준은 `slideLayout.js` 의 공용 로직을 그대로 쓴다(= PPT 익스포터와 동일):
 *   - 경계 *결정* 은 각 위젯의 **뷰 높이**(autoFit mirror)로 → 편집 모드에서 위젯이
 *     더 길어 보여도 뷰/출력과 같은 슬라이드로 묶인다.
 *   - 경계 *선 위치* 는 그 슬라이드를 시작하는 위젯의 현재 모드 화면 top 에.
 *   - 페이지마다 새 슬라이드로 시작(익스포터와 동일).
 * 위젯을 못 찾으면 "균일 간격"으로 폴백한다.
 *
 * pointer-events:none, 부모 ResizeObserver 로 자동 갱신, 인쇄/풀스크린 숨김은 CSS.
 * 부모는 position:relative(`.report-detail-content`) 여야 한다.
 */
export function SlideGuideOverlay({ ratio, customW, customH }) {
  const rootRef = useRef(null)
  const [lines, setLines] = useState([])

  useLayoutEffect(() => {
    const root = rootRef.current
    const parent = root?.parentElement
    if (!root || !parent) return undefined
    const recompute = () => {
      const next = computeLines(root, parent, ratio, customW, customH)
      setLines((prev) => (sameLines(prev, next) ? prev : next))
    }
    recompute()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(recompute)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [ratio, customW, customH])

  return (
    <div
      ref={rootRef}
      data-slide-guide-overlay
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      {lines.map((ln, i) => (
        <div
          key={i}
          style={{ top: `${ln.top}px` }}
          className="absolute left-0 right-0 border-t border-dashed border-sky-500/40"
        >
          <span className="absolute right-1 top-0.5 text-[10px] font-medium text-sky-600/70 select-none">
            {ln.label}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 콘텐츠 앵커 경계선 — 익스포터와 동일한 slideLayout 로직. 위젯 못 찾으면 []. */
function contentAnchoredLines(container, containerTop, ratio, customW, customH) {
  const pageEls = Array.from(container.querySelectorAll('.report-detail-page'))
  const pages = pageEls.length ? pageEls : [container]
  const lines = []
  let slideNum = 0
  for (const pageEl of pages) {
    const grid = pageEl.querySelector('.react-grid-layout') || pageEl
    const { gridWidthPx, rows } = measureSlideRows(grid, containerTop)
    if (rows.length === 0) continue
    const slideH = slideHeightPxFor(gridWidthPx, ratio, customW, customH)
    if (!Number.isFinite(slideH) || slideH <= 0) continue
    const slides = groupRowsIntoSlides(rows, slideH)
    for (const slideRows of slides) {
      slideNum += 1
      lines.push({ top: slideRows[0].lineTop, label: `Slide ${slideNum}` })
    }
  }
  return lines
}

/** 폴백 — 컨테이너 상단부터 슬라이드높이마다 균일 선. */
function uniformLines(container, ratio, customW, customH) {
  const r = container.getBoundingClientRect()
  const slideH = slideHeightPxFor(r.width, ratio, customW, customH)
  if (!Number.isFinite(slideH) || slideH <= 0 || !(r.height > 0)) return []
  const count = Math.max(1, Math.ceil(r.height / slideH))
  return Array.from({ length: count }, (_, i) => ({ top: i * slideH, label: `Slide ${i + 1}` }))
}

function computeLines(root, container, ratio, customW, customH) {
  const containerTop = root.getBoundingClientRect().top
  const anchored = contentAnchoredLines(container, containerTop, ratio, customW, customH)
  return anchored.length > 0 ? anchored : uniformLines(container, ratio, customW, customH)
}

function sameLines(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i].top - b[i].top) > 0.5 || a[i].label !== b[i].label) return false
  }
  return true
}
