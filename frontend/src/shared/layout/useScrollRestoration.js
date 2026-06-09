import { useEffect, useLayoutEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

// history 항목(location.key)별 스크롤 위치 기억. 같은 세션 동안만 유지
// (새로고침 시 비움)이라 Map 으로 충분하다.
const positions = new Map()

/**
 * AppShell 의 스크롤 컨테이너(<main>) 전용 스크롤 복원.
 *
 * react-router 의 createBrowserRouter 에는 자동 스크롤 복원이 없고, 내장
 * <ScrollRestoration> 도 window 스크롤만 다룬다. 이 앱은 window 가 아니라
 * 내부 <main overflow-y-auto> 가 스크롤되므로, 뒤로가기 시 늘 맨 위로 가
 * 버렸다. 여기서 history 항목별로 위치를 기억했다가 뒤로가기(POP)에 복원해
 * "@멘션으로 갔다가 돌아오면 읽던 자리" 가 유지되게 한다. 멘션뿐 아니라 앱
 * 전체의 뒤로가기 스크롤이 정확해진다.
 *
 * 도착 페이지가 비동기로 로드돼 콘텐츠 높이가 늦게 잡히면 즉시 복원이
 * 실패하므로, 높이가 확보될 때까지 몇 프레임(최대 ~1.5s) 재시도한다.
 */
export function useScrollRestoration(scrollRef) {
  const location = useLocation()
  const navType = useNavigationType()
  const key = location.key

  // 현재 화면의 스크롤을 계속 기억 — 떠나기 전 최신값이 저장돼 있도록.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        positions.set(key, el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      positions.set(key, el.scrollTop) // 떠나기 직전 최종 위치 확정.
    }
  }, [key, scrollRef])

  // 라우트 전환 후 위치 적용: 뒤로가기(POP)면 저장값 복원, 아니면 맨 위로.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (navType !== 'POP') {
      el.scrollTop = 0
      return
    }
    const target = positions.get(key) ?? 0
    if (target === 0) {
      el.scrollTop = 0
      return
    }
    let attempts = 0
    let raf = 0
    const tryRestore = () => {
      const maxTop = el.scrollHeight - el.clientHeight
      // 콘텐츠 높이가 목표를 담을 만큼 자랐거나, 한계(~90프레임)면 적용.
      if (maxTop >= target || attempts > 90) {
        el.scrollTop = Math.min(target, Math.max(0, maxTop))
        return
      }
      attempts += 1
      raf = requestAnimationFrame(tryRestore)
    }
    tryRestore()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [key, navType, scrollRef])
}
