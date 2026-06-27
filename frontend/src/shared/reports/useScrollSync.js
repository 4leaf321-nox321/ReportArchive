import { useEffect } from 'react'

// 분할 버전 비교 — 좌(에디터)·우(버전) 패널의 스크롤을 연동한다.
//  - 좌측 스크롤 컨테이너: 보고서 상세는 window/main 이 아니라 Radix ScrollArea
//    뷰포트에서 스크롤한다(project_scroll_container). 그래서 selector 로 그
//    뷰포트를 직접 잡는다.
//  - 우측: CompareVersionPane 의 [data-compare-scroll="right"] overflow-auto div.
// 두 패널의 콘텐츠 높이가 다를 수 있어(현재본 vs 과거 버전) **비율 동기화**한다
// — 한쪽 스크롤 진행률(0~1)을 다른 쪽에 맞춘다. 피드백 루프는 syncing 플래그로 차단.

const RIGHT_SEL = '[data-compare-scroll="right"]'

// 좌측 본문 스크롤 뷰포트. `.report-detail-root [data-radix-scroll-area-viewport]`
// 를 그냥 querySelector 하면 **폴더 사이드바**의 ScrollArea 뷰포트가 DOM 상 먼저
// 잡혀(폴더리스트와 분할화면이 동기화되는 버그) → 보고서 본문 컨테이너
// (.report-detail-content)를 감싼 뷰포트를 정확히 집는다.
function findLeftViewport() {
  const content = document.querySelector('.report-detail-content')
  return content?.closest('[data-radix-scroll-area-viewport]') ?? null
}

export function useScrollSync(enabled) {
  useEffect(() => {
    if (!enabled) return
    let left = null
    let right = null
    let syncing = false
    let raf = 0
    let tries = 0

    const ratioScroll = (src, dst) => {
      const sMax = src.scrollHeight - src.clientHeight
      const dMax = dst.scrollHeight - dst.clientHeight
      if (sMax <= 0 || dMax <= 0) {
        dst.scrollTop = src.scrollTop
        return
      }
      dst.scrollTop = (src.scrollTop / sMax) * dMax
    }
    const onLeft = () => {
      if (syncing || !left || !right) return
      syncing = true
      ratioScroll(left, right)
      requestAnimationFrame(() => {
        syncing = false
      })
    }
    const onRight = () => {
      if (syncing || !left || !right) return
      syncing = true
      ratioScroll(right, left)
      requestAnimationFrame(() => {
        syncing = false
      })
    }

    const attach = () => {
      left = findLeftViewport()
      right = document.querySelector(RIGHT_SEL)
      if (left && right) {
        left.addEventListener('scroll', onLeft, { passive: true })
        right.addEventListener('scroll', onRight, { passive: true })
        return true
      }
      return false
    }

    // 우측 패널/뷰포트가 비동기로 마운트될 수 있어 몇 프레임 재시도한다.
    if (!attach()) {
      const retry = () => {
        if (attach() || tries++ > 120) return
        raf = requestAnimationFrame(retry)
      }
      raf = requestAnimationFrame(retry)
    }

    return () => {
      cancelAnimationFrame(raf)
      if (left) left.removeEventListener('scroll', onLeft)
      if (right) right.removeEventListener('scroll', onRight)
    }
  }, [enabled])
}
