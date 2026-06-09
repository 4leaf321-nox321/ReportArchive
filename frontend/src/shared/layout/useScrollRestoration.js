import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

// history 항목(location.key)별 스크롤 위치 기억. 같은 세션 동안만 유지
// (새로고침 시 비움)이라 Map 으로 충분하다.
const positions = new Map()

/**
 * 페이지의 "주 스크롤 요소" 해석.
 *
 * 함정: 이 앱은 페이지마다 스크롤 컨테이너가 다르다. 보고서 상세는
 * AppShell <main> 이 아니라 본문 <ScrollArea>(Radix) 의 *뷰포트* 안에서
 * 스크롤된다(.report-detail-root [data-radix-scroll-area-viewport]). 그래서
 * <main>.scrollTop 만 보면 늘 0 이라 복원이 "맨 위"로 보였다.
 *
 * 그 ScrollArea 뷰포트(실제로 스크롤 중인 것 중 가장 큰 것)를 우선 쓰고,
 * 없으면 <main> 으로 폴백한다. 뷰포트는 라우트마다 새로 마운트되므로 ref 로
 * 들고 있지 않고 매번 다시 질의한다.
 */
function getScroller(fallbackEl) {
  const vps = document.querySelectorAll(
    '.report-detail-root [data-radix-scroll-area-viewport]',
  )
  let best = null
  let bestH = 0
  for (const vp of vps) {
    // 실제로 스크롤되는(내용이 넘치는) 뷰포트 중 가장 큰 것 = 본문.
    if (vp.scrollHeight > vp.clientHeight + 1 && vp.scrollHeight > bestH) {
      best = vp
      bestH = vp.scrollHeight
    }
  }
  return best ?? fallbackEl ?? null
}

/**
 * 뒤로가기 시 스크롤 위치 복원. react-router 의 createBrowserRouter 엔 자동
 * 복원이 없고 내장 <ScrollRestoration> 은 window 만 다루는데, 이 앱은 내부
 * 컨테이너가 스크롤되므로 직접 구현한다. @멘션 복귀뿐 아니라 앱 전체
 * 뒤로가기 스크롤이 정확해진다.
 *
 * 도착 페이지가 비동기 로드라 스크롤 요소/높이가 늦게 잡히면 즉시 복원이
 * 실패하므로, 확보될 때까지 몇 프레임(최대 ~2s) 재시도한다.
 */
export function useScrollRestoration(fallbackRef) {
  const location = useLocation()
  const navType = useNavigationType()
  const key = location.key
  const keyRef = useRef(key)
  keyRef.current = key

  // 어떤 컨테이너가 스크롤되든 capture 단계로 받아 현재 위치를 기억한다.
  // (scroll 이벤트는 버블하지 않으므로 capture=true 로 임의 컨테이너를 잡는다.)
  useEffect(() => {
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const el = getScroller(fallbackRef.current)
        if (el) positions.set(keyRef.current, el.scrollTop)
      })
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [fallbackRef])

  // 라우트 전환 후 적용: 뒤로가기(POP)면 저장값 복원, 아니면 맨 위로.
  useLayoutEffect(() => {
    if (navType !== 'POP') {
      const el = getScroller(fallbackRef.current)
      if (el) el.scrollTop = 0
      return
    }
    const target = positions.get(key) ?? 0
    let attempts = 0
    let raf = 0
    const tryRestore = () => {
      const el = getScroller(fallbackRef.current)
      if (el) {
        const maxTop = el.scrollHeight - el.clientHeight
        // 콘텐츠 높이가 목표를 담을 만큼 자랐거나, 한계(~120프레임 ≈ 2s)면 적용.
        if (maxTop >= target || attempts > 120) {
          el.scrollTop = Math.min(target, Math.max(0, maxTop))
          return
        }
      }
      attempts += 1
      raf = requestAnimationFrame(tryRestore)
    }
    tryRestore()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [key, navType, fallbackRef])
}
