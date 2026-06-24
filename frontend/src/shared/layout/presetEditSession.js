// 프리셋 내용 편집 세션 — sessionStorage 단일 출처.
//
// ⚠ 예전엔 URL 쿼리(?presetEdit)에 의존했는데, 보고서 에디터가 저장/이동 시 URL 을
// 갈아끼우며 쿼리를 떨궈서 편집 바가 사라졌다("프리셋 저장"이 안 눌리던 원인).
// 세션을 sessionStorage 에 두고 "현재 보고서 경로 id == 세션의 임시 보고서 id" 일
// 때만 바를 띄우면 쿼리 변화와 무관하게 유지된다.
const SESSION_KEY = 'ra:presetEditSession'

export function startPresetEditSession({ reportId, presetId, presetName }) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ reportId, presetId, presetName: presetName || '' }),
  )
}

export function readPresetEditSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearPresetEditSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}
