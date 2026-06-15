/** 클립보드 텍스트 복사 — HTTP(비보안 컨텍스트) 안전 버전.
 *
 *  async Clipboard API(navigator.clipboard.writeText)는 *보안 컨텍스트*
 *  (HTTPS·localhost)에서만 신뢰할 수 있다. 운영서버를 평문 HTTP 로 접속하면
 *  브라우저에 따라 navigator.clipboard 가 아예 undefined 이거나, 객체는
 *  있지만 writeText 가 조용히 거부/무동작(에러도 안 나고 복사도 안 됨)한다.
 *  그래서 단순히 "writeText 가 있으면 쓴다" 로는 HTTP 에서 복사가 안 된다.
 *
 *  → window.isSecureContext 로 갈라서, 비보안 컨텍스트면 곧장 레거시
 *    execCommand('copy') 경로를 쓴다(localhost dev 는 secure 라 그대로 동작,
 *    HTTP 운영서버만 폴백). 보안 컨텍스트에서도 writeText 가 실패하면 레거시로
 *    한 번 더 폴백한다. 뷰 모드 표 복사(copyRenderedTableHtml)와 같은
 *    execCommand 우회 방식이라 HTTP 에서도 동작한다.
 *
 *  성공 시 resolve, 실패 시 reject — 호출부에서 toast 등으로 처리하면 된다.
 *  주의: execCommand 폴백은 사용자 제스처(클릭 핸들러) 안에서 호출해야 한다.
 */
export async function copyTextToClipboard(text) {
  const s = text == null ? '' : String(text)
  // 보안 컨텍스트(HTTPS·localhost)에서만 async API 를 신뢰. 실패하면 레거시로.
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(s)
      return
    } catch {
      /* 권한 거부 등 — 레거시 execCommand 로 폴백 */
    }
  }
  legacyCopy(s)
}

/** execCommand('copy') 기반 레거시 복사 — 평문 HTTP 등 비보안 컨텍스트용.
 *  화면 밖 textarea 를 선택해 복사하되, 기존 사용자 선택영역은 보존·복원한다. */
function legacyCopy(s) {
  // 사용자가 표/본문에서 잡아둔 선택영역을 망치지 않도록 미리 저장.
  const prevSel = document.getSelection()
  const prevRange =
    prevSel && prevSel.rangeCount > 0 ? prevSel.getRangeAt(0) : null
  const prevActive = document.activeElement

  // 화면 밖으로 빼되 포커스/선택은 가능하게 — display:none 이면 선택이 안 됨.
  const ta = document.createElement('textarea')
  ta.value = s
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  // iOS Safari 는 폰트 16px 미만이면 확대 점프가 나므로 명시.
  ta.style.fontSize = '16px'
  document.body.appendChild(ta)
  try {
    ta.focus()
    ta.select()
    // iOS 는 select() 가 안 먹어 setSelectionRange 가 필요.
    ta.setSelectionRange(0, s.length)
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('execCommand copy 실패')
  } finally {
    document.body.removeChild(ta)
    // 원래 선택영역·포커스 복원.
    if (prevRange) {
      const sel = document.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(prevRange)
    }
    if (prevActive && typeof prevActive.focus === 'function') {
      prevActive.focus()
    }
  }
}
