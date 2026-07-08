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

// 슬라이드 여백(상하좌우) — 슬라이드 '폭' 대비 비율(동일 인치를 네 변에 준다).
// PPT 익스포터가 콘텐츠를 슬라이드 전체가 아니라 '안쪽 영역'에 배치하는 근거이자,
// 슬라이드 분할 높이 예산에도 반영돼 가이드와 출력이 같은 기준을 쓰게 한다.
export const SLIDE_MARGIN_FRAC = 0.035

/** 컨테이너(그리드) 폭 + 비율 → 슬라이드 한 장에 담기는 '콘텐츠 영역' 픽셀 높이.
 *  여백을 뺀 콘텐츠 종횡비 = (a - 2f)/(1 - 2f) (a=h/w, f=폭대비 여백비율)로,
 *  full-bleed(a) 보다 조금 낮아 여백만큼 한 장에 덜 담긴다. */
export function slideHeightPx(gridWidthPx, ratio, customW, customH) {
  const a = ratioAspect(ratio, customW, customH)
  if (!Number.isFinite(gridWidthPx) || gridWidthPx <= 0 || !Number.isFinite(a)) return NaN
  const f = SLIDE_MARGIN_FRAC
  const contentAspect = (a - 2 * f) / (1 - 2 * f)
  return gridWidthPx * contentAspect
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

// 슬라이드 한 장에 허용하는 여유(slack). 측정 지터·경계 걸침을 흡수할 만큼만
// 작게 둔다. 익스포터가 넘친 콘텐츠를 "다음 슬라이드로" 넘기므로(더는 통째로
// 축소하지 않음) 여유가 크면 실제로 넘치는 페이지를 한 장에 우겨넣는 꼴이 되어
// 화면보다 작게 나온다 — 그래서 예전 0.12 대신 2%로 낮췄다.
export const SLIDE_FILL_SLACK = 0.02

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

/** 실제 렌더 높이(rect) 기준 슬라이드 분할 — PPT 익스포터 전용.
 *
 *  groupRowsIntoSlides 는 '뷰 높이 합'으로 나누지만(가이드 표시용), 익스포터는
 *  실제로 배치할 rect 로 나눠야 물리 슬라이드가 넘치지 않는다. 각 슬라이드의 실제
 *  세로 범위(첫 행 top ~ 이 행 bottom, 행 간격 포함)가 슬라이드 높이를 넘으면 이
 *  행을 *다음* 슬라이드로 넘긴다 → 넘친 콘텐츠를 축소가 아니라 분할로 처리하므로
 *  덱 전체가 같은 스케일(위젯 크기 = 화면 그대로)로 유지된다.
 *
 *  단, 한 행 자체가 슬라이드보다 큰 경우(거대 위젯)는 넘길 곳이 없어 그 행만
 *  단독 슬라이드로 두고, 그 슬라이드만 익스포터가 맞춤 축소한다.
 *
 *  반환: [[row,...], ...] (슬라이드별 행 묶음). */
export function groupRowsByRenderHeight(rows, slideH) {
  const budget = slideH * (1 + SLIDE_FILL_SLACK)
  const slides = []
  let cur = null
  let originTop = 0
  for (const row of rows) {
    // 현재 슬라이드에 이 행을 더하면 실제 세로 범위가 슬라이드를 넘는가?
    // (슬라이드가 비어 있으면 무조건 담아 무한 루프/유실을 막는다.)
    if (cur && cur.length > 0 && row.bottom - originTop > budget) {
      cur = null
    }
    if (!cur) {
      cur = []
      slides.push(cur)
      originTop = row.top
    }
    cur.push(row)
  }
  return slides
}
