import { useLayoutEffect, useMemo, useRef, useState } from 'react'

/**
 * PPT export 보조용 슬라이드 가이드 오버레이.
 *
 * 본문 컨테이너(보통 `.report-detail-content`) 안에 절대배치로 깔리며,
 * "본문 폭 × (높이/너비) = 슬라이드 1장 높이" 식으로 컨테이너 상단부터
 * 일정 간격마다 수평 점선을 그어 사용자가 PPT 한 장에 무엇이 들어갈지
 * 미리 가늠하게 해 준다.
 *
 * - `pointer-events: none` 으로 깔려서 위젯 클릭/드래그를 방해하지 않는다.
 * - 컨테이너 폭/높이를 `ResizeObserver` 로 추적해서 페이지·위젯 추가/리사이즈
 *   시 자동으로 슬라이드 개수가 업데이트된다.
 * - 인쇄/풀스크린 보기에서의 숨김은 CSS (`@media print`, `body.report-fullscreen`)
 *   가 담당한다 — 이 컴포넌트 자체는 `data-slide-guide-overlay` 마커를
 *   달아서 그 selector 들이 잡을 수 있게만 한다.
 *
 * 부모 div 는 반드시 `position: relative` 여야 한다. ReportDetailPage 의
 * `.report-detail-content` 가 이미 그 조건을 만족하도록 className/CSS 가
 * 조정되어 있다.
 */
export function SlideGuideOverlay({ ratio, customW, customH }) {
  const rootRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  // 부모(첫 번째 positioning ancestor) 의 폭·높이를 관찰. rootRef 는
  // 자기 자신을 가리키지만, position:absolute + inset:0 로 부모에 꽉 차게
  // 깔리므로 자기 폭/높이가 곧 부모 콘텐츠 박스 크기와 같다.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({ width: r.width, height: r.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // 부모 콘텐츠가 늘어날 때(위젯 추가, 페이지 추가 등) 자기 자신의
    // inset:0 박스도 같이 늘어나므로 부모를 따로 관찰할 필요는 없다.
    return () => ro.disconnect()
  }, [])

  const slideHeight = useMemo(
    () => computeSlideHeight(size.width, ratio, customW, customH),
    [size.width, ratio, customW, customH],
  )
  const lineCount = useMemo(() => {
    if (!Number.isFinite(slideHeight) || slideHeight <= 0) return 0
    if (!Number.isFinite(size.height) || size.height <= 0) return 0
    // 마지막 슬라이드가 컨테이너 끝에서 잘리는 게 시각적으로 자연스러우니
    // ceil 로 한 줄 더 그어준다. 컨테이너 내부에 있는 점선만 보이게
    // overflow:hidden 으로 잘라낸다.
    return Math.max(1, Math.ceil(size.height / slideHeight))
  }, [slideHeight, size.height])

  return (
    <div
      ref={rootRef}
      data-slide-guide-overlay
      aria-hidden
      // pointer-events:none → 위젯 위에 떠 있어도 클릭/드래그 미간섭.
      // overflow:hidden → 컨테이너 마지막 슬라이드 라벨이 밖으로 새지 않게.
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      {Number.isFinite(slideHeight) && slideHeight > 0 &&
        Array.from({ length: lineCount }).map((_, i) => (
          <div
            key={i}
            style={{ top: `${i * slideHeight}px`, height: `${slideHeight}px` }}
            className={
              // 각 슬라이드 영역은 상단 점선 + 옅은 교차 음영(짝수번째).
              // 마지막 줄은 컨테이너 안쪽까지만 보이고 나머지는 overflow
              // 로 잘린다.
              'absolute left-0 right-0 border-t border-dashed border-sky-500/40 ' +
              (i % 2 === 1 ? 'bg-sky-500/[0.04]' : '')
            }
          >
            <span className="absolute right-1 top-0.5 text-[10px] font-medium text-sky-600/70 select-none">
              Slide {i + 1}
            </span>
          </div>
        ))}
    </div>
  )
}

/**
 * 컨테이너 폭 + 비율 → 슬라이드 한 장의 픽셀 높이.
 *
 * - ratio 가 프리셋 ("16:9"/"4:3"/"16:10") 이면 그대로 사용.
 * - "custom" 이면 customW/customH 가 모두 양수일 때만 계산이 의미가 있고,
 *   하나라도 비어 있으면 NaN 을 돌려서 호출자가 가이드를 안 그리도록 한다.
 * - 그 외 (null, 잘못된 값) 도 NaN. 호출자는 NaN 일 때 렌더를 스킵한다.
 */
function computeSlideHeight(widthPx, ratio, customW, customH) {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return NaN
  let rw = null
  let rh = null
  if (ratio === '16:9') [rw, rh] = [16, 9]
  else if (ratio === '4:3') [rw, rh] = [4, 3]
  else if (ratio === '16:10') [rw, rh] = [16, 10]
  else if (ratio === 'custom') {
    if (Number.isFinite(customW) && customW > 0 && Number.isFinite(customH) && customH > 0) {
      rw = customW
      rh = customH
    }
  }
  if (rw == null || rh == null) return NaN
  return widthPx * (rh / rw)
}
