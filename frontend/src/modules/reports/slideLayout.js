/** 슬라이드 분할 공용 로직 — 편집 가이드(SlideGuideOverlay)와 PPT 익스포터가
 *  *똑같은 기준*으로 슬라이드를 나누게 하는 단일 소스.
 *
 *  핵심: 슬라이드 경계 결정은 각 위젯의 **뷰 높이**로 한다. 편집 모드에도 카드
 *  안에 autoFit 측정 mirror(`.report-autofit-mirror`, 읽기전용 = 뷰 렌더)가 있어
 *  그 높이를 읽으면 된다. 가이드와 익스포터가 이 함수를 공유하므로 "웹에선 1장,
 *  PPT에선 2장" 같은 어긋남이 생기지 않는다.
 */

/** 비율 → 세로/가로 비(h/w). 프리셋/custom 외엔 NaN. */
export function ratioAspect(ratio, customW, customH) {
  if (ratio === '16:9') return 9 / 16
  if (ratio === '4:3') return 3 / 4
  if (ratio === '16:10') return 10 / 16
  if (ratio === 'custom') {
    if (Number.isFinite(customW) && customW > 0 && Number.isFinite(customH) && customH > 0) {
      return customH / customW
    }
  }
  return NaN
}

/** 컨테이너(그리드) 폭 + 비율 → 슬라이드 한 장의 픽셀 높이(= 폭 × h/w). */
export function slideHeightPx(gridWidthPx, ratio, customW, customH) {
  const a = ratioAspect(ratio, customW, customH)
  if (!Number.isFinite(gridWidthPx) || gridWidthPx <= 0 || !Number.isFinite(a)) return NaN
  return gridWidthPx * a
}

/** 위젯의 뷰 높이(px). 편집 모드에도 있는 autoFit mirror(읽기전용=뷰) 높이를
 *  쓰고, 없으면(수동 높이 위젯) 현재 렌더 높이를 쓴다. */
function viewHeightOf(blockEl, fallbackH) {
  const mirror = blockEl.querySelector('.report-autofit-mirror')
  if (mirror) {
    const h = mirror.getBoundingClientRect().height
    if (h > 1) return h
  }
  return fallbackH
}

/** 한 페이지(그리드) 내 위젯을 측정해 '행 그룹'으로 묶는다.
 *  - 좌표(x,y,w,h)는 그리드 기준(익스포터 배치용).
 *  - lineTop 은 lineOriginTop 기준(가이드 선 위치용).
 *  - viewH 는 뷰 높이(슬라이드 분할 결정용).
 *  반환: { gridWidthPx, rows: [{ top, bottom, viewH, lineTop, blocks:[...] }] } */
export function measureSlideRows(grid, lineOriginTop = 0) {
  const gridRect = grid.getBoundingClientRect()
  const blocks = Array.from(grid.querySelectorAll('[id^="block-"]'))
    .map((el) => {
      const r = el.getBoundingClientRect()
      return {
        el,
        id: (el.id || '').replace(/^block-/, ''),
        x: r.left - gridRect.left,
        y: r.top - gridRect.top,
        w: r.width,
        h: r.height,
        lineTop: r.top - lineOriginTop,
        viewH: viewHeightOf(el, r.height),
      }
    })
    .filter((b) => b.w > 1 && b.h > 1)
    .sort((a, b) => a.y - b.y || a.x - b.x)

  const rows = []
  for (const b of blocks) {
    const last = rows[rows.length - 1]
    if (last && b.y < last.bottom - 2) {
      last.bottom = Math.max(last.bottom, b.y + b.h)
      last.viewH = Math.max(last.viewH, b.viewH)
      last.lineTop = Math.min(last.lineTop, b.lineTop)
      last.blocks.push(b)
    } else {
      rows.push({ top: b.y, bottom: b.y + b.h, viewH: b.viewH, lineTop: b.lineTop, blocks: [b] })
    }
  }
  for (const r of rows) r.blocks.sort((a, b) => a.x - b.x)
  return { gridWidthPx: gridRect.width || 1, rows }
}

// 슬라이드 한 장에 허용하는 여유(slack). "거의 한 슬라이드"인 콘텐츠를 사소한
// 초과로 2장에 쪼개(두 번째가 거의 빈 채로) 버리지 않게 한다. 가이드와
// 익스포터가 같은 시점이 아니라(가이드=현재 화면, export=printing 모드라 차트가
// 다시 안정화되며 높이가 미세하게 달라짐) 경계에 걸친 페이지가 한쪽에선 1장,
// 다른 쪽에선 2장이 되던 어긋남도 이 여유가 흡수한다. 넘친 만큼은 익스포터가
// 그 슬라이드만 맞춤 축소한다.
export const SLIDE_FILL_SLACK = 0.12

/** 행들을 슬라이드 그룹으로 나눈다. 뷰 높이 합이 (슬라이드 높이 × (1+slack)) 를
 *  넘치면 새 슬라이드. 반환: [[row,...], ...] (슬라이드별 행 묶음). */
export function groupRowsIntoSlides(rows, slideH) {
  const budget = slideH * (1 + SLIDE_FILL_SLACK)
  const slides = []
  let cur = null
  let acc = 0
  for (const row of rows) {
    if (!cur || (cur.length > 0 && acc + row.viewH > budget + 2)) {
      cur = []
      slides.push(cur)
      acc = 0
    }
    cur.push(row)
    acc += row.viewH
  }
  return slides
}
