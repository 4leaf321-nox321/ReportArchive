/** 사이드바·헤더의 '읽지 않은 알림 / 미해결 코멘트' 배지 카운트는 여러
 *  컴포넌트(Sidebar, NotificationBell)가 각자 30초 폴링으로 들고 있다.
 *  사용자가 알림 페이지나 받은 코멘트 페이지(또는 보고서 안의 코멘트
 *  패널)에서 항목을 읽거나 resolve 하면 그쪽 화면은 낙관적으로 즉시
 *  반영되지만, 사이드바 배지는 다음 폴링 주기까지 stale.
 *
 *  새로고침 없이 즉시 동기화하려면 mutation 직후 누군가가 "배지 다시
 *  계산해" 라고 외쳐야 한다. 이 모듈은 그 외침을 받아 전달하는 가장
 *  얇은 pub/sub. React Context 까지 가지 않은 이유:
 *    - 카운트 자체의 source-of-truth 는 여전히 백엔드/폴러에 있고,
 *    - 구독자는 사이드바/벨 두어 곳뿐이라
 *    - Provider 트리 흔드는 비용이 과하다.
 *
 *  사용:
 *    구독: subscribeBadgesChanged(() => refetchMyCounts())
 *    알림: notifyBadgesChanged() — markRead/resolve 등 mutation 직후
 */
const listeners = new Set()

export function subscribeBadgesChanged(cb) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function notifyBadgesChanged() {
  // 동기 실행. 구독자(주로 React effect)는 fetch 만 트리거하므로
  // 마이크로태스크 큐 차원에서 충분히 안전.
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      // 한 구독자의 오류가 다른 구독자에게 번지지 않게.
    }
  }
}
