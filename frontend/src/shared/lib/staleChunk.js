/**
 * 배포로 사라진 청크(stale chunk) 감지.
 *
 * 지연 로딩(`await import(...)`)은 청크를 **누를 때** 처음 받아온다. 그런데
 * 배포는 SIF 를 통째로 갈아끼워 /assets 의 옛 청크를 전부 없애므로, 배포 전에
 * 열어둔 탭이 나중에 그 기능을 쓰면 이미 없는 파일을 요청해 404 로 죽는다.
 * HTML 내보내기처럼 지연 로딩이면서 자주 안 누르는 기능에서 특히 잘 터진다
 * (페이지를 연 시점과 청크를 받는 시점이 며칠씩 벌어지므로).
 *
 * 이건 코드 버그가 아니라 "페이지가 낡았다"는 신호다. 사용자에게 날것의
 * "Failed to fetch dynamically imported module" 를 보여줄 게 아니라 새로고침을
 * 안내해야 한다.
 */

// 브라우저마다 문구가 다르다. Chrome/Edge: "Failed to fetch dynamically imported
// module", Firefox: "error loading dynamically imported module", Safari:
// "Importing a module script failed". MIME 오류는 자산 자리에 index.html 이
// 돌아온 경우(SPA 폴백이 /assets 를 삼키는 배포)라 원인은 같다.
const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /failed to load module script/i,
  /expected a javascript(-or-wasm)? module script/i,
  /dynamically imported module.*(404|not found)/i,
  /unable to preload css/i,
]

/** 이 에러가 '배포로 청크가 사라짐' 때문인가. */
export function isStaleChunkError(err) {
  const msg = typeof err === 'string' ? err : (err?.message ?? '')
  if (!msg) return false
  return STALE_CHUNK_PATTERNS.some((re) => re.test(msg))
}

/**
 * 새로고침 안내 토스트. 원인이 stale chunk 임을 이미 아는 곳에서 쓴다
 * (예: vite:preloadError — 이 이벤트 자체가 프리로드 실패를 뜻한다).
 *
 * 자동 새로고침은 하지 않는다. 편집 중인 내용이 날아갈 수 있으므로 결정은
 * 사용자에게 맡긴다.
 */
export function showStaleChunkToast(toast, { context } = {}) {
  toast.error(
    `${context ? `${context}: ` : ''}새 버전이 배포되어 이 페이지가 오래되었습니다. 새로고침 후 다시 시도해 주세요.`,
    {
      // 같은 배포에서 여러 번 터져도 토스트는 하나만 남게 한다.
      id: 'stale-chunk',
      duration: 15000,
      action: {
        label: '새로고침',
        onClick: () => window.location.reload(),
      },
    },
  )
}

/**
 * stale chunk 면 안내 토스트를 띄우고 true 를 반환한다. 아니면 false —
 * 호출부가 원래 에러 처리를 이어가면 된다.
 */
export function notifyIfStaleChunk(err, toast, { context } = {}) {
  if (!isStaleChunkError(err)) return false
  showStaleChunkToast(toast, { context })
  return true
}
