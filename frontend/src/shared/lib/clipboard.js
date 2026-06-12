/** 클립보드 텍스트 복사 — HTTP(비보안 컨텍스트) 안전 버전.
 *
 *  navigator.clipboard 는 보안 컨텍스트(HTTPS·localhost)에서만 존재한다.
 *  운영서버를 평문 HTTP 로 접속하면 navigator.clipboard 자체가 undefined 라
 *  .writeText 접근에서 터진다. 그 경우 레거시 execCommand('copy') 로 폴백한다.
 *
 *  성공 시 resolve, 실패 시 reject — 호출부에서 toast 등으로 처리하면 된다.
 *  주의: execCommand 폴백은 사용자 제스처(클릭 핸들러) 안에서 호출해야 한다.
 */
export async function copyTextToClipboard(text) {
  const s = text == null ? '' : String(text)
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(s)
  }
  // 화면 밖으로 빼되 포커스/선택은 가능하게 — display:none 이면 선택이 안 됨.
  const ta = document.createElement('textarea')
  ta.value = s
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  ta.setAttribute('readonly', '')
  document.body.appendChild(ta)
  ta.select()
  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('execCommand copy 실패')
  } finally {
    document.body.removeChild(ta)
  }
}
